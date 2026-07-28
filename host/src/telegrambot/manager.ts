/**
 * Telegram Bot manager：协调 TelegramBotService（协议层）+ SessionPool（AI 后台会话）。
 *
 * 仿 WeixinBotManager 结构，关键差异：
 *   - 独立 bgSessionId（nova-telegram-bg），与微信后台会话互不干扰
 *   - 状态事件用 telegram_status / telegram_message（前端按 channelId 区分）
 *   - 无扫码流程，无 @ 切换（首版保持简单，后续可加）
 *   - /start 配对后通过 onConfigUpdate 回调让 host 写回 config_json
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionPool } from "../session-pool.js";
import { writeEvent } from "../rpc-protocol.js";
import {
  TelegramBotService,
  type TelegramStatus,
  type TelegramIncomingMessage,
} from "./service.js";
import type { TelegramConfig } from "./types.js";

/** 后台会话固定 conversationId（不进前端历史，仅作幂等键）。 */
const BG_CONVERSATION_ID = "nova-telegram-bg";

export class TelegramBotManager {
  private pool: SessionPool;
  private service: TelegramBotService;
  private bgSessionId: string | null = null;
  private currentHumanId: string | null = null;
  private unsubscribeBackground: (() => void) | null = null;
  /**
   * 当前流式累积所属的 reqId（H3 修复，与微信 manager 对称）。
   * 回复路由（chatId/messageId）由 service.replyToMap 维护，manager 不重复持有。
   */
  private streamingReqId: string | null = null;
  private streamingText = "";

  constructor(
    pool: SessionPool,
    initialConfig: TelegramConfig,
    /** 配置写回回调（/start 配对后持久化 allowedUserId 到 SQLite）。 */
    onConfigUpdate?: (config: TelegramConfig) => void,
  ) {
    this.pool = pool;
    this.service = new TelegramBotService(initialConfig, {
      onIncomingMessage: (msg) => {
        void this.handleIncoming(msg);
      },
      onConfigUpdate: (config) => {
        onConfigUpdate?.(config);
      },
      onStatus: (status) => {
        this.emitStatus(status);
      },
    });
  }

  /** 启动：创建后台会话 + 订阅事件 + 启动 service（验证 token + 长轮询）。 */
  async start(humanId: string, config: TelegramConfig): Promise<boolean> {
    // 配置可能被用户更新（botToken 变了），同步到 service
    this.service.updateConfig(config);
    this.currentHumanId = humanId;
    if (!this.bgSessionId || !this.pool.hasSession(this.bgSessionId)) {
      this.bgSessionId = await this.pool.createBackgroundSession({
        humanId,
        conversationId: BG_CONVERSATION_ID,
      });
      if (!this.unsubscribeBackground) {
        this.unsubscribeBackground = this.pool.subscribeBackgroundEvents((sessionId, event) => {
          if (sessionId !== this.bgSessionId) return;
          this.handleBackgroundEvent(event);
        });
      }
    }
    return this.service.start();
  }

  /** 停止：销毁后台会话 + 停 service（保留 token + allowedUserId）。 */
  async stop(): Promise<void> {
    if (this.unsubscribeBackground) {
      this.unsubscribeBackground();
      this.unsubscribeBackground = null;
    }
    const bgSessionId = this.bgSessionId;
    this.bgSessionId = null;
    this.currentHumanId = null;
    if (bgSessionId) {
      await this.pool.dispose(bgSessionId).catch(() => {});
    }
    this.clearStreaming();
    this.service.stop();
  }

  /** 清空流式累积状态（多处复用）。 */
  private clearStreaming(): void {
    this.streamingReqId = null;
    this.streamingText = "";
  }

  /** 更新配置（用户在面板改了 botToken 时调用，需重启 service 生效）。 */
  updateConfig(config: TelegramConfig): void {
    this.service.updateConfig(config);
  }

  /** 查询当前状态。 */
  getStatus(): TelegramStatus {
    return this.service.getStatus();
  }

  /** 当前 service 配置（host 写回 SQLite 用）。 */
  getServiceConfig(): TelegramConfig {
    return this.service.getConfig();
  }

  /**
   * 解除配对：清空 allowedUserId，回到 awaiting_pair 状态。
   * 供前端"解除配对"按钮调用。service 内部清 config.allowedUserId 并重发状态；
   * host 同时把清空后的 config 写回 SQLite（onConfigUpdate 回调）。
   * 返回清空后的 config（前端据此持久化）。
   */
  resetPairing(): TelegramConfig {
    const config = this.service.resetPairing();
    // 通知 host 写回（与 /start 配对时对称）
    return config;
  }

  // ── 内部 ──

  /** 收到 Telegram 消息：记录 + 推前端 + prompt 后台 session。 */
  private async handleIncoming(msg: TelegramIncomingMessage): Promise<void> {
    this.streamingReqId = msg.reqId;
    this.streamingText = "";
    writeEvent({
      type: "telegram_message",
      role: "incoming",
      reqId: msg.reqId,
      text: msg.text,
      fromUser: msg.fromUserId,
    });
    let sessionId = this.bgSessionId;
    try {
      if ((!sessionId || !this.pool.hasSession(sessionId)) && this.currentHumanId) {
        sessionId = await this.pool.createBackgroundSession({
          humanId: this.currentHumanId,
          conversationId: BG_CONVERSATION_ID,
        });
        this.bgSessionId = sessionId;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.clearStreaming();
      this.service.failCurrent(msg.reqId, `数字员工不可用：${reason}`);
      return;
    }
    if (!sessionId) {
      this.clearStreaming();
      this.service.failCurrent(msg.reqId, "后台会话已停止");
      return;
    }
    try {
      await this.pool.prompt({ sessionId, message: msg.text });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error("[telegram-manager] prompt 后台会话失败：", reason);
      this.clearStreaming();
      this.service.failCurrent(msg.reqId, `AI 处理失败：${reason}`);
    }
  }

  /** 后台会话事件：累积 AI 回复文本，message_end 时发回 Telegram + 推前端。 */
  private handleBackgroundEvent(event: AgentSessionEvent): void {
    if (event.type === "message_update") {
      const sub = event.assistantMessageEvent;
      if (sub.type === "text_delta" && sub.delta && this.streamingReqId) {
        this.streamingText += sub.delta;
      } else if (sub.type === "text_end" && sub.content) {
        if (this.streamingReqId && !this.streamingText) this.streamingText = sub.content;
      }
      return;
    }
    if (event.type === "message_end") {
      const msg = event.message;
      if (msg?.role !== "assistant") return;
      // 以 final message 为准；host 会在这里替换伪工具调用，避免把无效 XML 发到渠道。
      let finalText = "";
      const content = msg.content;
      if (typeof content === "string") finalText = content;
      if (Array.isArray(content)) {
        finalText = content
          .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("");
      }
      const replyText = finalText || this.streamingText;
      // reqId 解析（H3）：优先用 manager 的 streamingReqId，回退到 service 的 currentReqId。
      // 回复路由（chatId/messageId）由 service.replyToMap 维护。
      const pending = this.service.getCurrentPending();
      const reqId = this.streamingReqId ?? pending?.reqId;
      this.clearStreaming();
      if (!reqId) return;
      if (!replyText.trim()) {
        this.service.failCurrent(reqId, "AI 返回空回复");
        return;
      }
      writeEvent({
        type: "telegram_message",
        role: "assistant",
        reqId,
        text: replyText,
      });
      void this.service.sendReply(reqId, replyText).catch((err) => {
        console.error("[telegram-manager] sendReply 失败：", err);
      });
    }
  }

  private emitStatus(status: TelegramStatus): void {
    switch (status.kind) {
      case "offline":
        writeEvent({ type: "telegram_status", status: "offline" });
        break;
      case "awaiting_pair":
        writeEvent({ type: "telegram_status", status: "awaiting_pair", detail: status.detail });
        break;
      case "online":
        writeEvent({
          type: "telegram_status",
          status: "online",
          botUsername: status.botUsername,
          allowedUserId: status.allowedUserId,
        });
        break;
      case "error":
        writeEvent({ type: "telegram_status", status: "error", detail: status.detail });
        break;
    }
  }
}
