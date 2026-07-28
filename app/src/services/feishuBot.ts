import { sendRpc } from "./hostBridge";

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  groupPolicy: "open" | "mention";
};

export type FeishuStatus = {
  kind: "offline" | "connecting" | "online" | "error";
  appName?: string;
  botOpenId?: string;
  detail?: string;
};

export async function startFeishuBot(
  channelId: string,
  humanId: string,
  config: FeishuConfig,
): Promise<boolean> {
  const result = await sendRpc<{ started: boolean }>({
    type: "feishu_start",
    channelId,
    humanId,
    config,
  });
  return result?.started === true;
}

export async function stopFeishuBot(channelId: string): Promise<void> {
  await sendRpc({ type: "feishu_stop", channelId });
}

export async function disposeFeishuBot(channelId: string): Promise<void> {
  await sendRpc({ type: "feishu_dispose", channelId });
}

export async function getFeishuBotStatus(channelId: string): Promise<FeishuStatus> {
  return sendRpc<FeishuStatus>({ type: "feishu_status", channelId });
}
