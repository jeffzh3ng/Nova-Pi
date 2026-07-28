import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeishuChannelStore } from "./store.js";
import { buildFeishuConversationKey, extractFeishuText } from "./transport.js";

test("creates isolated keys for direct, group and threaded conversations", () => {
  assert.equal(buildFeishuConversationKey({
    messageId: "m1", chatId: "c1", chatType: "p2p", senderOpenId: "u1",
  }), "p2p:u1");
  assert.equal(buildFeishuConversationKey({
    messageId: "m2", chatId: "c2", chatType: "group", senderOpenId: "u2",
  }), "group:c2");
  assert.equal(buildFeishuConversationKey({
    messageId: "m3", chatId: "c2", chatType: "group", senderOpenId: "u2", rootId: "root-1",
  }), "group:c2:thread:root-1");
});

test("extracts text and removes only the bot mention placeholder", () => {
  const text = extractFeishuText(
    "text",
    JSON.stringify({ text: "@_user_1 请分析这条告警" }),
    [{ key: "@_user_1", id: { open_id: "bot-1" } }],
    "bot-1",
  );
  assert.equal(text, "请分析这条告警");
});

test("persists dedupe keys and resumable conversation history per channel", () => {
  const root = mkdtempSync(join(tmpdir(), "nova-feishu-store-"));
  try {
    const first = new FeishuChannelStore(root, "feishu-one");
    assert.equal(first.claimMessage("message-1"), true);
    first.append("p2p:user-1", "incoming", "第一条消息");
    first.append("p2p:user-1", "assistant", "第一条回复");

    const reopened = new FeishuChannelStore(root, "feishu-one");
    assert.equal(reopened.claimMessage("message-1"), false);
    assert.deepEqual(reopened.resumeMessages("p2p:user-1"), [
      { role: "user", content: "第一条消息" },
      { role: "assistant", content: "第一条回复" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
