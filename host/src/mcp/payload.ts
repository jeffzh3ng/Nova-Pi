/**
 * MCP 工具结果归一化（从原 Nova external_mcp_client.rs 的 extract_tool_payload 迁移）。
 *
 * MCP 服务的返回形态多变：structuredContent、FastMCP 的 { result: "<json-string>" } 包裹、
 * 纯 text-content JSON。统一解包成可读的 result + details。
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 把 MCP callTool 的返回解包成结构化数据 + 文本内容。 */
export function extractMcpPayload(raw: unknown): { data: unknown; text: string } {
  if (raw == null) return { data: null, text: "" };

  // FastMCP 风格：{ result: "<json-string>" }
  if (isObject(raw) && typeof raw.result === "string" && Object.keys(raw).length <= 2) {
    try {
      const parsed = JSON.parse(raw.result);
      return extractMcpPayload(parsed);
    } catch {
      return { data: raw.result, text: raw.result };
    }
  }

  // structuredContent（MCP 标准）
  if (isObject(raw) && isObject(raw.structuredContent)) {
    const sc = raw.structuredContent;
    // 常见包裹：{ result: {...} }
    if (isObject(sc.result)) {
      return { data: sc.result, text: stringifyData(sc.result) };
    }
    return { data: sc, text: stringifyData(sc) };
  }

  // content 数组（MCP 标准的 text/image 内容块）
  if (isObject(raw) && Array.isArray(raw.content)) {
    const textParts: string[] = [];
    let structured: unknown;
    for (const block of raw.content) {
      if (isObject(block) && block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
        // 尝试把第一个 text 块当 JSON 解析，作为结构化数据
        if (structured === undefined) {
          try {
            structured = JSON.parse(block.text);
          } catch {
            // 纯文本
          }
        }
      }
    }
    if (structured !== undefined) {
      return { data: structured, text: textParts.join("\n") };
    }
    return { data: textParts.join("\n"), text: textParts.join("\n") };
  }

  // 直接是对象
  if (isObject(raw)) {
    // 去掉 error 字段后整体当 data
    return { data: raw, text: stringifyData(raw) };
  }

  // 字符串
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return extractMcpPayload(parsed);
    } catch {
      return { data: raw, text: raw };
    }
  }

  return { data: raw, text: stringifyData(raw) };
}

function stringifyData(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/** 从归一化结果里检测错误（MCP 服务常在 { error: "..." } 里返回失败）。 */
export function extractMcpError(data: unknown): string | undefined {
  if (isObject(data) && typeof data.error === "string" && data.error.trim()) {
    return data.error.trim();
  }
  return undefined;
}
