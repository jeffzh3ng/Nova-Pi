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
