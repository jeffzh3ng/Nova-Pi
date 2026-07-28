export type FeishuDomain = "feishu" | "lark";
export type FeishuGroupPolicy = "open" | "mention";

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  groupPolicy: FeishuGroupPolicy;
};

export type FeishuStatus =
  | { kind: "offline" }
  | { kind: "connecting" }
  | { kind: "online"; appName?: string; botOpenId?: string }
  | { kind: "error"; detail: string };

export type FeishuIncomingMessage = {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  text: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  conversationKey: string;
};

export function normalizeFeishuConfig(input: Partial<FeishuConfig>): FeishuConfig {
  const appId = input.appId?.trim() ?? "";
  const appSecret = input.appSecret?.trim() ?? "";
  if (!appId) throw new Error("请填写飞书 App ID");
  if (!appSecret) throw new Error("请填写飞书 App Secret");
  return {
    appId,
    appSecret,
    domain: input.domain === "lark" ? "lark" : "feishu",
    groupPolicy: input.groupPolicy === "open" ? "open" : "mention",
  };
}
