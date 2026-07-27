/**
 * 消息通道（微信/飞书/...）配置 service：封装对 Rust 侧 commands 的调用。
 * 与 message_channels.rs 的 MessageChannel 结构对齐（camelCase）。
 */

import { invoke } from "@tauri-apps/api/core";

export type MessageChannel = {
  channelId: string;
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
 * available=true 表示已实现可新建；false 表示占位（飞书等开发中），UI 标灰禁用。
 * host 侧 WeixinBotManager 是单例，每种渠道同时只能一个活动连接，
 * 所以同一类型不能重复新建（前端在新建表单里据此禁用已存在的类型）。
 */
export type ChannelTypeOption = {
  id: string;
  displayName: string;
  available: boolean;
  /** 默认显示名（新建时预填） */
  defaultDisplayName: string;
};

export const CHANNEL_TYPES: ChannelTypeOption[] = [
  { id: "wechat", displayName: "微信", available: true, defaultDisplayName: "微信" },
  { id: "telegram", displayName: "Telegram", available: true, defaultDisplayName: "Telegram" },
  { id: "feishu", displayName: "飞书", available: false, defaultDisplayName: "飞书" },
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
