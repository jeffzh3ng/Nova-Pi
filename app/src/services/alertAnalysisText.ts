import type { AlertAnalysisResult } from "../types";

export const MAX_SUGGESTION_TEXT_LENGTH = 28;

const TEXT_KEYS = ["question", "title", "action", "description", "text", "label", "name"];
const LEGACY_FIELD_PATTERN =
  /['"](?:question|title|action|description|text|label|name)['"]\s*:\s*['"]([^'"]+)['"]/;

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const limitText = (value: string, maxLength: number) => {
  const text = normalizeWhitespace(value);
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, Math.max(0, maxLength - 3)).join("")}...`;
};

function extractText(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = normalizeWhitespace(value);
    const legacyMatch = trimmed.match(LEGACY_FIELD_PATTERN);
    if (legacyMatch?.[1]) return normalizeWhitespace(legacyMatch[1]);
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const parsedText = extractText(parsed);
      if (parsedText) return parsedText;
    } catch {
      // Plain text is expected for normal MCP responses.
    }
    return trimmed;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (isRecord(value)) {
    for (const key of TEXT_KEYS) {
      const field = value[key];
      if (typeof field === "string" || typeof field === "number" || typeof field === "boolean") {
        const text = normalizeWhitespace(String(field));
        if (text) return text;
      }
    }
  }

  return "";
}

export function normalizeTextList(
  value: unknown,
  options: { limit?: number; maxItemLength?: number } = {},
): string[] {
  const source = Array.isArray(value) ? value : value == null ? [] : [value];
  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of source) {
    const extracted = extractText(item);
    const text = options.maxItemLength ? limitText(extracted, options.maxItemLength) : extracted;
    if (!text || seen.has(text)) continue;
    result.push(text);
    seen.add(text);
    if (options.limit && result.length >= options.limit) break;
  }

  return result;
}

export const normalizeSuggestionList = (value: unknown, limit = 3) =>
  normalizeTextList(value, { limit, maxItemLength: MAX_SUGGESTION_TEXT_LENGTH });

export function normalizeAlertAnalysisResult(result: AlertAnalysisResult): AlertAnalysisResult {
  return {
    ...result,
    timeline: normalizeTextList(result.timeline),
    affectedAssets: normalizeTextList(result.affectedAssets),
    recommendedActions: normalizeTextList(result.recommendedActions),
    questions: normalizeTextList(result.questions),
    processingPlan: normalizeTextList(result.processingPlan),
    riskNotes: normalizeTextList(result.riskNotes),
  };
}
