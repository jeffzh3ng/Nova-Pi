import { readFile, stat } from "node:fs/promises";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import mammoth from "mammoth";
import { Type } from "typebox";
import type { AttachmentRuntime, AgentAttachment } from "./attachments.js";

export const ATTACHMENT_TOOL_NAME = "attachment";
const MAX_LOCAL_TEXT_CHARS = 120_000;
const MAX_LOCAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "log", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml",
  "yaml", "yml", "ini", "conf", "cfg", "sql", "har", "html", "htm",
  "js", "jsx", "ts", "tsx", "py", "rs", "java", "go", "sh", "ps1",
]);

function extensionOf(file: AgentAttachment): string {
  return file.ext.replace(/^\./, "").toLowerCase();
}

function truncateText(text: string): string {
  const normalized = text.replace(/\u0000/g, "").trim();
  if (normalized.length <= MAX_LOCAL_TEXT_CHARS) return normalized;
  return `${normalized.slice(0, MAX_LOCAL_TEXT_CHARS)}\n…（内容已截断）`;
}

export async function inspectAttachment(file: AgentAttachment): Promise<{ text: string; parser: string }> {
  const fileInfo = await stat(file.path);
  if (!fileInfo.isFile()) throw new Error(`附件不是可读取文件：${file.name}`);
  if (fileInfo.size > MAX_LOCAL_ATTACHMENT_BYTES) {
    throw new Error(`附件 ${file.name} 超过本机解析上限 25 MB，请改用支持大文件的 MCP 服务。`);
  }
  const ext = extensionOf(file);
  if (TEXT_EXTENSIONS.has(ext)) {
    return { text: truncateText(await readFile(file.path, "utf8")), parser: "text" };
  }
  if (ext === "docx") {
    const result = await mammoth.extractRawText({ path: file.path });
    const text = truncateText(result.value);
    if (!text) throw new Error(`DOCX 附件 ${file.name} 未提取到可读正文。`);
    return { text, parser: "docx" };
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(
      `图片附件 ${file.name} 不走内置 OCR；视觉模型会直接读取图片，其他模型请使用外部 MCP/API 图片识别工具。`,
    );
  }
  throw new Error(`当前内置附件工具暂不支持 .${ext || "unknown"} 解析；可使用 mcp 工具并通过 attachment 参数传递。`);
}

export function createAttachmentExtension(attachments: AttachmentRuntime): InlineExtension {
  return {
    name: "nova-attachment",
    hidden: true,
    factory(pi) {
      pi.registerTool({
        name: ATTACHMENT_TOOL_NAME,
        label: "会话附件",
        description:
          "列出或读取当前会话已上传的受控附件。DOCX 或文本附件可直接读取；" +
          "图片由视觉模型直接读取，或交给外部 MCP/API 工具。只传用户看到的附件名，不要猜测工作目录。",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("list", { description: "列出当前会话附件" }),
            Type.Literal("inspect", { description: "安全提取指定附件内容" }),
          ]),
          name: Type.Optional(Type.String({ description: "inspect 时使用的附件文件名" })),
        }),
        async execute(_toolCallId, rawArgs) {
          const input = rawArgs as { action: "list" | "inspect"; name?: string };
          if (input.action === "list") {
            const files = attachments.list().map((file) => ({
              name: file.name,
              ext: extensionOf(file),
              size: file.size,
            }));
            return {
              content: [{ type: "text", text: files.length
                ? `当前会话附件：\n${JSON.stringify(files, null, 2)}`
                : "当前会话没有可用附件。" }],
              details: { files } as Record<string, unknown>,
            };
          }
          const name = input.name?.trim();
          if (!name) throw new Error("inspect 必须提供附件文件名；可先用 list 查询。");
          const file = await attachments.resolve(name);
          if (!file) throw new Error(`当前会话没有附件：${name}`);
          const inspected = await inspectAttachment(file);
          return {
            content: [{
              type: "text",
              text: `[附件 ${file.name} / 解析方式 ${inspected.parser}]\n${inspected.text}`,
            }],
            details: {
              attachment: { name: file.name, ext: extensionOf(file), size: file.size },
              parser: inspected.parser,
            } as Record<string, unknown>,
          };
        },
      });
    },
  };
}
