type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const textFromContent = (value: JsonRecord): string | undefined => {
  if (!Array.isArray(value.content)) return undefined;
  for (const block of value.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return undefined;
};

const unwrapValue = (raw: unknown, depth = 0): unknown => {
  if (depth > 6) return raw;
  if (typeof raw === "string") {
    try {
      return unwrapValue(JSON.parse(raw), depth + 1);
    } catch {
      return raw;
    }
  }
  if (!isRecord(raw)) return raw;

  if (raw.isError === true) {
    throw new Error(textFromContent(raw)?.trim() || "MCP 工具返回失败。");
  }

  if (isRecord(raw.structuredContent)) {
    return unwrapValue(raw.structuredContent, depth + 1);
  }

  if (
    "result" in raw
    && (Object.keys(raw).length === 1 || (Object.keys(raw).length === 2 && "isError" in raw))
  ) {
    return unwrapValue(raw.result, depth + 1);
  }

  const contentText = textFromContent(raw);
  if (contentText !== undefined) {
    return unwrapValue(contentText, depth + 1);
  }
  return raw;
};

/** Convert an MCP callTool envelope into the business payload expected by the UI. */
export function unwrapMcpToolResult(raw: unknown): unknown {
  const value = unwrapValue(raw);
  if (isRecord(value) && typeof value.error === "string" && value.error.trim()) {
    throw new Error(value.error.trim());
  }
  return value;
}
