/**
 * 微信机器人 manager：协调 WeixinBotService（协议层）+ SessionPool（AI 后台会话）。
 *
 * 职责：
 *   1. start(humanId) 时创建后台 session（createBackgroundSession），并订阅它的
 *      agent_settled —— 把完整 AI 回复通过 service.sendReply 发回微信。
 *   2. service 收到微信消息时（onIncomingMessage），把文本 prompt 到后台 session。
 *   3. 把 service 的状态/二维码/消息事件转成 RpcEvent（writeEvent）发给前端。
 *
 * 不直接依赖 pi ExtensionAPI，全部走 SessionPool 的后台会话机制。
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ChannelReplyCollector } from "../channel-reply-collector.js";
import type { SessionPool } from "../session-pool.js";
import { writeEvent } from "../rpc-protocol.js";
import {
  WeixinBotService,
  setStateDir,
  resolveWeixinStateDir,
  type WeixinStatus,
  type WeixinIncomingMessage,
} from "./service.js";

/** 后台会话固定 conversationId（不进前端历史，仅作幂等键）。 */
const BG_CONVERSATION_ID = "nova-weixin-bg";

/**
 * 数字员工 @ 别名表。
 * 用户在微信发「@员工名 内容」触发切换；aliases 是该员工的常见叫法（全名 + 简称）。
 * 匹配时按别名最长降序，避免短别名（如「研判」）误吞长别名（如「威胁研判数字员工」）。
 */
const HUMAN_ALIASES: Array<{ humanId: string; displayName: string; aliases: string[] }> = [
  {
    humanId: "nova-computer-agent",
    displayName: "Nova 智能员工",
    aliases: ["Nova 智能员工", "Nova智能员工", "智能员工", "电脑助手"],
  },
  {
    humanId: "general-chat",
    displayName: "通用对话",
    aliases: ["通用对话", "通用", "默认"],
  },
  {
    humanId: "data-security-risk-assessment",
    displayName: "数安风评数字员工",
    aliases: ["数安风评数字员工", "数安风评", "风评", "数安"],
  },
  {
    humanId: "alert-analysis",
    displayName: "威胁研判数字员工",
    aliases: ["威胁研判数字员工", "威胁研判", "研判", "告警"],
  },
];

/** 按最长别名降序预排序，匹配时按此顺序遍历。 */
const HUMAN_ALIASES_SORTED = [...HUMAN_ALIASES].sort((a, b) => {
  const aMax = Math.max(...a.aliases.map((s) => s.length));
  const bMax = Math.max(...b.aliases.map((s) => s.length));
  return bMax - aMax;
});

export class WeixinBotManager {
  private service: WeixinBotService;
  private pool: SessionPool;
  private bgSessionId: string | null = null;
  /** 当前后台会话绑定的员工 id（switchHuman 切换时更新）。 */
  private currentHumanId: string | null = null;
  private unsubscribeBackground: (() => void) | null = null;
  /**
   * 当前渠道请求的完整回复聚合器。
   *
   * 之前用单例 currentIncoming 既存 reqId 又存 fromUserId/contextToken，连续两条
   * 消息时若上一条 message_end 延迟到达，会读到当前条的上下文，把回复发错对象。
   *
   * 现在的职责拆分：
   *   - 回复路由（fromUserId/contextToken）完全由 service.replyToMap 维护
   *     （service 入队时 set、advanceQueue 时 delete），manager 不再重复持有。
   *   - manager 在 agent_settled 前持续接收多轮 assistant 消息，只发送最后一条结果。
   */
  private readonly replyCollector = new ChannelReplyCollector();

  constructor(pool: SessionPool, agentDir: string) {
    this.pool = pool;
    // 注入状态目录：agentDir/weixin（与上游 ~/.pi/agent/weixin 语义一致但隔离在 Nova 数据目录）
    setStateDir(resolveWeixinStateDir(agentDir));

    this.service = new WeixinBotService({
      onIncomingMessage: (msg) => this.handleIncoming(msg),
      onQrCode: (qrUrl) => {
        writeEvent({ type: "wechat_qrcode", qrUrl });
      },
      onStatus: (status) => {
        this.emitStatus(status);
      },
    });
  }

  /** 启动：创建后台会话 + 订阅事件。不自动登录（登录由 weixin_login 触发）。 */
  async start(humanId: string): Promise<void> {
    if (this.bgSessionId && this.pool.hasSession(this.bgSessionId)) return;
    this.currentHumanId = humanId;
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
    // 推一次初始状态给前端
    this.emitStatus(this.service.getStatus());
  }

  /**
   * 切换后台会话的数字员工（微信 @ 切换、前端面板手动切换都走这里）。
   *
   * pi session 的 systemPrompt 在创建时灌入，无法热替换，必须 dispose + 重建。
   * 但**不重启 service**：微信连接、token 缓存、消息监听全保留；只换 AI 后端。
   * pool 的 backgroundListeners 是 pool 级广播，新 session 事件自动流入同一 listener，
   * handleBackgroundEvent 内部按 this.bgSessionId 过滤，旧 session 残留事件被挡掉。
   */
  async switchHuman(humanId: string): Promise<boolean> {
    if (humanId === this.currentHumanId) return true;
    // 切换前若有消息在等 AI 回复，先推进队列避免孤儿 prompt（旧 session 即将 dispose）
    const activeReqId = this.replyCollector.currentReqId();
    if (activeReqId) {
      this.service.failCurrent(activeReqId, "切换员工中");
      this.replyCollector.reset();
    }
    const oldId = this.bgSessionId;
    if (oldId) {
      await this.pool.dispose(oldId).catch(() => {});
    }
    this.bgSessionId = await this.pool.createBackgroundSession({
      humanId,
      conversationId: BG_CONVERSATION_ID,
    });
    this.currentHumanId = humanId;
    return true;
  }

  /** 停止：断开微信连接 + 销毁后台会话。 */
  async stop(): Promise<void> {
    // 先停事件订阅 + 销毁后台 session，再停 service：避免 service 还在 emit 微信消息时，
    // manager 去对一个即将 dispose 的 session 发 prompt（race window）。
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
    this.replyCollector.reset();
    await this.service.stop();
  }

  /** 触发扫码登录（或从缓存恢复）。 */
  async login(): Promise<boolean> {
    if (!this.bgSessionId) {
      throw new Error("微信机器人未启动，请先点击「启动」。");
    }
    return this.service.login();
  }

  /** 查询当前状态。 */
  getStatus(): WeixinStatus {
    return this.service.getStatus();
  }

  // ── 内部 ──

  /** 收到微信消息：解析 @ 切换 → 记录 → 推前端 → prompt 后台 session。 */
  private async handleIncoming(originalMsg: WeixinIncomingMessage): Promise<void> {
    let msg = originalMsg;

    // 1. 解析 @员工名 切换（@ 必须在消息开头）
    const { switchedTo, remainingText } = this.parseMention(msg.text);
    if (switchedTo) {
      const switched = await this.switchHuman(switchedTo.humanId).catch((err) => {
        console.error("[weixinbot-manager] switchHuman 失败：", err);
        return false;
      });
      if (switched) {
        // @ 后无内容 → 回复确认，不发 AI
        if (!remainingText.trim()) {
          try {
            await this.service.sendDirect(
              msg.fromUserId,
              `✅ 已切换到「${switchedTo.displayName}」，请继续输入问题。`,
              msg.contextToken,
            );
          } catch (err) {
            console.error("[weixinbot-manager] 发送切换确认失败：", err);
          }
          // 推前端一条系统记录（让用户在面板看到这条 @ 消息）
          writeEvent({
            type: "wechat_message",
            role: "incoming",
            reqId: msg.reqId,
            text: msg.text,
            fromUser: msg.fromUserId,
          });
          this.service.failCurrent(msg.reqId, "@ 切换确认");
          return;
        }
        // @ 后有内容 → 用去掉 @ 的文本继续走 AI
        msg = { ...msg, text: remainingText };
      }
      // switchedTo 解析到但切换失败：原样发给当前员工（fallback）
    }

    // 2. 正常流程
    this.replyCollector.begin(msg.reqId);
    writeEvent({
      type: "wechat_message",
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
      this.replyCollector.reset();
      this.service.failCurrent(msg.reqId, `数字员工不可用：${reason}`);
      return;
    }
    if (!sessionId) {
      // session 已停止：让队列推进，否则这条消息会永久卡住。
      this.replyCollector.reset();
      this.service.failCurrent(msg.reqId, "后台会话已停止");
      return;
    }
    try {
      await this.pool.prompt({ sessionId, message: msg.text });
    } catch (error) {
      // prompt 失败（模型 5xx、API key 失效、session 已 dispose 等）：
      // 必须通知 service 推进队列，否则 isProcessing 永不复位，整条管线死锁。
      const reason = error instanceof Error ? error.message : String(error);
      console.error("[weixinbot-manager] prompt 后台会话失败：", reason);
      this.replyCollector.reset();
      this.service.failCurrent(msg.reqId, `AI 处理失败：${reason}`);
    }
  }

  /**
   * 解析消息开头的 @员工名。
   * - @ 必须在开头（^@），避免消息中段误触发
   * - 名字部分与 HUMAN_ALIASES 匹配：精确或前缀匹配（边界匹配），
   *   按"别名长度降序"遍历避免短别名（如「研判」）误吞长别名（如「威胁研判」）。
   * - M3 修复：之前用 namePart.includes(a) 是子串包含，会把 `@数安科技` 误匹配到「数安」。
   *   改为 namePart===a || namePart.startsWith(a)，要求名字在别名处断开。
   * - @ 名字不匹配 → 返回原文不剥离（让 AI 自然回应，用户能感知没切成功）
   * 返回 { switchedTo?, remainingText }；switchedTo 为空表示无匹配 @。
   */
  private parseMention(text: string): {
    switchedTo?: { humanId: string; displayName: string };
    remainingText: string;
  } {
    // ^@ + 可选空白 + 非空白名字 + 可选空白 + 剩余内容
    const match = text.match(/^@\s*([^\s@]+)\s*([\s\S]*)$/);
    if (!match) return { remainingText: text };
    const namePart = match[1];
    for (const entry of HUMAN_ALIASES_SORTED) {
      // 边界匹配：名字要么等于别名，要么以别名开头（前缀）。
      // 前缀匹配覆盖「@数安风评你好」这类粘连写法；startsWith 比 includes 严格。
      if (entry.aliases.some((a) => namePart === a || namePart.startsWith(a))) {
        return {
          switchedTo: { humanId: entry.humanId, displayName: entry.displayName },
          remainingText: match[2],
        };
      }
    }
    return { remainingText: text };
  }

  /** 后台会话事件：聚合多轮 AI 输出，仅在 agent_settled 后发回微信 + 推前端。 */
  private handleBackgroundEvent(event: AgentSessionEvent): void {
    const completion = this.replyCollector.accept(event);
    if (!completion) return;
    if (!completion.text.trim()) {
      this.service.failCurrent(completion.reqId, "AI 返回空回复");
      return;
    }
    writeEvent({
      type: "wechat_message",
      role: "assistant",
      reqId: completion.reqId,
      text: completion.text,
    });
    // 发回微信 + 推进队列（service 内部会 shift 当前消息）
    void this.service.sendReply(completion.reqId, completion.text).catch((err) => {
      console.error("[weixinbot-manager] sendReply 失败：", err);
    });
  }

  private emitStatus(status: WeixinStatus): void {
    switch (status.kind) {
      case "offline":
        writeEvent({ type: "wechat_status", status: "offline" });
        break;
      case "awaiting_scan":
        writeEvent({ type: "wechat_status", status: "awaiting_scan", detail: status.detail });
        break;
      case "online":
        writeEvent({
          type: "wechat_status",
          status: "online",
          account: status.accountId,
          accountName: status.accountName,
        });
        break;
      case "error":
        writeEvent({ type: "wechat_status", status: "error", detail: status.detail });
        break;
    }
  }
}
