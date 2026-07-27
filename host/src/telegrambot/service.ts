/**
 * Telegram Bot service。
 *
 * 参考 pi-telegram (https://github.com/badlogic/pi-telegram) 的设计：
 *   - 出站 HTTPS 长轮询（getUpdates），无需公网回调
 *   - 首个 DM /start 用户锁定为 allowedUserId（安全：bot token 泄露后只有该用户能用）
 *   - 收到消息 → onIncomingMessage 回调（host 转给后台 session）
 *   - host 拿到 AI 回复 → 调 sendReply 发回 Telegram
 *
 * 状态机：offline → (login) → connected；config 不含 allowedUserId 时为 awaiting_pair。
 * 与微信的差异：无扫码、无 token 缓存文件、/start 配对。
 */

import { getMe, getUpdates, sendMessage } from "./api.js";
import type { TelegramUpdate, TelegramConfig } from "./types.js";

// ============================================================================
// 类型
// ============================================================================

export type TelegramStatus =
  | { kind: "offline" }
  | { kind: "awaiting_pair"; detail?: string } // token 已配置，等首个 /start 配对
  | { kind: "online"; botUsername: string; allowedUserId: string }
  | { kind: "error"; detail: string };

export interface TelegramIncomingMessage {
  reqId: string;
  chatId: number;
  fromUserId: string;
  text: string;
  messageId: number;
}

export interface TelegramServiceCallbacks {
  /** 收到新消息（host 应把它发到后台 session）。 */
  onIncomingMessage?: (msg: TelegramIncomingMessage) => void;
  /** 配置更新（如 /start 配对后 allowedUserId 写回）。 */
  onConfigUpdate?: (config: TelegramConfig) => void;
  /** 状态变化（前端面板据此切换 UI）。 */
  onStatus?: (status: TelegramStatus) => void;
}

// ============================================================================
// 工具
// ============================================================================

function generateReqId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `nova-tg-${timestamp}-${random}`;
}

/** watchdog 超时：单条消息等 AI 回复的最大时长。 */
const WATCHDOG_TIMEOUT_MS = 60_000;

// ============================================================================
// Service
// ============================================================================

export class TelegramBotService {
  private readonly callbacks: TelegramServiceCallbacks;
  /** 运行时配置（botToken + allowedUserId，allowedUserId 会因 /start 动态更新）。 */
  private config: TelegramConfig;

  private botUsername: string | null = null;
  private isPolling = false;
  private pollAbortController: AbortController | null = null;
  /** 上次处理的 update_id + 1（getUpdates offset，确认消费）。 */
  private lastUpdateOffset: number | undefined;
  private consecutiveErrors = 0;
  /** 最近一次错误（start 失败、轮询持续异常等）。getStatus 在非 polling 时据此返回 error 态。 */
  private lastError: string | null = null;
  /** 连续空响应计数（getUpdates 立即返回空时退避，避免 100ms 高频打爆服务器）。 */
  private consecutiveEmptyPolls = 0;

  /** 待回复队列（FIFO）：与微信一致的串行处理。 */
  private readonly pendingMessages: TelegramIncomingMessage[] = [];
  private isProcessing = false;
  private readonly replyToMap = new Map<string, { chatId: number; messageId: number }>();
  private currentReqId: string | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(initialConfig: TelegramConfig, callbacks: TelegramServiceCallbacks = {}) {
    this.config = initialConfig;
    this.callbacks = callbacks;
  }

  // ── 配置 / 状态 ──

  getConfig(): TelegramConfig {
    return { ...this.config };
  }

  /** 更新配置（用户在面板改了 botToken 时调用）。 */
  updateConfig(patch: Partial<TelegramConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  getStatus(): TelegramStatus {
    if (this.isPolling) {
      if (this.config.allowedUserId && this.botUsername) {
        return {
          kind: "online",
          botUsername: this.botUsername,
          allowedUserId: this.config.allowedUserId,
        };
      }
      return { kind: "awaiting_pair" };
    }
    // 非 polling：有错误优先返回 error，否则 offline。
    // 此前直接返回 offline 会让前端 getTelegramBotStatus 拿不到 error 态（M1）。
    if (this.lastError) {
      return { kind: "error", detail: this.lastError };
    }
    return { kind: "offline" };
  }

  /**
   * 解除配对：清空 allowedUserId 并重发状态。
   * - 若当前在 polling，清空后状态变为 awaiting_pair，下个 /start 可重新锁定。
   * - 若未 polling，仅清空 config 字段（下次 start 生效）。
   * 返回清空后的 config，供 host 写回 SQLite。
   */
  resetPairing(): TelegramConfig {
    this.config = { ...this.config, allowedUserId: undefined };
    if (this.isPolling) {
      this.emitStatus(this.getStatus());
    }
    return this.getConfig();
  }

  getCurrentPending(): TelegramIncomingMessage | null {
    if (!this.currentReqId) return null;
    return this.pendingMessages.find((m) => m.reqId === this.currentReqId) ?? null;
  }

  /** 让当前消息以失败告终，推进队列（host 在 prompt 失败/超时/切换时调用）。 */
  failCurrent(reqId: string, reason?: string): void {
    if (reason) console.warn(`[telegram] 消息 ${reqId.slice(0, 12)}... 失败：${reason}`);
    this.advanceQueue(reqId);
  }

  // ── 生命周期 ──

  /**
   * 启动：验证 token（getMe）+ 开始长轮询。
   * token 无效直接抛错；有效但无 allowedUserId 进入 awaiting_pair 状态。
   */
  async start(): Promise<boolean> {
    if (this.isPolling) return true;
    if (!this.config.botToken) {
      this.lastError = "未配置 bot token";
      this.emitStatus({ kind: "error", detail: this.lastError });
      return false;
    }
    try {
      const me = await getMe(this.config.botToken);
      this.botUsername = me.username;
      this.isPolling = true;
      this.consecutiveErrors = 0;
      this.consecutiveEmptyPolls = 0;
      this.lastError = null;
      this.startPolling();
      this.emitStatus(this.getStatus());
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.lastError = `bot token 无效：${detail}`;
      this.emitStatus({ kind: "error", detail: this.lastError });
      return false;
    }
  }

  /** 停止长轮询（不丢配置，下次 start 复用 token + allowedUserId）。 */
  stop(): void {
    this.isPolling = false;
    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }
    this.disarmWatchdog();
    this.pendingMessages.length = 0;
    this.replyToMap.clear();
    this.currentReqId = null;
    this.isProcessing = false;
    this.botUsername = null;
    // 注意：不清 lastError。stop 后 getStatus 仍可能返回 error 态，
    // 让前端面板显示"异常"而非"未连接"（用户更易感知失败原因）。下次 start 成功才清。
    this.emitStatus({ kind: "offline" });
  }

  // ── 回复 ──

  /** 把 AI 回复发回 Telegram，并推进队列。 */
  async sendReply(reqId: string, text: string): Promise<void> {
    const target = this.replyToMap.get(reqId);
    if (!target) {
      this.advanceQueue(reqId);
      return;
    }
    const trimmed = text.trim();
    if (!trimmed || !this.config.botToken) {
      this.advanceQueue(reqId);
      return;
    }
    try {
      await sendMessage(this.config.botToken, {
        chat_id: target.chatId,
        text: trimmed,
        reply_to_message_id: target.messageId,
      });
    } catch (err) {
      console.error(`[telegram] 回复发送失败：`, err);
    }
    this.advanceQueue(reqId);
  }

  /** 主动给指定 chat 发消息（@ 切换确认、系统通知等场景）。 */
  async sendDirect(chatId: number, text: string): Promise<void> {
    if (!this.config.botToken) throw new Error("未配置 bot token");
    await sendMessage(this.config.botToken, { chat_id: chatId, text });
  }

  // ── 内部：长轮询 ──

  private startPolling(): void {
    if (this.pollAbortController) this.pollAbortController.abort();
    this.pollAbortController = new AbortController();
    const signal = this.pollAbortController.signal;

    const poll = async () => {
      if (!this.isPolling || signal.aborted) return;
      try {
        const updates = await getUpdates(
          this.config.botToken,
          { offset: this.lastUpdateOffset, timeout: 30 },
          signal,
        );
        this.consecutiveErrors = 0;
        // 连续空响应退避（M6）：长轮询 timeout=30s 正常应阻塞，若服务端立即返回空
        // （webhook 模式误开 / 服务端异常），避免退化为 100ms 高频轮询触发 429。
        if (updates.length === 0) {
          this.consecutiveEmptyPolls++;
        } else {
          this.consecutiveEmptyPolls = 0;
          for (const update of updates) {
            // 更新 offset（确认消费）
            this.lastUpdateOffset = update.update_id + 1;
            this.handleUpdate(update);
          }
        }
      } catch (err) {
        if (!this.isPolling || signal.aborted) return;
        // abort 信号触发的 AbortError 是正常停止
        if (err instanceof Error && err.name === "AbortError") return;
        this.consecutiveErrors++;
        console.error(`[telegram] getUpdates 异常（连续第 ${this.consecutiveErrors} 次）：`, err);
        // 指数退避（与微信一致），避免打爆 Telegram 服务器
        const backoff = Math.min(30_000, 1000 * 2 ** Math.min(this.consecutiveErrors - 1, 6));
        if (this.consecutiveErrors === 1) {
          this.lastError = "Telegram 接口暂不可用，正在重试...";
          this.emitStatus({ kind: "error", detail: this.lastError });
        }
        if (!signal.aborted) setTimeout(poll, backoff);
        return;
      }
      // 计算下一次轮询间隔：连续空响应时退避（最多 5s），否则快速重轮（100ms）。
      // 正常长轮询下 updates.length===0 是因为 timeout 到期（30s），consecutiveEmptyPolls
      // 不会累积；只有"立即返回空"才会累积，此时退避。
      const nextDelay = this.consecutiveEmptyPolls > 3
        ? Math.min(5000, 1000 * 2 ** Math.min(this.consecutiveEmptyPolls - 3, 4))
        : 100;
      if (!signal.aborted) setTimeout(poll, nextDelay);
    };
    poll();
  }

  /** 处理单个 update（消息分发 + /start 配对）。 */
  private handleUpdate(update: TelegramUpdate): void {
    const msg = update.message ?? update.edited_message;
    if (!msg || !msg.from || !msg.text) return;
    // 忽略 bot 自己发的消息
    if (msg.from.is_bot) return;

    const fromUserId = String(msg.from.id);
    const text = msg.text.trim();

    // /start 命令：配对（首个用户锁定）
    if (text === "/start" || text.startsWith("/start ")) {
      this.handleStart(msg, fromUserId);
      return;
    }

    // 已配对后只接受 allowedUserId 的消息
    if (!this.config.allowedUserId) {
      // 未配对，非 /start 消息忽略（提示用户先 /start）
      void this.sendDirect(msg.chat.id, "请先发送 /start 完成配对。").catch(() => {});
      return;
    }
    if (fromUserId !== this.config.allowedUserId) {
      // 非允许用户，静默忽略（不泄露 bot 状态）
      return;
    }

    // 入队
    const incoming: TelegramIncomingMessage = {
      reqId: generateReqId(),
      chatId: msg.chat.id,
      fromUserId,
      text,
      messageId: msg.message_id,
    };
    this.pendingMessages.push(incoming);
    this.processQueue();
  }

  /** /start 配对逻辑：首个用户锁定为 allowedUserId。 */
  private handleStart(msg: NonNullable<TelegramUpdate["message"]>, fromUserId: string): void {
    if (this.config.allowedUserId && fromUserId !== this.config.allowedUserId) {
      // 已配对，且不是配对用户：拒绝
      void this.sendDirect(
        msg.chat.id,
        "该机器人已绑定其他用户，无法配对。",
      ).catch(() => {});
      return;
    }
    if (!this.config.allowedUserId) {
      // 首次配对：锁定 fromUserId
      this.config.allowedUserId = fromUserId;
      this.lastError = null; // 配对成功，清掉历史错误态
      // 通知 host 写回 config（持久化到 message_channels.config_json）
      this.callbacks.onConfigUpdate?.(this.getConfig());
      console.log(`[telegram] 配对成功，锁定用户 ${fromUserId}`);
    }
    void this.sendDirect(
      msg.chat.id,
      `✅ 已配对成功。现在你可以直接发消息，我会转给数字员工处理。`,
    ).catch(() => {});
    this.emitStatus(this.getStatus());
  }

  /** 按 FIFO 取一条消息，通知 host 把它发给后台 session。 */
  private processQueue(): void {
    if (this.isProcessing || this.pendingMessages.length === 0) return;
    const message = this.pendingMessages[0];
    if (!message) return;
    this.isProcessing = true;
    this.currentReqId = message.reqId;
    this.replyToMap.set(message.reqId, {
      chatId: message.chatId,
      messageId: message.messageId,
    });
    this.armWatchdog(message.reqId);
    try {
      this.callbacks.onIncomingMessage?.(message);
    } catch (err) {
      console.error(`[telegram] onIncomingMessage 回调抛错：`, err);
      this.advanceQueue(message.reqId);
    }
  }

  /** 一条消息处理完，清理并取下一条。 */
  private advanceQueue(reqId: string): void {
    const idx = this.pendingMessages.findIndex((m) => m.reqId === reqId);
    if (idx >= 0) this.pendingMessages.splice(idx, 1);
    this.replyToMap.delete(reqId);
    if (this.currentReqId === reqId) this.currentReqId = null;
    this.isProcessing = false;
    this.disarmWatchdog();
    this.processQueue();
  }

  private armWatchdog(reqId: string): void {
    this.disarmWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.currentReqId === reqId && this.isProcessing) {
        console.warn(`[telegram] watchdog 超时，强制推进队列（reqId=${reqId.slice(0, 12)}...）`);
        this.advanceQueue(reqId);
      }
    }, WATCHDOG_TIMEOUT_MS);
  }

  private disarmWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private emitStatus(status: TelegramStatus): void {
    try {
      this.callbacks.onStatus?.(status);
    } catch (err) {
      console.error(`[telegram] onStatus 回调抛错：`, err);
    }
  }
}
