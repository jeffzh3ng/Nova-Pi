/**
 * Telegram Bot API 类型定义。
 *
 * 参考：https://core.telegram.org/bots/api
 * 仿照 pi-telegram (https://github.com/badlogic/pi-telegram) 的类型结构。
 */

/** Telegram Bot API 统一响应包装。 */
export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/** getUpdates 返回的更新项。 */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

/** 消息对象（只列首版需要的字段）。 */
export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  // 首版只支持文本，媒体字段留着以后扩展
  photo?: unknown;
  document?: unknown;
  voice?: unknown;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
}

/** getMe 返回的 bot 信息（用于 token 验证）。 */
export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

/** Telegram 渠道配置（存 message_channels.config_json）。 */
export interface TelegramConfig {
  /** 必填：@BotFather 创建 bot 后拿到的 token。 */
  botToken: string;
  /**
   * 允许的用户 id（数字字符串）。首次收到 /start 时自动填充为发送者 id。
   * 安全机制：bot token 泄露后只有这个用户能操作 Nova。
   */
  allowedUserId?: string;
}

/** sendMessage 入参。 */
export interface SendMessageParams {
  chat_id: number;
  text: string;
  reply_to_message_id?: number;
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
}

/** sendMessage 返回。 */
export interface SendMessageResult {
  message_id: number;
  date: number;
  chat: TelegramChat;
}

/** getUpdates 入参。 */
export interface GetUpdatesParams {
  offset?: number;
  timeout?: number;
  limit?: number;
}
