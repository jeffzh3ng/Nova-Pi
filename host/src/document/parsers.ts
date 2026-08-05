import { readFile, stat } from "node:fs/promises";
import mammoth from "mammoth";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import PDFParser, { type Output } from "pdf2json";
import type { AgentAttachment } from "../attachments.js";
import type { DocumentBlock, DocumentMetadata, DocumentReadOptions } from "./types.js";

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 1_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 120_000;
const ABSOLUTE_MAX_CHARS = 180_000;
const MAX_PDF_PAGES = 200;
const MAX_SELECTED_PAGES = 50;
const MAX_XLSX_ROWS = 10_000;
const MAX_XLSX_CELLS = 50_000;
const MAX_PPTX_SLIDES = 200;
/**
 * pdf2json 解析超时。扫描版 PDF（无文本层、仅图片 XObject）会让 pdf2json 既不触发
 * pdfParser_dataReady 也不触发 pdfParser_dataError，永久挂起。超时后销毁 parser 并
 * reject，让 document 工具的 read 阶段优雅失败、引导走 OCR/vision，而非永久卡死。
 */
export const PDF_PARSE_TIMEOUT_MS = 30_000;

const TEXT_EXTENSIONS = new Set([
  "txt", "log", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml",
  "yaml", "yml", "ini", "conf", "cfg", "sql", "har", "html", "htm",
  "js", "jsx", "ts", "tsx", "py", "rs", "java", "go", "sh", "ps1",
]);
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff"]);

type ParsedDocument = { blocks: DocumentBlock[]; metadata: DocumentMetadata; warnings: string[] };

function extOf(file: AgentAttachment): string {
  return file.ext.replace(/^\./, "").toLowerCase();
}

function textOf(node: Node | null | undefined): string {
  return node?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function safeXml(xml: string, label: string): Document {
  const parsed = new DOMParser({ errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} } }).parseFromString(xml, "application/xml");
  if (parsed.getElementsByTagName("parsererror").length > 0) throw new Error(`${label} XML is invalid`);
  return parsed;
}

function localName(node: Node): string {
  return (node as unknown as { localName?: string }).localName || node.nodeName.split(":").at(-1) || "";
}

function descendants(node: Node, name: string): Element[] {
  const result: Element[] = [];
  const visit = (current: Node): void => {
    for (let child = current.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === child.ELEMENT_NODE) {
        if (localName(child) === name) result.push(child as Element);
        visit(child);
      }
    }
  };
  visit(node);
  return result;
}

function clampChars(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CHARS;
  return Math.max(1_000, Math.min(Math.floor(value!), ABSOLUTE_MAX_CHARS));
}

/**
 * 安全解码 pdf2json 输出的 URL 编码文本。
 * pdf2json 把 PDF 文本流的字节按 %-encoding 编码进 run.T，但部分 PDF 的字体编码
 * 异常（如自定义 Type1/CID 字体）会产生不合法的转义序列（% 后非 hex、孤立 %），
 * 导致 decodeURIComponent 抛 URIError。这里回退到原始字符串，避免整篇解析失败。
 */
function safeDecodePdfText(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // 含非法 % 转义时，逐段解码：把孤立的 % 还原，再尝试。
    try {
      return value.replace(/%(?![0-9A-Fa-f]{2})/g, "%25").split(/(%[0-9A-Fa-f]{2}|[^%]+)/).map((segment) => {
        try { return decodeURIComponent(segment); } catch { return segment; }
      }).join("");
    } catch {
      return value;
    }
  }
}

function zipEntrySize(entry: JSZip.JSZipObject): number {
  const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof data?.uncompressedSize === "number" ? data.uncompressedSize : 0;
}

async function openSafeZip(file: AgentAttachment, bytes?: Buffer): Promise<{ zip: JSZip; entries: number }> {
  const zip = await JSZip.loadAsync(bytes ?? await readFile(file.path), { createFolders: false, checkCRC32: false });
  const objects = Object.values(zip.files);
  if (objects.length > MAX_ZIP_ENTRIES) throw new Error(`OOXML entry count exceeds ${MAX_ZIP_ENTRIES}`);
  let uncompressed = 0;
  for (const entry of objects) {
    if (entry.name.startsWith("/") || entry.name.split("/").some((part) => part === "..")) {
      throw new Error("OOXML contains an unsafe entry path");
    }
    uncompressed += zipEntrySize(entry);
    if (uncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) throw new Error("OOXML uncompressed size exceeds 50 MB");
  }
  return { zip, entries: objects.length };
}

async function zipText(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) return "";
  const size = zipEntrySize(entry);
  if (size > MAX_ZIP_UNCOMPRESSED_BYTES) throw new Error(`${name} exceeds safe extraction size`);
  return entry.async("text");
}

/**
 * 用 pdf2json 解析 PDF（带超时）。扫描版 PDF 会让 pdf2json 永久挂起，故强制加超时：
 * 超过 {@link PDF_PARSE_TIMEOUT_MS} 仍未 ready/error 时销毁 parser 并 reject。
 * 同时响应外部 abort signal（document 工具被取消时立即终止解析）。
 * 导出供 ocr-client 的 countPdfPages 复用，避免两处重复实现且各自漏超时。
 */
export function parsePdfWithTimeout(bytes: Buffer, signal?: AbortSignal, timeoutMs = PDF_PARSE_TIMEOUT_MS): Promise<Output> {
  signal?.throwIfAborted();
  return new Promise<Output>((resolve, reject) => {
    const parser = new PDFParser(null, false);
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      parser.removeAllListeners();
    };
    const onAbort = () => { cleanup(); parser.destroy(); reject(new Error("document parsing aborted")); };
    const timer = setTimeout(() => {
      cleanup();
      parser.destroy();
      reject(new Error(`PDF 结构解析超时（${timeoutMs / 1000}s）——可能是扫描版或损坏文件，请改用 OCR`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    parser.once("pdfParser_dataReady", (result: Output) => { cleanup(); parser.destroy(); resolve(result); });
    parser.once("pdfParser_dataError", () => { cleanup(); parser.destroy(); reject(new Error("PDF structure could not be read")); });
    parser.parseBuffer(bytes, 0);
  });
}

async function parsePdf(file: AgentAttachment, options: DocumentReadOptions): Promise<ParsedDocument> {
  options.signal?.throwIfAborted();
  if (options.pages && options.pages.length > MAX_SELECTED_PAGES) throw new Error("too many selected PDF pages");
  const bytes = options.bytes ?? await readFile(file.path);
  const data = await parsePdfWithTimeout(bytes, options.signal);
  if (data.Pages.length > MAX_PDF_PAGES) throw new Error(`PDF page count exceeds ${MAX_PDF_PAGES}`);
  const wanted = options.pages?.length ? new Set(options.pages) : undefined;
  if (wanted && [...wanted].some((page) => page > data.Pages.length)) throw new Error("selected PDF page does not exist");
  const blocks: DocumentBlock[] = [];
  for (let pageNumber = 1; pageNumber <= data.Pages.length; pageNumber += 1) {
    if (wanted && !wanted.has(pageNumber)) continue;
    const text = data.Pages[pageNumber - 1].Texts
      .flatMap((item) => item.R.map((run) => safeDecodePdfText(run.T)))
      .join(" ").trim();
    blocks.push({ type: "page", index: pageNumber, text });
  }
  return { blocks, metadata: { bytes: file.size ?? bytes.length, pages: data.Pages.length }, warnings: [] };
}

async function parseXlsx(file: AgentAttachment, options: DocumentReadOptions): Promise<ParsedDocument> {
  const { zip, entries } = await openSafeZip(file, options.bytes);
  const workbook = safeXml(await zipText(zip, "xl/workbook.xml"), "workbook");
  const rels = safeXml(await zipText(zip, "xl/_rels/workbook.xml.rels"), "workbook relationships");
  const relMap = new Map<string, string>();
  for (const relationship of descendants(rels, "Relationship")) {
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");
    if (id && target && !target.includes("://") && !target.startsWith("/")) relMap.set(id, target.replace(/^\//, ""));
  }
  const sharedXml = await zipText(zip, "xl/sharedStrings.xml");
  const shared = sharedXml ? descendants(safeXml(sharedXml, "shared strings"), "si").map((node) => descendants(node, "t").map(textOf).join("")) : [];
  const requested = options.sheetNames?.length ? new Set(options.sheetNames) : undefined;
  const blocks: DocumentBlock[] = [];
  const sheetNodes = descendants(workbook, "sheet");
  if (!sheetNodes.length) throw new Error("workbook contains no sheets");
  for (let i = 0; i < sheetNodes.length; i += 1) {
    const sheet = sheetNodes[i];
    const name = sheet.getAttribute("name") || `Sheet${i + 1}`;
    if (requested && !requested.has(name)) continue;
    const relId = sheet.getAttribute("r:id") || sheet.getAttribute("id") || "";
    const target = relMap.get(relId);
    if (!target) continue;
    const sheetPath = target.startsWith("xl/") ? target : `xl/${target.replace(/^\.\//, "")}`;
    const xml = await zipText(zip, sheetPath);
    if (!xml) continue;
    const rows: string[] = [];
    const rowsInSheet = descendants(safeXml(xml, name), "row");
    if (rowsInSheet.length > MAX_XLSX_ROWS) throw new Error("worksheet row limit exceeded");
    let cellCount = 0;
    for (const row of rowsInSheet) {
      const cells: string[] = [];
      for (const cell of descendants(row, "c")) {
        cellCount += 1;
        if (cellCount > MAX_XLSX_CELLS) throw new Error("worksheet cell limit exceeded");
        const ref = cell.getAttribute("r") || "?";
        const kind = cell.getAttribute("t");
        const raw = textOf(descendants(cell, "v")[0]);
        const inline = descendants(cell, "is")[0];
        const value = kind === "s" ? (shared[Number(raw)] ?? "") : (inline ? descendants(inline, "t").map(textOf).join("") : raw);
        const formula = options.includeFormulas ? textOf(descendants(cell, "f")[0]) : "";
        if (value || formula) cells.push(`${ref}=${value}${formula ? ` [formula: ${formula}]` : ""}`);
      }
      if (cells.length) rows.push(cells.join(" | "));
    }
    blocks.push({ type: "sheet", index: i + 1, name, text: rows.join("\n") });
  }
  return { blocks, metadata: { bytes: file.size ?? 0, sheets: sheetNodes.length, zipEntries: entries }, warnings: [] };
}

async function parsePptx(file: AgentAttachment, options: DocumentReadOptions): Promise<ParsedDocument> {
  const { zip, entries } = await openSafeZip(file, options.bytes);
  const presentation = safeXml(await zipText(zip, "ppt/presentation.xml"), "presentation");
  const rels = safeXml(await zipText(zip, "ppt/_rels/presentation.xml.rels"), "presentation relationships");
  const relMap = new Map(descendants(rels, "Relationship").map((node) => [node.getAttribute("Id") || "", node.getAttribute("Target") || ""]));
  const slides = descendants(presentation, "sldId").map((node) => {
    const id = node.getAttribute("r:id") || node.getAttribute("id") || "";
    const target = relMap.get(id) || "";
    if (!target || target.includes("://") || target.startsWith("/") || target.split("/").includes("..")) throw new Error("presentation slide relationship is invalid");
    return `ppt/${target.replace(/^\.\//, "")}`;
  });
  if (!slides.length) throw new Error("presentation contains no slides");
  if (slides.length > MAX_PPTX_SLIDES) throw new Error("presentation slide limit exceeded");
  const wanted = options.slideNumbers?.length ? new Set(options.slideNumbers) : undefined;
  const blocks: DocumentBlock[] = [];
  for (let index = 0; index < slides.length; index += 1) {
    const number = index + 1;
    if (wanted && !wanted.has(number)) continue;
    const slidePath = slides[index];
    const body = descendants(safeXml(await zipText(zip, slidePath), `slide ${number}`), "t").map(textOf).filter(Boolean).join("\n");
    let notes = "";
    if (options.includeNotes) {
      const leaf = slidePath.split("/").at(-1) || "";
      const relPath = `ppt/slides/_rels/${leaf}.rels`;
      const slideRels = await zipText(zip, relPath);
      const notesTarget = slideRels
        ? descendants(safeXml(slideRels, `slide ${number} relationships`), "Relationship")
          .find((node) => (node.getAttribute("Type") || "").endsWith("notesSlide"))?.getAttribute("Target")
        : undefined;
      if (notesTarget && (notesTarget.includes("://") || notesTarget.startsWith("/") || notesTarget.split("/").filter(Boolean).some((part) => part === ".." && notesTarget.split("/").filter(Boolean).filter((candidate) => candidate === "..").length > 1))) throw new Error("slide notes relationship is invalid");
      const notesPath = notesTarget ? `ppt/slides/${notesTarget}`.replace("ppt/slides/../", "ppt/") : "";
      const notesXml = notesPath ? await zipText(zip, notesPath) : "";
      if (notesXml) notes = descendants(safeXml(notesXml, `notes ${number}`), "t").map(textOf).filter(Boolean).join("\n");
    }
    blocks.push({ type: "slide", index: number, text: notes ? `${body}\n\n[Notes]\n${notes}` : body });
  }
  return { blocks, metadata: { bytes: file.size ?? 0, slides: slides.length, zipEntries: entries }, warnings: [] };
}

export async function parseStructuredDocument(file: AgentAttachment, options: DocumentReadOptions): Promise<ParsedDocument> {
  options.signal?.throwIfAborted();
  const info = options.bytes ? { isFile: () => true, size: options.bytes.length } : await stat(file.path);
  if (!info.isFile()) throw new Error("attachment is not a readable file");
  file.size = info.size;
  if (info.size > MAX_DOCUMENT_BYTES) throw new Error("attachment exceeds local parsing limit of 25 MB");
  const ext = extOf(file);
  if (TEXT_EXTENSIONS.has(ext)) return { blocks: [{ type: "text", text: (options.bytes ?? await readFile(file.path)).toString("utf8").replace(/\u0000/g, "").trim() }], metadata: { bytes: info.size }, warnings: [] };
  if (ext === "docx") {
    const bytes = options.bytes ?? await readFile(file.path);
    const { entries } = await openSafeZip(file, bytes);
    const result = await mammoth.extractRawText({ buffer: bytes });
    return { blocks: [{ type: "text", text: result.value.replace(/\u0000/g, "").trim() }], metadata: { bytes: info.size, zipEntries: entries }, warnings: result.messages.map((message) => message.message) };
  }
  if (ext === "pdf") return parsePdf(file, options);
  if (ext === "xlsx") return parseXlsx(file, options);
  if (ext === "pptx") return parsePptx(file, options);
  throw new Error(`unsupported structured format: ${ext || "unknown"}`);
}

export function limitBlocks(blocks: DocumentBlock[], maxChars: number): { blocks: DocumentBlock[]; truncated: boolean } {
  let remaining = clampChars(maxChars);
  let truncated = false;
  const limited: DocumentBlock[] = [];
  for (const block of blocks) {
    if (remaining <= 0) { truncated = true; break; }
    const text = block.text.slice(0, remaining);
    if (text.length < block.text.length) truncated = true;
    remaining -= text.length;
    limited.push({ ...block, text });
  }
  return { blocks: limited, truncated };
}
