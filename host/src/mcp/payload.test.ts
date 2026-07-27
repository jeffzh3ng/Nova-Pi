import assert from "node:assert/strict";
import test from "node:test";
import { extractMcpPayload, isMcpCallError } from "./payload.js";

test("unwraps FastMCP JSON strings inside structuredContent", () => {
  const result = extractMcpPayload({
    structuredContent: { result: '{"module":"alert-analysis","severity":"high"}' },
    content: [{ type: "text", text: "fallback" }],
  });
  assert.deepEqual(result.data, { module: "alert-analysis", severity: "high" });
});

test("detects MCP protocol errors", () => {
  assert.equal(isMcpCallError({ isError: true, content: [] }), true);
  assert.equal(isMcpCallError({ isError: false, content: [] }), false);
});
