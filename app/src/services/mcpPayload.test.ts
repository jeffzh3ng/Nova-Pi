import assert from "node:assert/strict";
import test from "node:test";
import { unwrapMcpToolResult } from "./mcpPayload.js";

test("unwraps FastMCP structuredContent JSON into the business payload", () => {
  const result = unwrapMcpToolResult({
    content: [{ type: "text", text: "fallback" }],
    structuredContent: {
      result: JSON.stringify({ task_id: "task_1", status: "pending" }),
    },
    isError: false,
  });
  assert.deepEqual(result, { task_id: "task_1", status: "pending" });
});

test("surfaces a domain error wrapped by FastMCP", () => {
  assert.throws(
    () => unwrapMcpToolResult({
      structuredContent: {
        result: JSON.stringify({ error: "text_reasoning 模型未配置或缺少 API Key" }),
      },
      isError: false,
    }),
    /text_reasoning 模型未配置或缺少 API Key/,
  );
});

test("surfaces MCP protocol errors from text content", () => {
  assert.throws(
    () => unwrapMcpToolResult({
      content: [{ type: "text", text: "工具执行失败" }],
      isError: true,
    }),
    /工具执行失败/,
  );
});
