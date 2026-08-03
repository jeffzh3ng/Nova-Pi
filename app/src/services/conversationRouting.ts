type SessionIdentity = {
  humanId: string;
  mcpServiceId?: string;
};

/** A pi session's system prompt and MCP tool allowlist are fixed at creation. */
export function requiresNewPiSession(
  existing: SessionIdentity | undefined,
  target: SessionIdentity,
) {
  return !existing
    || existing.humanId !== target.humanId
    || existing.mcpServiceId !== target.mcpServiceId;
}

/** React state may lag behind refs during one upload event; route by the synchronous ref. */
export function getWritableConversationId(
  currentConversationId: string | undefined,
  readOnly: boolean,
): string | undefined {
  return currentConversationId && !readOnly ? currentConversationId : undefined;
}
