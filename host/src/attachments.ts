import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ConversationAttachments } from "./rpc-protocol.js";

export type AgentAttachment = NonNullable<ConversationAttachments["files"]>[number];

function normalizedExt(file: AgentAttachment): string {
  return (file.ext || path.extname(file.name)).replace(/^\./, "").toLowerCase();
}

/** Session-scoped inventory. It only accepts files persisted below the Rust upload root. */
export class AttachmentRuntime {
  private files = new Map<string, AgentAttachment>();
  private current: AgentAttachment[] = [];

  constructor(private readonly allowedRoot: string, resumeAttachments: AgentAttachment[] = []) {
    this.remember(resumeAttachments);
  }

  remember(files: AgentAttachment[] = []): void {
    this.current = [];
    for (const file of files) {
      if (!file?.name || !file?.path || !path.isAbsolute(file.path)) continue;
      const resolvedPath = path.resolve(file.path);
      const relative = path.relative(this.allowedRoot, resolvedPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const normalized: AgentAttachment = { name: path.basename(file.name), path: resolvedPath, ext: normalizedExt(file), size: file.size };
      this.files.set(normalized.path, normalized);
      this.current.push(normalized);
    }
  }

  list(): AgentAttachment[] {
    return [...this.files.values()];
  }

  async resolve(reference?: string): Promise<AgentAttachment | undefined> {
    const requested = reference?.trim();
    let file: AgentAttachment | undefined;
    if (requested) {
      const resolved = path.isAbsolute(requested) ? path.resolve(requested) : "";
      const byPath = this.list().find((item) => item.path === resolved);
      const named = this.list().filter((item) => item.name === requested || path.basename(item.path) === requested);
      file = byPath ?? (named.length === 1 ? named[0] : undefined);
      if (!byPath && named.length > 1) throw new Error("attachment name is ambiguous; use document attachmentId");
      if (!file) throw new Error("attachment is not in the controlled session inventory");
    } else if (this.current.length === 1) file = this.current[0];
    if (!file) return undefined;
    await this.assertControlledRealPath(file.path);
    const info = await stat(file.path).catch(() => { throw new Error("controlled attachment is no longer available"); });
    if (!info.isFile()) throw new Error("controlled attachment is not a regular file");
    file.size = info.size;
    return file;
  }

  async resolvePath(knownPath: string): Promise<AgentAttachment | undefined> {
    const file = this.list().find((item) => item.path === knownPath);
    return file ? this.resolve(file.path) : undefined;
  }

  async readControlled(file: AgentAttachment): Promise<Buffer> {
    await this.assertControlledRealPath(file.path);
    const handle = await open(file.path, "r").catch(() => { throw new Error("controlled attachment is no longer available"); });
    try {
      await this.assertControlledRealPath(file.path);
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("controlled attachment is not a regular file");
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.size !== after.size || before.ino !== after.ino) throw new Error("controlled attachment changed while reading");
      return bytes;
    } finally { await handle.close(); }
  }

  private async assertControlledRealPath(candidate: string): Promise<void> {
    let root: string;
    let target: string;
    try {
      [root, target] = await Promise.all([realpath(this.allowedRoot), realpath(candidate)]);
    } catch { throw new Error("controlled attachment is no longer available"); }
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("attachment resolved outside the controlled upload directory");
  }

  /** Prompt injection intentionally contains metadata only; document controls all content escalation. */
  async buildPrompt(message: string, attachments?: ConversationAttachments): Promise<string> {
    const incoming = attachments?.files ?? [];
    this.remember(incoming);
    if (incoming.length === 0) return message;
    if (this.current.length !== incoming.length) throw new Error("attachment path is outside Nova's controlled upload directory");
    const rows: string[] = [];
    for (const file of this.current) {
      await this.assertControlledRealPath(file.path);
      const info = await stat(file.path).catch(() => { throw new Error("controlled attachment is no longer available"); });
      if (!info.isFile()) throw new Error(`attachment is not a readable file: ${file.name}`);
      file.size = info.size;
      rows.push(`- ${file.name} (${normalizedExt(file) || "unknown"}, ${file.size} bytes)`);
    }
    return `${message}\n\n[Current controlled attachments]\n${rows.join("\n")}\n\n` +
      "Acknowledged the controlled attachments above. Do NOT read, parse, OCR, or analyze them yet. " +
      "If the user's message already states a clear request for these files, proceed using the document tool in order (structure → built-in ocr → vision). " +
      "If the user only uploaded files without stating what to do, briefly confirm what they need first (e.g. 想让我对这些附件做什么？) and wait. " +
      "Never guess paths or file content; built-in OCR (智谱 GLM-OCR via document.ocr) runs automatically for images/scans, falling back to vision when unavailable or empty.";
  }
}
