import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ConversationAttachments } from "./rpc-protocol.js";

export type AgentAttachment = NonNullable<ConversationAttachments["files"]>[number];

const TEXT_EXTENSIONS = new Set([
  "txt", "log", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml",
  "yaml", "yml", "ini", "conf", "cfg", "sql", "har", "html", "htm",
  "js", "jsx", "ts", "tsx", "py", "rs", "java", "go", "sh", "ps1",
]);
const FILE_PREVIEW_LIMIT = 32_000;
const TOTAL_PREVIEW_LIMIT = 80_000;

function normalizedExt(file: AgentAttachment): string {
  return (file.ext || path.extname(file.name)).replace(/^\./, "").toLowerCase();
}

/** Session-scoped attachment inventory. The model only receives safe metadata/previews. */
export class AttachmentRuntime {
  private files = new Map<string, AgentAttachment>();
  private current: AgentAttachment[] = [];

  constructor(
    private readonly allowedRoot: string,
    resumeAttachments: AgentAttachment[] = [],
  ) {
    this.remember(resumeAttachments);
  }

  remember(files: AgentAttachment[] = []): void {
    this.current = [];
    for (const file of files) {
      if (!file?.name || !file?.path || !path.isAbsolute(file.path)) continue;
      const resolvedPath = path.resolve(file.path);
      const relative = path.relative(this.allowedRoot, resolvedPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const normalized: AgentAttachment = {
        name: path.basename(file.name),
        path: resolvedPath,
        ext: normalizedExt(file),
        size: file.size,
      };
      this.files.set(normalized.path, normalized);
      this.current.push(normalized);
    }
  }

  list(): AgentAttachment[] {
    return [...this.files.values()];
  }

  async resolve(reference?: string): Promise<AgentAttachment | undefined> {
    const available = this.list();
    const requested = reference?.trim();
    let file: AgentAttachment | undefined;
    if (requested) {
      const resolved = path.isAbsolute(requested) ? path.resolve(requested) : "";
      file = available.find((item) => (
        item.path === resolved || item.name === requested || path.basename(item.path) === requested
      ));
      if (!file) throw new Error(`附件不在当前会话的受控列表中：${requested}`);
    } else if (this.current.length === 1) {
      file = this.current[0];
    }
    if (!file) return undefined;
    const info = await stat(file.path);
    if (!info.isFile()) throw new Error(`附件不是可读取文件：${file.name}`);
    file.size = info.size;
    return file;
  }

  async buildPrompt(message: string, attachments?: ConversationAttachments): Promise<string> {
    const incoming = attachments?.files ?? [];
    this.remember(incoming);
    if (incoming.length === 0) return message;
    if (this.current.length !== incoming.length) {
      throw new Error("附件路径不在 Nova 受控上传目录中，已拒绝交给 Agent 或 MCP。");
    }

    let remaining = TOTAL_PREVIEW_LIMIT;
    const sections: string[] = [];
    for (const file of this.current) {
      let info = "";
      try {
        const fileStat = await stat(file.path);
        file.size = fileStat.size;
        info = `${file.size} bytes`;
        if (TEXT_EXTENSIONS.has(normalizedExt(file)) && remaining > 0) {
          const raw = await readFile(file.path, "utf8");
          const limit = Math.min(FILE_PREVIEW_LIMIT, remaining);
          const preview = raw.slice(0, limit);
          remaining -= preview.length;
          info += `\n文本预览：\n${preview}${raw.length > preview.length ? "\n…（预览已截断）" : ""}`;
        }
      } catch (error) {
        info = `读取元数据失败：${error instanceof Error ? error.message : String(error)}`;
      }
      sections.push(`- ${file.name}（.${normalizedExt(file) || "unknown"}，${info}）`);
    }

    return `${message}\n\n[本轮附件]\n${sections.join("\n")}\n\n` +
      `请先结合对话判断用户目的。需要外部处理时，先调用 mcp 工具发现能力，再用 attachment 参数引用文件名；` +
      `不要猜测文件内容、远端路径或伪造工具结果。二进制内容由 Nova 在工具调用时安全传递。`;
  }
}
