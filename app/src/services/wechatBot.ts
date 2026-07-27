/**
 * 微信机器人 service：封装对 sidecar 的 weixin_* RPC 命令。
 *
 * 事件流（wechat_qrcode / wechat_status / wechat_message）通过 hostBridge.subscribePiEvents
 * 订阅，由 WeChatBotPanel 自行管理。
 */

import { sendRpc } from "./hostBridge";

/** 后台会话状态（与 host WeixinStatus 对齐）。 */
export type WechatStatusKind = "offline" | "awaiting_scan" | "online" | "error";

export type WechatStatus = {
  kind: WechatStatusKind;
  account?: string;
  accountName?: string;
  detail?: string;
};

/** 启动微信机器人后台会话（不触发登录）。 */
export async function startWeixinBot(humanId: string): Promise<void> {
  await sendRpc({ type: "weixin_start", humanId });
}

/** 停止微信机器人（断开连接 + 销毁后台会话）。 */
export async function stopWeixinBot(): Promise<void> {
  await sendRpc({ type: "weixin_stop" });
}

/** 触发扫码登录（异步：二维码/状态通过事件回流）。 */
export async function loginWeixinBot(): Promise<void> {
  await sendRpc({ type: "weixin_login" });
}

/** 查询当前状态（同步响应）。 */
export async function getWeixinBotStatus(): Promise<WechatStatus> {
  const raw = await sendRpc<{ kind: WechatStatusKind; accountId?: string; accountName?: string; detail?: string }>({
    type: "weixin_status",
  });
  return {
    kind: raw.kind,
    account: raw.accountId,
    accountName: raw.accountName,
    detail: raw.detail,
  };
}
