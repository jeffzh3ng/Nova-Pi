/**
 * 智谱 GLM-OCR 文档解析客户端。
 *
 * 端点：POST https://open.bigmodel.cn/api/paas/v4/layout_parsing
 * 鉴权：Authorization: Bearer {API_KEY}
 * 入参：{ model: "glm-ocr", file: <data URL base64>, start_page_id?, end_page_id? }
 * 出参：md_results（Markdown 文本）+ layout_details + usage
 *
 * 限制：单图≤10MB、PDF≤50MB、单批最多 100 页；支持 PDF/JPG/PNG。
 * 超过 100 页的 PDF 自动分批（每批 100 页），逐批调用并拼接 md_results。
 * 未配置 API Key 时返回 unavailable，调用方（document 工具）据此降级到 vision。
 */

import type { AgentAttachment } from "../attachments.js";
import { parsePdfWithTimeout } from "./parsers.js";

/** OCR 运行结果。status 决定 document 工具的状态机走向。 */
export type OcrOutcome = {
  /** success = 提取到文本；empty = 调用成功但无文本；failed = 调用出错；unavailable = 未配置 key 或文件超限 */
  status: "success" | "empty" | "failed" | "unavailable";
  text: string;
  warning?: string;
};

const GLM_OCR_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";
const GLM_OCR_MODEL = "glm-ocr";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
/**
 * 单次 OCR 调用超时。智谱对扫描版大 PDF 的处理耗时随页数增长：实测 81 页约 248s。
 * 设为 300s（5 分钟）给大文件留足余量，避免 OCR 实际能成功却被超时判失败，
 * 导致 LLM 误判 OCR 不可用、转而去试 vision/bash 等错误降级路径。
 */
const OCR_TIMEOUT_MS = 300_000;
/**
 * 智谱单批页数上限。官方支持单批≤100 页，但批次越大单次耗时越长（越易触发服务端慢/超时）。
 * 实测 20 页约 130s、稳定可成功；调小到 20 页/批：单批更快返回，且某批超时只丢该批、其余可用。
 * 导出供测试。
 */
export const MAX_PAGES_PER_BATCH = 20;

/** 智谱 API 响应体（仅取需要解析的字段）。 */
type GlmOcrResponse = {
  md_results?: string;
  layout_details?: Array<{ content?: string }>;
  usage?: { total_tokens?: number };
};

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
};

export type OcrClient = {
  /** 是否已配置 API Key（document 工具据此决定是调内置还是直接降级 vision）。 */
  isConfigured(): boolean;
  /** 对受控附件执行 OCR。文件读取由调用方注入（保持受控边界）。 */
  runOcr(file: AgentAttachment, bytes: Buffer, signal?: AbortSignal): Promise<OcrOutcome>;
};

/**
 * 创建 OCR 客户端。keyGetter 由 host 内存层提供，收到 configure_ocr RPC 时更新。
 * 用原生 fetch（Node 22 内置），不引入新依赖。
 */
export function createOcrClient(keyGetter: () => string | null): OcrClient {
  return {
    isConfigured() {
      const key = keyGetter();
      return typeof key === "string" && key.trim().length > 0;
    },

    async runOcr(file, bytes, signal): Promise<OcrOutcome> {
      const apiKey = keyGetter();
      if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
        return { status: "unavailable", text: "", warning: "未配置智谱 OCR API Key。" };
      }
      const ext = file.ext.replace(/^\./, "").toLowerCase();
      const mime = MIME_BY_EXT[ext];
      if (!mime) {
        return { status: "failed", text: "", warning: `内置 OCR 暂不支持 .${ext || "unknown"} 格式。` };
      }
      const isPdf = ext === "pdf";
      const sizeLimit = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
      if (bytes.length > sizeLimit) {
        return {
          status: "failed",
          text: "",
          warning: `${file.name} 超过内置 OCR 上限（${isPdf ? "PDF 50MB" : "图片 10MB"}），请改用支持大文件的外部 MCP 或拆分后重试。`,
        };
      }
      const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;

      // 图片：单次调用即可。PDF：需要先确定页数，超过 100 页分批。
      let batches: Array<{ start: number; end: number }>;
      if (isPdf) {
        const pages = await countPdfPages(bytes, signal).catch(() => null);
        // 取不到页数时退化为单次全量调用，让智谱自己处理（超限会返回 1214）。
        batches = pages && pages > MAX_PAGES_PER_BATCH ? planBatches(pages) : [{ start: 1, end: pages ?? 0 }];
      } else {
        batches = [{ start: 0, end: 0 }];
      }

      const parts: string[] = [];
      let lastWarning: string | undefined;
      let hadFailure = false;
      let batchIndex = 0;
      for (const batch of batches) {
        if (signal?.aborted) return { status: "failed", text: parts.join("\n\n").trim(), warning: "OCR 已中断。" };
        const outcome = await callOnce(apiKey, file, bytes.length, mime, dataUrl, batch, batches.length > 1, batchIndex, signal);
        if (outcome.status === "success") {
          if (outcome.text.trim()) parts.push(outcome.text.trim());
        } else if (outcome.status === "empty") {
          // 单批空文本不致命，继续下一批；全空时由最终合并逻辑判 empty。
        } else {
          // failed：记录警告，继续尝试其他批次（部分可用优于全失败）。
          hadFailure = true;
          lastWarning = outcome.warning;
          console.error(`[ocr-client] ${file.name} batch ${batchIndex + 1}/${batches.length} (pages ${batch.start}-${batch.end || "?"}) 失败：${outcome.warning ?? ""}`);
        }
        batchIndex += 1;
      }

      const text = parts.join("\n\n").trim();
      if (text) {
        const warnings = hadFailure ? [`部分批次失败（已返回成功批次内容）：${lastWarning ?? ""}`] : undefined;
        return { status: "success", text, warning: warnings?.[0] };
      }
      // 无任何文本：若全是失败，报 failed；若调用成功但空，报 empty。
      if (hadFailure) return { status: "failed", text: "", warning: lastWarning ?? "OCR 全部批次失败。" };
      return { status: "empty", text: "", warning: "智谱 OCR 未识别到文本（可能是空白图/扫描质量差）。" };
    },
  };
}

/** 单次调用智谱 API（处理一批页或一张图）。 */
async function callOnce(
  apiKey: string,
  file: AgentAttachment,
  byteLength: number,
  mime: string,
  dataUrl: string,
  batch: { start: number; end: number },
  multiBatch: boolean,
  batchIndex: number,
  signal?: AbortSignal,
): Promise<{ status: "success" | "empty" | "failed"; text: string; warning?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const body: Record<string, unknown> = { model: GLM_OCR_MODEL, file: dataUrl };
    // 仅多批分页时传 start_page_id/end_page_id（智谱要求两者同时出现）。
    // 单批全量调用（end=0）不传，避免对图片/小 PDF 产生多余约束。
    if (multiBatch && batch.end > 0) {
      body.start_page_id = batch.start;
      body.end_page_id = batch.end;
    }
    const response = await fetch(GLM_OCR_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const respBody = await response.text().catch(() => "");
      const hint = response.status === 401 ? "API Key 无效或已过期" : response.status === 403 ? "API Key 无 GLM-OCR 权限" : "";
      const warning = `智谱 OCR 返回 HTTP ${response.status}${hint ? `（${hint}）` : ""}${respBody ? `：${respBody.slice(0, 200)}` : ""}`;
      const tag = multiBatch ? `批次 ${batchIndex + 1}（页 ${batch.start}-${batch.end}）` : `${file.name}`;
      console.error(`[ocr-client] ${tag} (${byteLength} bytes, ${mime}) 失败：${warning}`);
      return { status: "failed", text: "", warning };
    }
    const payload = (await response.json()) as GlmOcrResponse;
    const text = extractText(payload);
    if (!text.trim()) return { status: "empty", text: "", warning: "本批次未识别到文本。" };
    return { status: "success", text };
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      // 超时多数是服务仍在处理大文件（非真正失败）。用"仍在处理、建议重试"语气，
      // 而非"失败"，避免 document 工具/LLM 误判 OCR 不可用而走错误降级（vision/bash）。
      return { status: "failed", text: "", warning: `智谱 OCR 调用超时（${OCR_TIMEOUT_MS / 1000}s）——服务可能仍在处理大文件，可稍后重试 ocr，或缩小页码范围（pages 参数）分批识别。` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", text: "", warning: `智谱 OCR 调用失败：${message}` };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** 从响应里合并 md_results 与 layout_details 的文本，避免布局解析丢字。 */
function extractText(payload: GlmOcrResponse): string {
  const parts: string[] = [];
  const md = (payload.md_results ?? "").trim();
  if (md) parts.push(md);
  const detail = (payload.layout_details ?? [])
    .map((item) => item.content?.trim() ?? "")
    .filter((content) => content.length > 0);
  if (detail.length > 0) parts.push(detail.join("\n"));
  return parts.join("\n\n").trim();
}

/** 用 pdf2json 解析 PDF 总页数（仅取 Pages.length，不提取文本）。复用 parsers 的带超时解析。 */
function countPdfPages(bytes: Buffer, signal?: AbortSignal): Promise<number> {
  return parsePdfWithTimeout(bytes, signal).then((output) => output.Pages.length);
}

/** 把总页数切成每批不超过 100 页的区间（1-based，闭区间）。导出供测试。 */
export function planBatches(totalPages: number): Array<{ start: number; end: number }> {
  const batches: Array<{ start: number; end: number }> = [];
  for (let start = 1; start <= totalPages; start += MAX_PAGES_PER_BATCH) {
    const end = Math.min(start + MAX_PAGES_PER_BATCH - 1, totalPages);
    batches.push({ start, end });
  }
  return batches;
}
