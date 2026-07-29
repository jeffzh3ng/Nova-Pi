import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_BOTTOM_THRESHOLD_PX,
  isConversationNearBottom,
} from "./conversationScroll";

test("conversation tail is followed at or near the bottom", () => {
  assert.equal(
    isConversationNearBottom({ clientHeight: 500, scrollHeight: 1_000, scrollTop: 500 }),
    true,
  );
  assert.equal(
    isConversationNearBottom({
      clientHeight: 500,
      scrollHeight: 1_000,
      scrollTop: 500 - CONVERSATION_BOTTOM_THRESHOLD_PX,
    }),
    true,
  );
});

test("conversation tail is not followed after the user scrolls up", () => {
  assert.equal(
    isConversationNearBottom({
      clientHeight: 500,
      scrollHeight: 1_000,
      scrollTop: 500 - CONVERSATION_BOTTOM_THRESHOLD_PX - 1,
    }),
    false,
  );
});

test("a non-scrollable conversation is considered at the bottom", () => {
  assert.equal(
    isConversationNearBottom({ clientHeight: 500, scrollHeight: 300, scrollTop: 0 }),
    true,
  );
});
