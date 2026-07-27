/**
 * Telegram Bot API 纯 HTTPS 封装。
 *
 * 参考：https://core.telegram.org/bots/api
 * 全部走 fetch（Node 22 内置），零依赖，可被 tsup bundle。
 * API 端点：`https://api.telegram.org/bot{token}/{method}`
 */

import type {
  TelegramApiResponse,
  TelegramUpdate,
  TelegramBotInfo,
  SendMessageParams,
  SendMessageResult,
  GetUpdatesParams,
} from "./types.js";

const API_BASE = "https://api.telegram.org";

/** Telegram 单条消息长度上限（4096 字符）。 */
export const MAX_MESSAGE_LENGTH = 4096;

/**
 * 通用 Telegram API 调用。
 * @param botToken bot token
 * @param method API 方法名（如 getMe/getUpdates/sendMessage）
 * @param body 请求体
 * @param signal 可选 abort 信号（轮询取消用）
 */
export async function callTelegram<TResult>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TResult> {
  if (!botToken) throw new Error("Telegram bot token 未配置");
  const url = `${API_BASE}/bot${botToken}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json()) as TelegramApiResponse<TResult>;
  if (!data.ok || data.result === undefined) {
    const detail = data.description
      ? `${data.description}${data.error_code ? ` (code ${data.error_code})` : ""}`
      : `Telegram API ${method} 失败`;
    throw new Error(detail);
  }
  return data.result;
}

/** 验证 bot token 有效性，返回 bot 信息。 */
export async function getMe(botToken: string): Promise<TelegramBotInfo> {
  return callTelegram<TelegramBotInfo>(botToken, "getMe", {});
}

/**
 * 长轮询获取更新。
 * @param offset 上次处理的 update_id + 1（确认消费）
 * @param timeout 长轮询超时秒数（Telegram 会阻塞到有更新或超时）
 * @param signal abort 信号（stop 时取消）
 */
export async function getUpdates(
  botToken: string,
  params: GetUpdatesParams,
  signal?: AbortSignal,
): Promise<TelegramUpdate[]> {
  return callTelegram<TelegramUpdate[]>(botToken, "getUpdates", {
    offset: params.offset,
    timeout: params.timeout ?? 30,
    limit: params.limit ?? 100,
    allowed_updates: JSON.stringify(["message", "edited_message"]),
  }, signal);
}

/** 发送文本消息。超长自动按 MAX_MESSAGE_LENGTH 拆分。 */
export async function sendMessage(
  botToken: string,
  params: SendMessageParams,
): Promise<SendMessageResult[]> {
  const results: SendMessageResult[] = [];
  // 超长拆分（Telegram 单条上限 4096）
  const chunks = chunkText(params.text, MAX_MESSAGE_LENGTH);
  for (const chunk of chunks) {
    const result = await callTelegram<SendMessageResult>(botToken, "sendMessage", {
      chat_id: params.chat_id,
      text: chunk,
      reply_to_message_id: params.reply_to_message_id,
      parse_mode: params.parse_mode,
    });
    results.push(result);
    // reply_to 只对第一条生效，避免每条都引用同一条
    params = { ...params, reply_to_message_id: undefined };
  }
  return results;
}

/** 把文本按 maxLength 拆分，尽量在换行处断开。 */
function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let cut = maxLength;
    // 优先在换行处断开（回退 200 字符内找最近的换行）
    const searchStart = Math.max(0, cut - 200);
    const lastNewline = remaining.lastIndexOf("\n", cut);
    if (lastNewline > searchStart) cut = lastNewline;
    // L4：防御 cut 落到 0（理论 searchStart 已规避，但加守卫避免死循环）
    if (cut <= 0) cut = maxLength;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
