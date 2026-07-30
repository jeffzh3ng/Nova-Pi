import assert from "node:assert/strict";
import test from "node:test";
import { extractMcpModelContent, extractMcpPayload, isMcpCallError } from "./payload.js";

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

test("preserves non-object structuredContent allowed by the 2026 protocol", () => {
  assert.deepEqual(extractMcpPayload({ structuredContent: ["alpha", 2, false] }), {
    data: ["alpha", 2, false],
    text: '[\n  "alpha",\n  2,\n  false\n]',
  });
  assert.deepEqual(extractMcpPayload({ structuredContent: null }), {
    data: null,
    text: "null",
  });
});

test("passes MCP images to pi and preserves non-text content in details", () => {
  const raw = {
    content: [
      { type: "text", text: "evidence" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "resource_link", name: "report", uri: "file:///report.json" },
    ],
  };
  assert.deepEqual(extractMcpPayload(raw), {
    data: { content: raw.content },
    text: "evidence",
  });
  assert.deepEqual(extractMcpModelContent(raw, "fallback"), [
    { type: "text", text: "evidence" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    { type: "text", text: "[MCP 资源链接：report (file:///report.json)]" },
  ]);
});
