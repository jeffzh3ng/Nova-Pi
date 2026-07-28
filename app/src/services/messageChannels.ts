/**
 * 消息通道（微信/飞书/...）配置 service：封装对 Rust 侧 commands 的调用。
 * 与 message_channels.rs 的 MessageChannel 结构对齐（camelCase）。
 */

import { invoke } from "@tauri-apps/api/core";

export type MessageChannel = {
  channelId: string;
  channelType: string;
  displayName: string;
  enabled: boolean;
  autoStart: boolean;
  humanId: string;
  showMessages: boolean;
  configJson: string;
  updatedAt: string;
};

/**
 * 渠道类型目录（新建渠道时选）。
 * available=true 表示已实现可新建；false 表示仍是占位，UI 标灰禁用。
 * 微信、Telegram 仍是单实例；飞书按 channelId 建立独立 manager，允许配置多个应用，
 * 并分别绑定不同数字员工。
 */
export type ChannelTypeOption = {
  id: string;
  displayName: string;
  available: boolean;
  /** 是否允许同一类型创建多个独立渠道实例。 */
  multiple?: boolean;
  /** 默认显示名（新建时预填） */
  defaultDisplayName: string;
};

export const CHANNEL_TYPES: ChannelTypeOption[] = [
  { id: "wechat", displayName: "微信", available: true, defaultDisplayName: "微信" },
  { id: "telegram", displayName: "Telegram", available: true, defaultDisplayName: "Telegram" },
  { id: "feishu", displayName: "飞书", available: true, multiple: true, defaultDisplayName: "飞书" },
  { id: "dingtalk", displayName: "钉钉", available: false, defaultDisplayName: "钉钉" },
];

/** 列出全部消息通道（含未启用的）。 */
export async function listMessageChannels(): Promise<MessageChannel[]> {
  const result = await invoke<{ channels: MessageChannel[] }>("list_message_channels");
  return result.channels;
}

/** 查询单个通道配置。 */
export async function getMessageChannel(channelId: string): Promise<MessageChannel> {
  return invoke<MessageChannel>("get_message_channel", { channelId });
}

/** 保存（upsert）通道配置。 */
export async function saveMessageChannel(channel: MessageChannel): Promise<void> {
  await invoke("save_message_channel", { channel });
}

/** 删除（或禁用）通道。内置 wechat 走禁用，自定义渠道真删。 */
export async function deleteMessageChannel(channelId: string): Promise<void> {
  await invoke("delete_message_channel", { channelId });
}

export type MessageChannelRecord = {
  recordId: number;
  channelId: string;
  eventKey: string;
  externalMessageId?: string;
  conversationKey?: string;
  role: "incoming" | "assistant";
  senderId?: string;
  content: string;
  createdAtMs: number;
};

/** 读取指定渠道最近的持久化消息记录，返回顺序为从旧到新。 */
export async function listMessageChannelRecords(
  channelId: string,
  limit = 200,
  beforeId?: number,
): Promise<MessageChannelRecord[]> {
  const result = await invoke<{ records: MessageChannelRecord[] }>("list_message_channel_records", {
    channelId,
    limit,
    beforeId,
  });
  return result.records;
}
