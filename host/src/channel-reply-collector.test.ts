import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ChannelReplyCollector } from "./channel-reply-collector.js";

const event = (value: unknown): AgentSessionEvent => value as AgentSessionEvent;

test("waits for agent_settled and sends the final assistant result after a tool call", () => {
  const collector = new ChannelReplyCollector();
  collector.begin("req-tool");

  assert.equal(collector.accept(event({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "我先确认一下当前运行状态。" },
  })), null);
  assert.equal(collector.accept(event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "我先确认一下当前运行状态。" }, { type: "toolCall" }],
    },
  })), null);

  assert.equal(collector.accept(event({ type: "tool_execution_start", toolName: "get_nova_status" })), null);
  assert.equal(collector.accept(event({ type: "tool_execution_end", toolName: "get_nova_status" })), null);
  assert.equal(collector.accept(event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Nova-PI 当前运行正常，共有 1 个活动会话。" }],
    },
  })), null);
  assert.equal(collector.accept(event({
    type: "agent_end",
    messages: [],
    willRetry: false,
  })), null);

  assert.deepEqual(collector.accept(event({ type: "agent_settled" })), {
    reqId: "req-tool",
    text: "Nova-PI 当前运行正常，共有 1 个活动会话。",
  });
});

test("keeps a simple reply pending until the whole agent run settles", () => {
  const collector = new ChannelReplyCollector();
  collector.begin("req-simple");
  assert.equal(collector.accept(event({
    type: "message_end",
    message: { role: "assistant", content: "你好，我可以协助你。" },
  })), null);
  assert.deepEqual(collector.accept(event({ type: "agent_settled" })), {
    reqId: "req-simple",
    text: "你好，我可以协助你。",
  });
  assert.equal(collector.accept(event({ type: "agent_settled" })), null);
});

test("uses the sanitized final message emitted before a synthetic settled event", () => {
  const collector = new ChannelReplyCollector();
  collector.begin("req-blocked");
  collector.accept(event({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "当前操作未获授权，请先在设置中开启权限。" }],
    },
  }));
  assert.deepEqual(collector.accept(event({ type: "agent_settled" })), {
    reqId: "req-blocked",
    text: "当前操作未获授权，请先在设置中开启权限。",
  });
});
