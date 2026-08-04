import assert from "node:assert/strict";
import test from "node:test";
import { isConversationPersistenceStateCurrent } from "./conversationPersistence";

test("does not deduplicate a terminal status change when messages are unchanged", () => {
  const persisted = {
    id: "conversation-1",
    messageFingerprint: "same-messages",
    status: "running" as const,
  };

  assert.equal(
    isConversationPersistenceStateCurrent(persisted, {
      ...persisted,
      status: "done",
    }),
    false,
  );
});

test("deduplicates only an identical conversation persistence state", () => {
  const persisted = {
    id: "conversation-1",
    messageFingerprint: "same-messages",
    status: "done" as const,
  };

  assert.equal(isConversationPersistenceStateCurrent(persisted, persisted), true);
  assert.equal(
    isConversationPersistenceStateCurrent(persisted, {
      ...persisted,
      messageFingerprint: "new-messages",
    }),
    false,
  );
});
