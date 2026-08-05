import { createHash } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { AgentAttachment, AttachmentRuntime } from "../attachments.js";
import { IMAGE_EXTENSIONS } from "./parsers.js";
import type { OcrClient, OcrOutcome } from "./ocr-client.js";
import type { DocumentStage } from "./types.js";

const MAX_VISION_IMAGES = 4;
const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VISION_TOTAL_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

function imageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export type DocumentAttachment = AgentAttachment & { id: string };

type State = { stage: DocumentStage; ocrResult?: "success" | "empty" | "failed" | "unavailable" };
type PdfPageArtifact = { id: string; name: string; path: string; ext: string; size: number; sourcePdfId: string; sha256: string };

function extOf(file: AgentAttachment): string {
  return file.ext.replace(/^\./, "").toLowerCase();
}

function attachmentId(file: AgentAttachment): string {
  return createHash("sha256").update(file.path).digest("hex").slice(0, 16);
}

/** A session-level state machine layered on the existing controlled-upload runtime. */
export class DocumentRuntime {
  private states = new Map<string, State>();
  private pdfPages = new Map<string, PdfPageArtifact>();
  private modelSupportsImages: boolean;

  constructor(
    private readonly attachments: AttachmentRuntime,
    supportsImages = false,
    private readonly artifactReader?: (path: string) => Promise<Buffer>,
    private readonly ocrClient?: OcrClient,
  ) {
    this.modelSupportsImages = supportsImages;
  }

  setVisionSupported(supported: boolean): void {
    this.modelSupportsImages = supported;
  }

  supportsVision(): boolean {
    return this.modelSupportsImages;
  }

  hasOcrKey(): boolean {
    return this.ocrClient?.isConfigured() ?? false;
  }

  list(): DocumentAttachment[] {
    return this.attachments.list().map((file) => ({ ...file, id: attachmentId(file) }));
  }

  async resolve(reference?: string): Promise<DocumentAttachment | undefined> {
    const value = reference?.trim();
    if (!value) {
      const files = this.list();
      if (files.length !== 1) return undefined;
      const file = await this.attachments.resolvePath(files[0].path);
      return file ? { ...file, id: attachmentId(file) } : undefined;
    }
    const listed = this.list().find((file) => file.id === value)
      ?? (() => { const matches = this.list().filter((file) => file.name === value); return matches.length === 1 ? matches[0] : undefined; })();
    if (!listed) throw new Error("attachment is not in the controlled session inventory");
    const file = await this.attachments.resolvePath(listed.path);
    return file ? { ...file, id: attachmentId(file) } : undefined;
  }

  readBytes(file: DocumentAttachment): Promise<Buffer> { return this.attachments.readControlled(file); }

  stage(file: DocumentAttachment): DocumentStage {
    return this.states.get(file.id)?.stage ?? "structure";
  }

  markNeedsOcr(file: DocumentAttachment): void {
    this.states.set(file.id, { stage: "ocr" });
  }

  /** 内置 OCR 统一入口：未配置 key→unavailable；已配置→调智谱 API；任意结果都推进状态机。 */
  async runOcr(file: DocumentAttachment, signal?: AbortSignal): Promise<OcrOutcome> {
    if (!this.ocrClient) return { status: "unavailable", text: "", warning: "内置 OCR 未启用。" };
    const bytes = await this.readBytes(file);
    const outcome = await this.ocrClient.runOcr(file, bytes, signal);
    this.recordOcr(file, outcome.status === "unavailable" ? "unavailable" : outcome.status);
    return outcome;
  }

  recordOcr(file: DocumentAttachment, result: "success" | "empty" | "failed" | "unavailable"): void {
    // success → structure（已有文本，无需升级）；empty/failed/unavailable → vision（兜底）
    this.states.set(file.id, { stage: result === "success" ? "structure" : "vision", ocrResult: result });
  }

  async registerPdfPageArtifacts(pdf: DocumentAttachment, artifacts: Array<{ name: string; path: string; ext: string; size?: number }>): Promise<string[]> {
    if (!this.isPdf(pdf)) return [];
    if (!this.artifactReader) return [];
    const registered: string[] = [];
    for (const artifact of artifacts) {
      const ext = artifact.ext.toLowerCase();
      const bytes = await this.artifactReader(artifact.path).catch(() => undefined);
      const mime = bytes ? imageMime(bytes) : undefined;
      if (!bytes || !mime || IMAGE_MIME_BY_EXTENSION[ext] !== mime || bytes.length > MAX_VISION_IMAGE_BYTES) continue;
      const id = createHash("sha256").update(`${pdf.id}:${artifact.path}`).digest("hex").slice(0, 20);
      this.pdfPages.set(id, { ...artifact, id, sourcePdfId: pdf.id, ext, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      registered.push(id);
    }
    return registered;
  }

  resolvePdfPages(pdf: DocumentAttachment, ids: string[]): PdfPageArtifact[] | undefined {
    const pages = ids.map((id) => this.pdfPages.get(id));
    return pages.every((page) => page?.sourcePdfId === pdf.id) ? pages as PdfPageArtifact[] : undefined;
  }

  canUseVision(file: DocumentAttachment): boolean {
    return this.states.get(file.id)?.stage === "vision";
  }

  isImage(file: DocumentAttachment): boolean {
    return IMAGE_EXTENSIONS.has(extOf(file));
  }

  isPdf(file: DocumentAttachment): boolean {
    return extOf(file) === "pdf";
  }

  async imageContent(files: Array<DocumentAttachment | PdfPageArtifact>): Promise<ImageContent[]> {
    if (!this.modelSupportsImages) return [];
    const content: ImageContent[] = [];
    let totalBytes = 0;
    for (const file of files.slice(0, MAX_VISION_IMAGES)) {
      const declaredMime = IMAGE_MIME_BY_EXTENSION[file.ext.replace(/^\./, "").toLowerCase()];
      if (!declaredMime) throw new Error("vision accepts only PNG, JPEG, GIF, or WebP controlled image attachments");
      const artifact = "sourcePdfId" in file;
      const bytes = artifact ? await this.artifactReader?.(file.path) : await this.attachments.readControlled(file);
      if (!bytes) throw new Error("generated image artifact is unavailable");
      if (artifact && createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("generated image artifact changed after registration");
      if (bytes.length === 0 || bytes.length > MAX_VISION_IMAGE_BYTES) {
        throw new Error("vision image must be a non-empty controlled file no larger than 10 MB");
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_VISION_TOTAL_BYTES) throw new Error("vision image total exceeds 25 MB");
      const mimeType = imageMime(bytes);
      if (!mimeType || mimeType !== declaredMime) throw new Error("controlled image bytes do not match the declared format");
      content.push({ type: "image", data: bytes.toString("base64"), mimeType });
    }
    return content;
  }
}
