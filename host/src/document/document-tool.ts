import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DocumentRuntime, type DocumentAttachment } from "./document-runtime.js";
import { limitBlocks, parseStructuredDocument } from "./parsers.js";
import type { DocumentResult } from "./types.js";

export const DOCUMENT_TOOL_NAME = "document";

function formatOf(file: DocumentAttachment): string {
  return file.ext.replace(/^\./, "").toLowerCase() || "unknown";
}

function response(result: DocumentResult, images: Array<{ type: "image"; data: string; mimeType: string }> = [], extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }, ...images],
    details: { ...result, ...extra },
  };
}

function base(file: DocumentAttachment | undefined, status: DocumentResult["status"], stage: DocumentResult["stage"], next: string, warning?: string): DocumentResult {
  return {
    ok: status !== "rejected" && status !== "unsupported",
    attachmentId: file?.id,
    name: file?.name,
    format: file ? formatOf(file) : undefined,
    stage,
    status,
    document: file ? { bytes: file.size ?? 0 } : undefined,
    blocks: [],
    truncated: false,
    warnings: warning ? [warning] : [],
    next,
  };
}

export function createDocumentExtension(documents: DocumentRuntime): InlineExtension {
  return {
    name: "nova-document",
    hidden: true,
    factory(pi) {
      pi.registerTool({
        name: DOCUMENT_TOOL_NAME,
        label: "会话文档",
        description: "唯一的受控会话文档工具。按顺序进行结构化读取、内置 OCR（智谱 GLM-OCR）、视觉读取。图片/扫描件自动走内置 OCR；未配置 key 或 OCR 无文本时降级到 vision。不得猜测路径或跳过阶段。",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("list"), Type.Literal("read"), Type.Literal("ocr"), Type.Literal("vision"),
          ]),
          attachmentId: Type.Optional(Type.String({ description: "document.list 返回的 attachmentId，或受控附件名称" })),
          name: Type.Optional(Type.String({ description: "兼容字段：受控附件名称" })),
          pages: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
          sheetNames: Type.Optional(Type.Array(Type.String())),
          slideNumbers: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
          maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 180000 })),
          includeNotes: Type.Optional(Type.Boolean()),
          includeFormulas: Type.Optional(Type.Boolean()),
          pageImageAttachmentIds: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
        }),
        async execute(_toolCallId, rawArgs, signal) {
          const input = rawArgs as {
            action: "list" | "read" | "ocr" | "vision"; attachmentId?: string; name?: string;
            pages?: number[]; sheetNames?: string[]; slideNumbers?: number[]; maxChars?: number; includeNotes?: boolean; includeFormulas?: boolean;
            pageImageAttachmentIds?: string[];
          };
          if (input.action === "list") {
            const files = documents.list().map((file) => ({ attachmentId: file.id, name: file.name, format: formatOf(file), bytes: file.size ?? 0, stage: documents.stage(file) }));
            return response({ ok: true, stage: "structure", status: "complete", blocks: [], truncated: false, warnings: [], next: "Use read with attachmentId before OCR or vision.", document: { bytes: files.reduce((total, file) => total + file.bytes, 0) }, }, [], { files });
          }
          let file: DocumentAttachment | undefined;
          try { file = await documents.resolve(input.attachmentId ?? input.name); }
          catch { return response(base(undefined, "rejected", "structure", "Use a document attachmentId returned by document.list.", "The controlled attachment could not be resolved.")); }
          if (!file) return response(base(undefined, "rejected", "structure", "Provide an attachmentId from document.list.", "No unambiguous controlled attachment was selected."));
          if (input.action === "read") {
            if (documents.isImage(file)) {
              documents.markNeedsOcr(file);
              return response(base(file, "needs_ocr", "ocr", "Call the ocr action to run built-in OCR (智谱 GLM-OCR). Images never enter vision directly."));
            }
            try {
              const parsed = await parseStructuredDocument(file, { ...input, signal, bytes: await documents.readBytes(file) });
              const limited = limitBlocks(parsed.blocks, input.maxChars ?? 120000);
              if (documents.isPdf(file) && !limited.blocks.some((block) => block.text.trim())) {
                documents.markNeedsOcr(file);
                return response({
                  ...base(file, "needs_ocr", "ocr", "No embedded PDF text was found. Call the ocr action to run built-in OCR."),
                  document: parsed.metadata, blocks: limited.blocks, truncated: limited.truncated,
                  warnings: [...parsed.warnings, "PDF has no readable embedded text."], ok: true,
                });
              }
              const hasBlankPdfPages = documents.isPdf(file) && limited.blocks.some((block) => !block.text.trim());
              if (hasBlankPdfPages) documents.markNeedsOcr(file);
              return response({
                ...base(file, limited.truncated || hasBlankPdfPages ? "partial" : "complete", hasBlankPdfPages ? "ocr" : "structure", hasBlankPdfPages ? "Some selected PDF pages contain no embedded text; call ocr if those pages are needed." : limited.truncated ? "Read smaller ranges if more text is needed." : "Structured reading is complete."),
                document: parsed.metadata, blocks: limited.blocks, truncated: limited.truncated,
                warnings: hasBlankPdfPages ? [...parsed.warnings, "Some PDF pages have no readable embedded text."] : parsed.warnings, ok: true,
              });
            } catch (error) {
              // PDF 结构解析失败（扫描件、加密、损坏等）也走内置 OCR：智谱 GLM-OCR
              // 能直接吃 base64 PDF，不必依赖外部 MCP。其他格式仍按 unsupported 报错。
              const message = error instanceof Error ? error.message : String(error);
              if (documents.isPdf(file)) {
                documents.markNeedsOcr(file);
                return response({
                  ...base(file, "needs_ocr", "ocr", "PDF embedded text could not be read. Call the ocr action to run built-in OCR (智谱 GLM-OCR), which accepts the PDF directly."),
                  warnings: [`Embedded PDF parsing failed: ${message}`], ok: true,
                });
              }
              return response(base(file, "unsupported", "structure", "This format could not be parsed locally and has no built-in OCR path.", `Document parsing rejected the controlled file: ${message}`));
            }
          }
          if (input.action === "ocr") {
            if (documents.stage(file) !== "ocr") return response(base(file, "rejected", documents.stage(file), "Call read first so the file is in the OCR stage.", "OCR cannot run before structured read flags it."));
            const outcome = await documents.runOcr(file, signal);
            if (outcome.status === "success") {
              const text = outcome.text.trim();
              return response({ ...base(file, text ? "complete" : "partial", "structure", text ? "Built-in OCR succeeded; answer from the returned text." : "OCR returned no text; escalate to vision if needed."), blocks: text ? [{ type: "text", text }] : [], truncated: false, warnings: outcome.warning ? [outcome.warning] : [] });
            }
            // empty/failed/unavailable：尝试引导 vision；并在 next 里说明原因。
            const reason = outcome.status === "unavailable"
              ? "Built-in OCR is unavailable (no API Key). Call vision if the current model supports images."
              : outcome.status === "empty"
                ? "OCR returned no usable text. Call vision if the current model supports images."
                : `Built-in OCR failed${outcome.warning ? `: ${outcome.warning}` : ""}. Call vision if the current model supports images, or try again.`;
            return response(base(file, "needs_vision", "vision", reason, outcome.warning));
          }
          // vision
          if (!documents.canUseVision(file)) return response(base(file, "rejected", documents.stage(file), "Call read then ocr (which falls back automatically) before vision.", "Vision escalation cannot skip OCR."));
          if (!documents.supportsVision()) return response(base(file, "unsupported", "vision", "Switch to an image-capable model or use an external MCP.", "The current session model does not accept image input."));
          try {
            const pageImageIds = input.pageImageAttachmentIds ?? [];
            const source = documents.isPdf(file)
              ? documents.resolvePdfPages(file, pageImageIds)
              : [file];
            if (documents.isPdf(file) && (!source || source.length === 0)) return response(base(file, "unsupported", "vision", "Use pageImageAttachmentIds returned by the explicit PDF MCP conversion call; PDF rasterization is not performed locally.", "PDF vision requires linked controlled conversion artifacts."));
            const imageSources = source ?? [];
            if (imageSources.some((item) => !item || !documents.isImage(item))) return response(base(file, "rejected", "vision", "pageImageAttachmentIds must identify controlled image attachments.", "Invalid page image attachment."));
            const images = await documents.imageContent(imageSources as DocumentAttachment[]);
            if (!images.length) return response(base(file, "unsupported", "vision", "Use an external MCP.", "No supported controlled image was available."));
            return response({ ...base(file, "complete", "vision", "Use the returned image content to answer; do not claim OCR text that was not returned."), warnings: documents.isPdf(file) ? ["Vision uses externally converted controlled PDF page images."] : [] }, images);
          } catch {
            return response(base(file, "rejected", "vision", "Use only controlled image attachments no larger than 10 MB.", "Vision input was rejected."));
          }
        },
      });
    },
  };
}
