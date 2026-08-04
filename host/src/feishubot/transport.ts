import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FeishuConfig, FeishuIncomingMessage } from "./types.js";

const MAX_TEXT_CHARS = 20_000;

/** 飞书 im.file.create 的文件大小上限（30 MB）。 */
const MAX_FILE_BYTES = 30 * 1024 * 1024;

type FeishuIdentity = {
  appName?: string;
  botOpenId?: string;
};

export class FeishuTransport {
  private sdkClient: any;
  private wsClient: any;
  private running = false;
  private identity: FeishuIdentity = {};

  constructor(
    private readonly config: FeishuConfig,
    private readonly onMessage: (message: FeishuIncomingMessage) => Promise<void>,
  ) {}

  async start(): Promise<FeishuIdentity> {
    if (this.running) return this.identity;
    const lark = await import("@larksuiteoapi/node-sdk");
    const domain = this.config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    this.sdkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });
    this.identity = await this.probeIdentity();

    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
      "im.message.receive_v1": async (data: unknown) => this.handleRawMessage(data),
    });
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });
    this.running = true;
    try {
      this.wsClient.start({ eventDispatcher: dispatcher });
    } catch (error) {
      this.running = false;
      throw error;
    }
    return this.identity;
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      await this.wsClient?.stop?.();
    } catch (error) {
      console.warn("[feishu] 停止长连接失败", error);
    }
    this.wsClient = undefined;
    this.sdkClient = undefined;
  }

  isRunning(): boolean {
    return this.running;
  }

  async replyText(messageId: string, text: string): Promise<void> {
    if (!this.sdkClient) throw new Error("飞书连接尚未启动");
    for (const chunk of splitText(text.trim(), MAX_TEXT_CHARS)) {
      await this.sdkClient.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text: chunk }) },
      });
    }
  }

  /**
   * 回复一条文件消息：先 im.file.create 上传拿 file_key，再 im.message.reply 发 file 类型消息。
   * 上限 30 MB。file_type 飞书仅识别 opus/mp4/pdf/doc/xls/ppt/stream，其它一律用 stream。
   * @returns 文件名（用于展示）
   */
  async replyFile(messageId: string, filePath: string): Promise<string> {
    if (!this.sdkClient) throw new Error("飞书连接尚未启动");
    const fileName = path.basename(filePath) || "file";
    const buffer = await readFile(filePath);
    if (buffer.length > MAX_FILE_BYTES) {
      const mb = (buffer.length / 1024 / 1024).toFixed(1);
      throw new Error(`文件过大（${mb} MB），飞书上限 30 MB`);
    }
    const fileType = inferFeishuFileType(fileName);
    // 上传文件拿 file_key
    const uploadRes = await this.sdkClient.im.file.create({
      data: { file_type: fileType, file_name: fileName, file: buffer },
    });
    const fileKey = uploadRes?.data?.file_key;
    if (!fileKey) throw new Error("飞书文件上传未返回 file_key");
    // 以 file 类型消息回复
    await this.sdkClient.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "file", content: JSON.stringify({ file_key: fileKey }) },
    });
    return fileName;
  }

  private async probeIdentity(): Promise<FeishuIdentity> {
    try {
      const response = await this.sdkClient.request({
        url: "/open-apis/bot/v3/info",
        method: "GET",
      });
      const bot = response?.bot ?? response?.data?.bot ?? response?.data ?? {};
      const botOpenId = bot.open_id as string | undefined;
      if (!botOpenId) throw new Error("应用未启用机器人能力，或当前凭证无权读取机器人信息");
      return {
        appName: (bot.app_name ?? bot.bot_name) as string | undefined,
        botOpenId,
      };
    } catch (error) {
      throw new Error(`飞书应用验证失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleRawMessage(data: unknown): Promise<void> {
    const raw = data as any;
    const event = raw?.event ?? raw;
    const message = event?.message;
    const sender = event?.sender;
    if (!message || sender?.sender_type === "bot") return;
    if (!message.message_id || !message.chat_id || !sender?.sender_id?.open_id) return;
    if (message.chat_type !== "p2p" && message.chat_type !== "group") return;
    if (message.chat_type === "group" && this.config.groupPolicy === "mention" && !this.isBotMentioned(message)) {
      return;
    }
    const text = extractFeishuText(message.message_type, message.content, message.mentions, this.identity.botOpenId);
    if (!text) return;
    const incoming: FeishuIncomingMessage = {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      senderOpenId: sender.sender_id.open_id,
      text,
      rootId: message.root_id,
      parentId: message.parent_id,
      threadId: message.thread_id,
      conversationKey: buildFeishuConversationKey({
        messageId: message.message_id,
        chatId: message.chat_id,
        chatType: message.chat_type,
        senderOpenId: sender.sender_id.open_id,
        rootId: message.root_id,
        parentId: message.parent_id,
        threadId: message.thread_id,
      }),
    };
    // 不让飞书事件确认等待一次完整的模型调用；内部按会话键自行串行处理。
    void this.onMessage(incoming).catch((error) => {
      console.error("[feishu] 消息处理失败", error);
    });
  }

  private isBotMentioned(message: any): boolean {
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    if (!mentions.length) return false;
    if (!this.identity.botOpenId) return true;
    return mentions.some((mention: any) =>
      mention?.id?.open_id === this.identity.botOpenId || mention?.id?.union_id === this.identity.botOpenId,
    );
  }
}

export function buildFeishuConversationKey(message: {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
}): string {
  if (message.chatType === "p2p") return `p2p:${message.senderOpenId}`;
  const threadId = message.threadId || message.rootId || message.parentId;
  return threadId ? `group:${message.chatId}:thread:${threadId}` : `group:${message.chatId}`;
}

export function extractFeishuText(
  messageType: string,
  content: string,
  mentions: unknown,
  botOpenId?: string,
): string {
  let text = "";
  try {
    const parsed = JSON.parse(content || "{}");
    if (messageType === "text") {
      text = typeof parsed.text === "string" ? parsed.text : "";
    } else if (messageType === "post") {
      text = collectPostText(parsed).trim();
    }
  } catch {
    return "";
  }
  if (Array.isArray(mentions)) {
    for (const mention of mentions as any[]) {
      const isBot = !botOpenId
        || mention?.id?.open_id === botOpenId
        || mention?.id?.union_id === botOpenId;
      if (isBot && typeof mention?.key === "string") text = text.replaceAll(mention.key, "");
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

function collectPostText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(collectPostText).join("");
  const record = value as Record<string, unknown>;
  const own = typeof record.text === "string" ? record.text : "";
  return own || Object.values(record).map(collectPostText).join("\n");
}

function splitText(text: string, maxChars: number): string[] {
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const result: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const newline = remaining.lastIndexOf("\n", maxChars);
    const cut = newline > maxChars - 1_000 ? newline : maxChars;
    result.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) result.push(remaining);
  return result;
}

/** 按扩展名推断飞书 file_type（opus/mp4/pdf/doc/xls/ppt/stream），未匹配用 stream。 */
function inferFeishuFileType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase().slice(1);
  const known = new Set(["opus", "mp4", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]);
  if (!ext || !known.has(ext)) return "stream";
  // 飞书只认 doc/xls/ppt（不含 docx/xlsx/pptx），统一映射
  if (ext === "docx") return "doc";
  if (ext === "xlsx") return "xls";
  if (ext === "pptx") return "ppt";
  return ext;
}
