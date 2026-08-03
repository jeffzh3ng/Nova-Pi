import assert from "node:assert/strict";
import test from "node:test";
import { getWritableConversationId, requiresNewPiSession } from "./conversationRouting";

test("rebuilds a general session when the user mentions an MCP employee", () => {
  assert.equal(
    requiresNewPiSession(
      { humanId: "general-chat" },
      {
        humanId: "data-security-risk-assessment",
        mcpServiceId: "data-security-risk-assessment-mcp",
      },
    ),
    true,
  );
});

test("reuses a session whose employee and MCP binding are unchanged", () => {
  const identity = {
    humanId: "data-security-risk-assessment",
    mcpServiceId: "data-security-risk-assessment-mcp",
  };
  assert.equal(requiresNewPiSession(identity, identity), false);
});

test("rebuilds a custom employee session when its MCP binding changes", () => {
  assert.equal(
    requiresNewPiSession(
      { humanId: "custom", mcpServiceId: "old-service" },
      { humanId: "custom", mcpServiceId: "new-service" },
    ),
    true,
  );
});

test("first attachment upload reuses the conversation created earlier in the same event", () => {
  let currentConversationRef: string | undefined;
  const uploadConversationId = getWritableConversationId(currentConversationRef, false) ?? "conversation-a";
  currentConversationRef = uploadConversationId;
  const promptConversationId = getWritableConversationId(currentConversationRef, false) ?? "conversation-b";
  assert.equal(promptConversationId, uploadConversationId);
});

test("read-only conversations are never reused for a new attachment", () => {
  assert.equal(getWritableConversationId("archived", true), undefined);
});
