/**
 * MCP 工具结果归一化（从原 Nova external_mcp_client.rs 的 extract_tool_payload 迁移）。
 *
 * MCP 服务的返回形态多变：structuredContent、FastMCP 的 { result: "<json-string>" } 包裹、
 * 纯 text-content JSON。统一解包成可读的 result + details。
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export type McpModelContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

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

  // structuredContent（MCP 标准）。2026-07-28 起根值可以是任意 JSON，
  // 包括数组、字符串、数字、布尔值和 null，不再限定为对象。
  if (isObject(raw) && raw.structuredContent !== undefined) {
    const sc = raw.structuredContent;
    // 常见包裹：{ result: {...} }
    if (isObject(sc) && isObject(sc.result)) {
      return { data: sc.result, text: stringifyData(sc.result) };
    }
    // FastMCP 的 structuredContent 也可能包装 JSON 字符串。
    if (isObject(sc) && typeof sc.result === "string") {
      try {
        return extractMcpPayload(JSON.parse(sc.result));
      } catch {
        return { data: sc.result, text: sc.result };
      }
    }
    return { data: sc, text: stringifyData(sc) };
  }

  // content 数组（MCP 标准的 text/image 内容块）
  if (isObject(raw) && Array.isArray(raw.content)) {
    const textParts: string[] = [];
    const contentBlocks = raw.content.filter(isObject);
    const hasNonTextContent = contentBlocks.some((block) => block.type !== "text");
    let structured: unknown;
    for (const block of contentBlocks) {
      if (block.type === "text" && typeof block.text === "string") {
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
    if (hasNonTextContent) {
      return { data: { content: contentBlocks }, text: textParts.join("\n") };
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

/** Convert MCP content blocks into the text/image subset accepted by pi tool results. */
export function extractMcpModelContent(raw: unknown, fallbackText: string): McpModelContent[] {
  if (!isObject(raw) || !Array.isArray(raw.content)) {
    return [{ type: "text", text: fallbackText }];
  }

  const result: McpModelContent[] = [];
  for (const block of raw.content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      result.push({ type: "text", text: block.text });
      continue;
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      result.push({ type: "image", data: block.data, mimeType: block.mimeType });
      continue;
    }
    if (block.type === "audio") {
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "未知格式";
      result.push({ type: "text", text: `[MCP 工具返回音频：${mimeType}]` });
      continue;
    }
    if (block.type === "resource_link") {
      const name = typeof block.name === "string" ? block.name : "资源";
      const uri = typeof block.uri === "string" ? block.uri : "未知 URI";
      const description = typeof block.description === "string" ? ` — ${block.description}` : "";
      result.push({ type: "text", text: `[MCP 资源链接：${name} (${uri})${description}]` });
      continue;
    }
    if (block.type === "resource" && isObject(block.resource)) {
      const resource = block.resource;
      const uri = typeof resource.uri === "string" ? resource.uri : "未知 URI";
      if (typeof resource.text === "string") {
        result.push({ type: "text", text: `[MCP 嵌入资源：${uri}]\n${resource.text}` });
      } else {
        const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : "未知格式";
        result.push({ type: "text", text: `[MCP 嵌入二进制资源：${uri} (${mimeType})]` });
      }
    }
  }

  if (result.length > 0) return result;
  return [{ type: "text", text: fallbackText }];
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

/** MCP 协议级失败标记；pi 工具必须通过 throw 才会进入错误结果路径。 */
export function isMcpCallError(raw: unknown): boolean {
  return isObject(raw) && raw.isError === true;
}
