/**
 * Telegram 机器人 service：封装对 sidecar 的 telegram_* RPC 命令。
 * 事件流（telegram_status / telegram_message）通过 hostBridge.subscribePiEvents 订阅。
 */

import { sendRpc } from "./hostBridge";

/** Telegram 渠道配置（存 message_channels.config_json）。 */
export type TelegramConfig = {
  botToken: string;
  allowedUserId?: string;
};

/** 后台状态（与 host TelegramStatus 对齐）。 */
export type TelegramStatusKind = "offline" | "awaiting_pair" | "online" | "error";

export type TelegramStatus = {
  kind: TelegramStatusKind;
  botUsername?: string;
  allowedUserId?: string;
  detail?: string;
};

/** 启动 telegram bot（验证 token + 长轮询 + 后台会话）。 */
export async function startTelegramBot(humanId: string, config: TelegramConfig): Promise<boolean> {
  const result = await sendRpc<{ started: boolean }>({ type: "telegram_start", humanId, config });
  return result?.started === true;
}

/** 停止 telegram bot（保留单例，下次 start 复用）。 */
export async function stopTelegramBot(): Promise<void> {
  await sendRpc({ type: "telegram_stop" });
}

/**
 * 彻底释放 telegram bot 单例（stop + 释放）。
 * 删除渠道 / 切换账号时调用，避免幽灵 bot 长轮询和跨用户串号（C3）。
 */
export async function disposeTelegramBot(): Promise<void> {
  await sendRpc({ type: "telegram_dispose" });
}

/**
 * 解除当前 allowedUserId 配对（H1）。
 * 清空后回到 awaiting_pair，下个 /start 可重新锁定。返回是否已执行。
 */
export async function resetTelegramPair(): Promise<boolean> {
  const result = await sendRpc<{ reset?: boolean }>({ type: "telegram_reset_pair" });
  return result?.reset === true;
}

/** 查询当前状态。 */
export async function getTelegramBotStatus(): Promise<TelegramStatus> {
  const raw = await sendRpc<{
    kind: TelegramStatusKind;
    botUsername?: string;
    allowedUserId?: string;
    detail?: string;
  }>({ type: "telegram_status" });
  return {
    kind: raw.kind,
    botUsername: raw.botUsername,
    allowedUserId: raw.allowedUserId,
    detail: raw.detail,
  };
}

/** 更新配置（用户改了 botToken 时调，需重启 service 生效）。 */
export async function updateTelegramConfig(config: TelegramConfig): Promise<void> {
  await sendRpc({ type: "telegram_update_config", config });
}
