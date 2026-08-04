/**
 * Nova 微信机器人 service。
 *
 * 基于 pi-weixinbot (https://github.com/huang-x-h/pi-weixinbot) 改造，MIT License。
 * 上游是 pi extension（依赖 pi.sendUserMessage / pi.on("message_end") 注入当前会话）；
 * Nova 多会话架构下不再适用，改为：
 *   - 收到微信消息 → 通过 onIncomingMessage 回调通知 host（host 转给独立后台 session）
 *   - host 拿到后台 session 的 AI 回复 → 调 sendReply() 发回微信
 *   - 登录/状态变化 → 通过 onStatus 回调通知 host（host emit 给前端面板）
 *   - 二维码就绪 → 通过 onQrCode 回调通知 host
 *
 * 不再依赖 pi ExtensionAPI，纯协议层 + 回调驱动，便于 host 直接调用。
 */

import { join } from "node:path";
import {
  getUpdates,
  sendMessage as sendWeixinMessage,
  sendFileMessage,
  DEFAULT_BASE_URL,
  CDN_BASE_URL,
} from "./weixin-api.js";
import { uploadMediaToCdn } from "./cdn-upload.js";
import { MessageItemType, MessageType, UploadMediaType } from "./types.js";
import type { WeixinMessage, WeixinAccountData } from "./types.js";
import {
  fullQRLogin,
  getLoggedInAccounts,
  logoutAccount,
} from "./weixin-auth.js";
import { toQrCodeDataUri } from "./qrcode.js";
import {
  acquireLock,
  releaseLock,
  forceReleaseLock,
} from "./lock-manager.js";

// ============================================================================
// 类型
// ============================================================================

export type WeixinStatus =
  | { kind: "offline" }
  | { kind: "awaiting_scan"; detail?: string }
  | { kind: "online"; accountId: string; accountName?: string }
  | { kind: "error"; detail: string };

export interface WeixinIncomingMessage {
  /** 微信侧生成的请求 ID（用于关联回复）。 */
  reqId: string;
  /** 发送者微信用户 ID。 */
  fromUserId: string;
  /** 提取后的文本（含媒体占位）。 */
  text: string;
  /** 微信会话上下文 token（回复时回传，保持上下文连贯）。 */
  contextToken?: string;
  /** 收信账号 ID。 */
  accountId: string;
}

export interface WeixinServiceCallbacks {
  /** 收到新消息（host 应把它发到后台 session）。 */
  onIncomingMessage?: (msg: WeixinIncomingMessage) => void;
  /** 二维码就绪（qrUrl 是图片地址，前端 <img> 直接展示）。 */
  onQrCode?: (qrUrl: string) => void;
  /** 状态变化（前端面板据此切换 UI）。 */
  onStatus?: (status: WeixinStatus) => void;
}

// ============================================================================
// 工具函数（vendor 自 weixin.ts）
// ============================================================================

function generateClientId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `nova-weixin-${timestamp}-${random}`;
}

/** watchdog 超时：单条消息等 AI 回复的最大时长，超时强制推进队列避免死锁。 */
const WATCHDOG_TIMEOUT_MS = 60_000;

function getSessionId(): string {
  // Nova 后台 service 固定一个 sessionId 标识排他锁归属，避免每次启动随机。
  // 多实例由 lock-manager 保证只有一个能连接。
  if (process.env.NOVA_PI_INSTANCE_ID) return process.env.NOVA_PI_INSTANCE_ID;
  return "nova-weixin-bg";
}

/** 从消息 item_list 提取文本（含引用、语音转文字、媒体占位）。vendor 自 weixin.ts。 */
function extractTextBody(itemList?: WeixinMessage["item_list"]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    // 文本消息（L5：用命名常量替代魔法数字）
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      let text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (ref?.message_item) {
        const refType = ref.message_item.type;
        if (refType === MessageItemType.TEXT && ref.message_item.text_item?.text) {
          text = `[引用: ${ref.message_item.text_item.text}]\n${text}`;
        }
      }
      return text;
    }
    // 语音转文字
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

/** 过滤 Markdown 干扰字符（微信显示用）。vendor 自 weixin.ts。 */
function filterMarkdown(text: string): string {
  // M5 修复：先按 ``` 围栏切分，只对"非代码块"段做 Markdown 剥离，
  // 代码块内（可能含正则/密码示例中的 * ` 等）原样保留，仅去掉围栏本身。
  // 围栏成对出现；不成对时（未闭合代码块）按整段处理。
  const segments = text.split(/(```[\s\S]*?```)/g);
  return segments
    .map((seg) => {
      if (seg.startsWith("```") && seg.endsWith("```")) {
        // 代码块：去围栏标记 + 头部语言名，保留内容
        return seg.replace(/^```\w*\n?/, "").replace(/```$/, "");
      }
      // 普通文本段：剥离常见 Markdown 语法
      return seg
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/`(.*?)`/g, "$1")
        .replace(/\[(.*?)\]\(.*?\)/g, "$1")
        .replace(/^#+\s*/gm, "")
        .replace(/^[-*]\s+/gm, "• ")
        .replace(/^\d+\.\s+/gm, "");
    })
    .join("");
}

// ============================================================================
// Service
// ============================================================================

export class WeixinBotService {
  private readonly callbacks: WeixinServiceCallbacks;
  private readonly SESSION_ID = getSessionId();

  private currentAccount: (WeixinAccountData & { accountId: string }) | null = null;
  private isConnected = false;
  private monitorAbortController: AbortController | null = null;
  private loginInProgress = false;

  /** 待回复队列（FIFO）：一条处理完才取下一条，避免乱序。 */
  private readonly pendingMessages: WeixinIncomingMessage[] = [];
  private isProcessing = false;
  /** reqId → { userId, contextToken }，AI 回复时按 reqId 找到接收者。 */
  private readonly replyToMap = new Map<string, { userId: string; contextToken?: string }>();
  /** 当前正在等待 AI 回复的 reqId（service 回复后通知 host 推进队列）。 */
  private currentReqId: string | null = null;

  constructor(callbacks: WeixinServiceCallbacks = {}) {
    this.callbacks = callbacks;
  }

  // ── 状态查询 ──

  getStatus(): WeixinStatus {
    if (this.isConnected && this.currentAccount) {
      return {
        kind: "online",
        accountId: this.currentAccount.accountId,
        accountName: this.currentAccount.name,
      };
    }
    if (this.loginInProgress) {
      return { kind: "awaiting_scan" };
    }
    return { kind: "offline" };
  }

  /** 当前等待 AI 回复的消息（host 在后台 session message_end 时据此回复微信）。 */
  getCurrentPending(): WeixinIncomingMessage | null {
    if (!this.currentReqId) return null;
    return this.pendingMessages.find((m) => m.reqId === this.currentReqId) ?? null;
  }

  /**
   * 让当前消息以失败告终：从队列移除、复位 isProcessing、推进下一条。
   * 供 host 在 prompt 失败、watchdog 超时等场景调用，确保队列不会因单条消息卡死。
   */
  failCurrent(reqId: string, reason?: string): void {
    if (reason) console.warn(`[weixinbot] 消息 ${reqId.slice(0, 12)}... 失败：${reason}`);
    this.advanceQueue(reqId);
  }

  // ── 生命周期 ──

  /** 触发扫码登录（或从缓存 token 恢复）。返回是否成功。 */
  async login(): Promise<boolean> {
    if (this.isConnected || this.loginInProgress) {
      return this.isConnected;
    }
    try {
      // 先尝试从缓存恢复
      const accounts = getLoggedInAccounts();
      if (accounts.length > 0) {
        // 取第一个有 token 的账户尝试恢复（Nova 单连接场景）
        const saved = accounts[0];
        const lockResult = await acquireLock(this.SESSION_ID, saved.accountId);
        if (!lockResult.success) {
          this.emitStatus({ kind: "error", detail: lockResult.message });
          return false;
        }
        this.currentAccount = saved;
        this.isConnected = true;
        this.startMonitor();
        this.emitStatus({
          kind: "online",
          accountId: saved.accountId,
          accountName: saved.name,
        });
        return true;
      }

      // 无缓存，走扫码流程
      this.loginInProgress = true;
      this.emitStatus({ kind: "awaiting_scan" });

      const result = await fullQRLogin({
        onStatus: () => {
          // 状态变化由 onQrCode + 最终结果反映，这里不重复 emit
        },
        onQRCode: async (url) => {
          // ilink 返回的 qrcode_img_content 是 URL，但访问得到的是 HTML 页面
          // （前端 <img> 无法渲染），且 Tauri CSP 会拦外部图片。
          // 这里用 qrcode 包把 URL 内容转成 base64 data URI 再传给前端。
          const dataUri = await toQrCodeDataUri(url);
          if (dataUri) {
            this.callbacks.onQrCode?.(dataUri);
          } else {
            // 转换失败时回退传原始 URL，前端至少能给出链接（极少见）
            this.callbacks.onQrCode?.(url);
          }
        },
      });

      this.loginInProgress = false;

      if (result.connected && result.accountId) {
        const accounts = getLoggedInAccounts();
        const acc = accounts.find((a) => a.accountId === result.accountId) ?? null;
        if (acc) {
          const lockResult = await acquireLock(this.SESSION_ID, acc.accountId);
          if (!lockResult.success) {
            this.emitStatus({ kind: "error", detail: lockResult.message });
            this.currentAccount = null;
            return false;
          }
          this.currentAccount = acc;
          this.isConnected = true;
          this.startMonitor();
          this.emitStatus({
            kind: "online",
            accountId: acc.accountId,
            accountName: acc.name,
          });
          return true;
        }
      }

      this.emitStatus({ kind: "error", detail: result.message || "登录失败" });
      return false;
    } catch (err) {
      this.loginInProgress = false;
      const detail = err instanceof Error ? err.message : String(err);
      this.emitStatus({ kind: "error", detail });
      return false;
    }
  }

  /** 退出当前账号并停止监听。 */
  async logout(): Promise<void> {
    if (this.currentAccount) {
      logoutAccount(this.currentAccount.accountId);
    }
    this.stopMonitor();
    await releaseLock(this.SESSION_ID).catch(() => {});
    // 复位所有状态标志，避免遗留（loginInProgress 不清会导致下次登录被守卫挡住；
    // watchdog 不清会触发已停止的 service 的回调）。
    this.loginInProgress = false;
    this.isConnected = false;
    this.currentAccount = null;
    this.pendingMessages.length = 0;
    this.replyToMap.clear();
    this.currentReqId = null;
    this.isProcessing = false;
    this.disarmWatchdog();
    this.emitStatus({ kind: "offline" });
  }

  /**
   * 清空所有已登录账号的 token 缓存（删除渠道时调用，强制下次扫码）。
   *
   * 与 logout() 的差异：不依赖 this.currentAccount（删除场景下往往已被 stop() 置空），
   * 直接遍历磁盘上的全部已登录账号清理，规避「先 stop 再 logout 导致 token 清不掉」的陷阱。
   */
  async clearAllAccounts(): Promise<void> {
    for (const acc of getLoggedInAccounts()) {
      logoutAccount(acc.accountId);
    }
    // 复用 stop() 的连接断开 + 状态复位（stop 本身不删 token，token 已在上面清掉）
    await this.stop();
  }

  /** 停止一切活动（不登出账号，仅断开当前连接，保留 token 缓存）。 */
  async stop(): Promise<void> {
    this.stopMonitor();
    await releaseLock(this.SESSION_ID).catch(() => {});
    this.loginInProgress = false;
    this.isConnected = false;
    this.currentAccount = null;
    this.pendingMessages.length = 0;
    this.replyToMap.clear();
    this.currentReqId = null;
    this.isProcessing = false;
    this.disarmWatchdog();
    this.emitStatus({ kind: "offline" });
  }

  /** 强制释放排他锁（异常恢复用）。 */
  async forceUnlock(): Promise<boolean> {
    return forceReleaseLock();
  }

  // ── 回复 ──

  /**
   * 把 AI 回复发回微信，并推进消息队列。
   * host 在后台 session message_end 时调用：先 getCurrentPending 拿到接收者，再传文本进来。
   */
  async sendReply(reqId: string, text: string): Promise<void> {
    const target = this.replyToMap.get(reqId);
    if (!target) return;
    const trimmed = text.trim();
    if (!trimmed || !this.currentAccount?.token) {
      this.advanceQueue(reqId);
      return;
    }
    try {
      await sendWeixinMessage({
        baseUrl: this.currentAccount.baseUrl ?? DEFAULT_BASE_URL,
        token: this.currentAccount.token,
        to: target.userId,
        text: filterMarkdown(trimmed),
        clientId: generateClientId(),
        contextToken: target.contextToken,
      });
    } catch (err) {
      console.error(`[weixinbot] 回复发送失败:`, err);
    }
    this.advanceQueue(reqId);
  }

  /** 主动给指定用户发消息（不经过队列，供 host 的"主动通知"场景用）。 */
  async sendDirect(userId: string, text: string, contextToken?: string): Promise<void> {
    if (!this.currentAccount?.token) {
      throw new Error("未登录微信");
    }
    await sendWeixinMessage({
      baseUrl: this.currentAccount.baseUrl ?? DEFAULT_BASE_URL,
      token: this.currentAccount.token,
      to: userId,
      text: filterMarkdown(text),
      clientId: generateClientId(),
      contextToken,
    });
  }

  /**
   * 发送文件给指定用户。供 ChannelFileSink 调用（agent 通过 send_file_to_channel 工具触发）。
   * 流程：uploadMediaToCdn（AES 加密 + CDN POST）→ 可选 caption 文本 → sendFileMessage。
   * @returns 文件名，用于前端展示
   */
  async sendFile(
    userId: string,
    filePath: string,
    caption?: string,
    contextToken?: string,
  ): Promise<string> {
    if (!this.currentAccount?.token) {
      throw new Error("未登录微信");
    }
    const baseUrl = this.currentAccount.baseUrl ?? DEFAULT_BASE_URL;
    const token = this.currentAccount.token;
    const fileName = filePath.split(/[/\\]/).pop() || "file";

    // 1. 上传到 CDN（统一按 FILE 类型，不区分图片/视频）
    const uploaded = await uploadMediaToCdn({
      filePath,
      toUserId: userId,
      baseUrl,
      token,
      cdnBaseUrl: CDN_BASE_URL,
      mediaType: UploadMediaType.FILE,
      label: "sendFile",
    });

    // 2. 可选：caption 作为独立文本消息先发（与 openclaw-weixin sendMediaItems 一致）
    if (caption && caption.trim()) {
      await sendWeixinMessage({
        baseUrl,
        token,
        to: userId,
        text: filterMarkdown(caption),
        clientId: generateClientId(),
        contextToken,
      });
    }

    // 3. 发送文件消息
    await sendFileMessage({
      baseUrl,
      token,
      to: userId,
      clientId: generateClientId(),
      contextToken,
      fileName,
      encryptQueryParam: uploaded.downloadEncryptedQueryParam,
      // aes_key：与 openclaw-weixin 一致，把 hex 字符串按 UTF-8 编码再转 base64
      // （不是 Buffer.from(hex, "hex") 解码回原始 16 字节，那样微信端解密会失败）
      aesKeyBase64: Buffer.from(uploaded.aeskeyHex).toString("base64"),
      fileSize: uploaded.fileSize,
    });
    return fileName;
  }

  // ── 内部：消息监听 ──

  private startMonitor(): void {
    if (!this.currentAccount?.token || !this.currentAccount.accountId) return;
    if (this.monitorAbortController) this.monitorAbortController.abort();
    this.monitorAbortController = new AbortController();
    const signal = this.monitorAbortController.signal;
    let getUpdatesBuf = "";
    let consecutiveErrors = 0;

    const poll = async () => {
      if (signal.aborted) return;
      try {
        const resp = await getUpdates({
          baseUrl: this.currentAccount!.baseUrl ?? DEFAULT_BASE_URL,
          token: this.currentAccount!.token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: 35000,
        });

        if (typeof resp.ret === "number" && resp.ret !== 0) {
          if (resp.errcode === -14) {
            // Session 过期：断开连接，提示重新登录
            this.isConnected = false;
            this.stopMonitor();
            await releaseLock(this.SESSION_ID).catch(() => {});
            this.emitStatus({
              kind: "error",
              detail: "微信 Session 已过期，请重新扫码登录",
            });
            return;
          }
          // 未知错误码（token 失效、限流、服务端 5xx 等）：告警 + 退避，
          // 避免静默无限快速轮询触发 ilink 风控。
          consecutiveErrors++;
          const detail = `微信接口错误 ret=${resp.ret} errcode=${resp.errcode ?? "n/a"} ${resp.errmsg ?? ""}`.trim();
          console.warn(`[weixinbot] ${detail}`);
          if (consecutiveErrors === 1) {
            // 首次错误通知前端，让用户感知（持续错误仍保持连接，避免单次抖动误杀）
            this.emitStatus({ kind: "error", detail: "微信接口暂不可用，正在重试..." });
          }
          // 不更新 get_updates_buf，避免错误响应污染游标
          const backoff = Math.min(30_000, 1000 * 2 ** Math.min(consecutiveErrors - 1, 6));
          if (!signal.aborted) setTimeout(poll, backoff);
          return;
        }

        consecutiveErrors = 0;
        if (resp.get_updates_buf) getUpdatesBuf = resp.get_updates_buf;

        if (resp.msgs?.length) {
          for (const msg of resp.msgs) {
            if (msg.message_type === MessageType.BOT) continue; // 忽略自己发的（L5：命名常量）
            const fromUserId = msg.from_user_id ?? "";
            if (!fromUserId) continue;

            const textBody = extractTextBody(msg.item_list);
            const items = msg.item_list ?? [];
            // M2 修复：原条件 `!msg.item_list` 永远为 false（外层已 ?.length 进来），
            // 导致纯媒体消息（无文本）的过滤逻辑失效。改为显式判"无文本且无 item"。
            if (!textBody && items.length === 0) continue;

            // 拼接媒体占位：文本在前（若有），媒体占位追加，避免前导换行
            const parts: string[] = [];
            if (textBody) parts.push(textBody);
            if (items.some((i) => i.type === MessageItemType.IMAGE)) parts.push("[收到图片消息]");
            if (items.some((i) => i.type === MessageItemType.VIDEO)) parts.push("[收到视频消息]");
            if (items.some((i) => i.type === MessageItemType.FILE)) parts.push("[收到文件消息]");
            // 纯语音（无转文字）：覆盖为提示（不与文本拼接，避免「文本+语音」双语义）
            if (items.some((i) => i.type === MessageItemType.VOICE && !i.voice_item?.text) && !textBody) {
              parts.length = 0;
              parts.push("[收到语音消息，需微信端查看]");
            }
            const messageText = parts.join("\n");

            const reqId = generateClientId();
            const incoming: WeixinIncomingMessage = {
              reqId,
              fromUserId,
              text: messageText,
              contextToken: msg.context_token,
              accountId: this.currentAccount!.accountId,
            };
            this.pendingMessages.push(incoming);
          }
          this.processQueue();
        }
      } catch (err) {
        consecutiveErrors++;
        // 网络错误（fetch reject、超时 abort 等）：指数退避，避免 100ms 快速重试打爆服务器
        console.error(`[weixinbot] getUpdates 异常（连续第 ${consecutiveErrors} 次）:`, err);
        const backoff = Math.min(30_000, 1000 * 2 ** Math.min(consecutiveErrors - 1, 6));
        if (!signal.aborted) setTimeout(poll, backoff);
        return;
      }
      if (!signal.aborted) setTimeout(poll, 100);
    };
    poll();
  }

  private stopMonitor(): void {
    if (this.monitorAbortController) {
      this.monitorAbortController.abort();
      this.monitorAbortController = null;
    }
  }

  /** 按 FIFO 取一条消息，通知 host 把它发给后台 session。 */
  private processQueue(): void {
    if (this.isProcessing || this.pendingMessages.length === 0) return;
    const message = this.pendingMessages[0];
    if (!message) return;
    if (message.accountId !== this.currentAccount?.accountId) {
      this.pendingMessages.shift();
      this.processQueue();
      return;
    }
    this.isProcessing = true;
    this.currentReqId = message.reqId;
    this.replyToMap.set(message.reqId, {
      userId: message.fromUserId,
      contextToken: message.contextToken,
    });
    // watchdog：若 60s 内没收到 message_end（pi 异常/未 deliver/dispose 提前），
    // 强制推进队列，避免整条管线死锁。host 拿到 message_end 走 advanceQueue 时会清掉它。
    this.armWatchdog(message.reqId);
    try {
      this.callbacks.onIncomingMessage?.(message);
    } catch (err) {
      console.error(`[weixinbot] onIncomingMessage 回调抛错:`, err);
      this.advanceQueue(message.reqId);
    }
  }

  /** 当前 watchdog 句柄（按 currentReqId 关联，避免跨消息误触发）。 */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  private armWatchdog(reqId: string): void {
    this.disarmWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      // 只有当前还在等这条消息才推进；否则可能是已完成或已 stop，忽略。
      if (this.currentReqId === reqId && this.isProcessing) {
        console.warn(`[weixinbot] watchdog 超时，强制推进队列（reqId=${reqId.slice(0, 12)}...）`);
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

  /** 一条消息处理完，清理并取下一条。 */
  private advanceQueue(reqId: string): void {
    const idx = this.pendingMessages.findIndex((m) => m.reqId === reqId);
    if (idx >= 0) this.pendingMessages.splice(idx, 1);
    this.replyToMap.delete(reqId);
    if (this.currentReqId === reqId) this.currentReqId = null;
    this.isProcessing = false;
    // 本条已结束（无论成败），清掉它的 watchdog
    this.disarmWatchdog();
    this.processQueue();
  }

  private emitStatus(status: WeixinStatus): void {
    try {
      this.callbacks.onStatus?.(status);
    } catch (err) {
      console.error(`[weixinbot] onStatus 回调抛错:`, err);
    }
  }
}

/** 便捷导出：host 启动时注入 stateDir（agentDir/weixin）。 */
export { setStateDir } from "./weixin-auth.js";
export { getStateDir as getWeixinStateDir } from "./weixin-auth.js";
export { checkLockStatus as checkWeixinLockStatus } from "./lock-manager.js";

/** 给 host 用的 stateDir 拼接（agentDir/weixin）。 */
export function resolveWeixinStateDir(agentDir: string): string {
  return join(agentDir, "weixin");
}
