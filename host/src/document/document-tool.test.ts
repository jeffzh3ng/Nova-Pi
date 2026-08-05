import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { AttachmentRuntime } from "../attachments.js";
import { DocumentRuntime } from "./document-runtime.js";
import { createDocumentExtension } from "./document-tool.js";
import { ImageArtifactStore } from "../mcp/image-artifacts.js";
import type { OcrClient, OcrOutcome } from "./ocr-client.js";

type Execute = ((id: string, input: Record<string, unknown>) => Promise<{ details: { status: string; stage: string; attachmentId?: string; blocks?: Array<{ text: string }>; files?: Array<{ attachmentId: string }> } }>) & { documents?: DocumentRuntime };

/** 可控的 mock OCR：构造时指定每次 runOcr 的返回值。 */
function mockOcr(outcome: OcrOutcome): OcrClient {
  return {
    isConfigured: () => outcome.status !== "unavailable" || outcome.warning !== "no key",
    runOcr: async () => outcome,
  };
}

async function toolFor(root: string, files: Array<{ name: string; path: string; ext: string }>, vision = true, ocr?: OcrClient): Promise<Execute> {
  const attachments = new AttachmentRuntime(root);
  await attachments.buildPrompt("read", { files });
  const artifactStore = new ImageArtifactStore(root);
  const runtime = new DocumentRuntime(attachments, vision, (artifactPath) => artifactStore.readArtifact(artifactPath), ocr);
  let execute: Execute | undefined;
  const extension = createDocumentExtension(runtime) as unknown as { factory: (pi: { registerTool: (tool: { execute: Execute }) => void }) => void };
  extension.factory({ registerTool: (tool) => { execute = tool.execute; } });
  assert.ok(execute);
  execute.documents = runtime;
  return execute;
}

function simplePdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`)} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

test("document runs built-in OCR for images and escalates to vision on failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-document-"));
  try {
    const image = path.join(root, "scan.png");
    writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    // 1) OCR 成功：ocr action 直接返回 complete + 文本
    const ok = await toolFor(root, [{ name: "scan.png", path: image, ext: "png" }], true, mockOcr({ status: "success", text: "告警时间 12:30" }));
    const listed = await ok("1", { action: "list" });
    const id = listed.details.files?.[0]?.attachmentId;
    const read = await ok("2", { action: "read", name: "scan.png" });
    assert.equal(read.details.status, "needs_ocr");
    assert.equal(read.details.stage, "ocr");
    const ocrOk = await ok("3", { action: "ocr", name: "scan.png" });
    assert.equal(ocrOk.details.status, "complete");
    assert.match(ocrOk.details.blocks?.[0]?.text ?? "", /告警时间 12:30/);
    // 没配 key / OCR 无果 → vision 被允许（兜底）
    const fail = await toolFor(root, [{ name: "scan.png", path: image, ext: "png" }], true, mockOcr({ status: "failed", text: "", warning: "HTTP 500" }));
    await fail("read", { action: "read", name: "scan.png" });
    assert.equal((await fail("ocr", { action: "ocr", name: "scan.png" })).details.status, "needs_vision");
    assert.equal((await fail("vision", { action: "vision", name: "scan.png" })).details.status, "complete");
    // 未配置 key：ocr 返回 needs_vision（降级），vision 兜底
    const noKey = await toolFor(root, [{ name: "scan.png", path: image, ext: "png" }], true, mockOcr({ status: "unavailable", text: "", warning: "no key" }));
    await noKey("read", { action: "read", name: "scan.png" });
    assert.equal((await noKey("ocr", { action: "ocr", name: "scan.png" })).details.status, "needs_vision");
    // vision 不能跳过 ocr
    const jump = await toolFor(root, [{ name: "scan.png", path: image, ext: "png" }], true, mockOcr({ status: "success", text: "x" }));
    assert.equal((await jump("jump", { action: "vision", name: "scan.png" })).details.status, "rejected");
    assert.match(id ?? "", /^[a-f0-9]{16}$/);
    assert.doesNotMatch(JSON.stringify(ocrOk), new RegExp(root.replace(/\\/g, "\\\\")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("document extracts XLSX sheets/formulas and PPTX body/notes without Office", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-document-office-"));
  try {
    const xlsx = new JSZip();
    xlsx.file("xl/workbook.xml", `<workbook xmlns:r="r"><sheets><sheet name="Budget" r:id="rId1"/></sheets></workbook>`);
    xlsx.file("xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`);
    xlsx.file("xl/worksheets/sheet1.xml", `<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Total</t></is></c><c r="B1"><f>SUM(B2:B3)</f><v>3</v></c></row></sheetData></worksheet>`);
    const xlsxPath = path.join(root, "budget.xlsx"); writeFileSync(xlsxPath, await xlsx.generateAsync({ type: "nodebuffer" }));
    const pptx = new JSZip();
    pptx.file("ppt/presentation.xml", `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rId2"/></p:sldIdLst></p:presentation>`);
    pptx.file("ppt/_rels/presentation.xml.rels", `<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>`);
    pptx.file("ppt/slides/slide1.xml", `<p:sld xmlns:p="p"><p:t>Quarterly review</p:t></p:sld>`);
    pptx.file("ppt/slides/_rels/slide1.xml.rels", `<Relationships><Relationship Type="notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`);
    pptx.file("ppt/notesSlides/notesSlide1.xml", `<p:notes xmlns:p="p"><p:t>speaker note</p:t></p:notes>`);
    const pptxPath = path.join(root, "review.pptx"); writeFileSync(pptxPath, await pptx.generateAsync({ type: "nodebuffer" }));
    const execute = await toolFor(root, [{ name: "budget.xlsx", path: xlsxPath, ext: "xlsx" }, { name: "review.pptx", path: pptxPath, ext: "pptx" }]);
    const sheet = await execute("1", { action: "read", name: "budget.xlsx", includeFormulas: true });
    assert.equal(sheet.details.status, "complete");
    assert.match(sheet.details.blocks?.[0]?.text ?? "", /SUM\(B2:B3\)/);
    const slides = await execute("2", { action: "read", name: "review.pptx", includeNotes: true });
    assert.match(slides.details.blocks?.[0]?.text ?? "", /speaker note/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("duplicate filenames require attachmentId and resolve the correct controlled file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-document-duplicate-"));
  try {
    const left = path.join(root, "left"); const right = path.join(root, "right"); mkdirSync(left); mkdirSync(right);
    const first = path.join(left, "notes.txt"); const second = path.join(right, "notes.txt");
    writeFileSync(first, "first", "utf8"); writeFileSync(second, "second", "utf8");
    const execute = await toolFor(root, [{ name: "notes.txt", path: first, ext: "txt" }, { name: "notes.txt", path: second, ext: "txt" }]);
    const listed = await execute("list", { action: "list" });
    assert.equal((await execute("ambiguous", { action: "read", name: "notes.txt" })).details.status, "rejected");
    const result = await execute("id", { action: "read", attachmentId: listed.details.files?.[1]?.attachmentId });
    assert.match(result.details.blocks?.[0]?.text ?? "", /second/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("document extracts PDF text and page count without rasterizing pages", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-document-pdf-"));
  try {
    const pdf = path.join(root, "brief.pdf"); writeFileSync(pdf, simplePdf("PDF evidence"));
    const execute = await toolFor(root, [{ name: "brief.pdf", path: pdf, ext: "pdf" }]);
    const result = await execute("1", { action: "read", name: "brief.pdf", pages: [1] });
    assert.equal(result.details.status, "complete");
    assert.match(result.details.blocks?.[0]?.text ?? "", /PDF evidence/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scanned PDF requires built-in OCR then explicit controlled page images for vision", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-document-scanned-pdf-"));
  try {
    const pdf = path.join(root, "scan.pdf"); writeFileSync(pdf, simplePdf(""));
    const page = path.join(root, "scan-page-1.png"); writeFileSync(page, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const execute = await toolFor(root, [{ name: "scan.pdf", path: pdf, ext: "pdf" }, { name: "scan-page-1.png", path: page, ext: "png" }], true, mockOcr({ status: "empty", text: "", warning: "no text" }));
    const listed = await execute("1", { action: "list" });
    const pageId = listed.details.files?.[1]?.attachmentId;
    const read = await execute("2", { action: "read", name: "scan.pdf" });
    assert.equal(read.details.status, "needs_ocr");
    // vision 在 OCR 之前直接调用被拒
    assert.equal((await execute("3", { action: "vision", name: "scan.pdf", pageImageAttachmentIds: [pageId] })).details.status, "rejected");
    // 内置 OCR 返回 empty → needs_vision
    assert.equal((await execute("4", { action: "ocr", name: "scan.pdf" })).details.status, "needs_vision");
    // 未注册页面图 → vision 不支持
    assert.equal((await execute("5", { action: "vision", name: "scan.pdf" })).details.status, "unsupported");
    assert.equal((await execute("6", { action: "vision", name: "scan.pdf", pageImageAttachmentIds: [pageId] })).details.status, "unsupported");
    // 注册受控页面图后 vision 成功
    const pdfAttachment = await execute.documents?.resolve("scan.pdf"); assert.ok(pdfAttachment);
    const pageAttachment = await execute.documents?.resolve("scan-page-1.png"); assert.ok(pageAttachment);
    const artifactId = (await execute.documents?.registerPdfPageArtifacts(pdfAttachment, [pageAttachment]))?.[0];
    assert.equal((await execute("7", { action: "vision", name: "scan.pdf", pageImageAttachmentIds: [artifactId] })).details.status, "complete");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PDF that fails embedded parsing routes to built-in OCR instead of suggesting external MCP", async () => {
  // 用损坏的 PDF 字节触发 pdfParser_dataError，验证 read 不再返回 "external MCP"，
  // 而是标记 needs_ocr 并引导调内置 ocr。
  const root = mkdtempSync(path.join(tmpdir(), "nova-document-broken-pdf-"));
  try {
    const brokenPdf = path.join(root, "broken.pdf");
    writeFileSync(brokenPdf, Buffer.from("%PDF-1.4\nnot a real pdf body\n%%EOF"));
    const execute = await toolFor(root, [{ name: "broken.pdf", path: brokenPdf, ext: "pdf" }], true, mockOcr({ status: "success", text: "OCR recovered text" }));
    const read = await execute("1", { action: "read", name: "broken.pdf" });
    assert.equal(read.details.status, "needs_ocr");
    assert.equal(read.details.stage, "ocr");
    // next 引导词必须指向内置 ocr，绝不能出现 external MCP 字样
    assert.match(JSON.stringify(read), /ocr action/);
    assert.doesNotMatch(JSON.stringify(read), /external MCP/i);
    const ocr = await execute("2", { action: "ocr", name: "broken.pdf" });
    assert.equal(ocr.details.status, "complete");
    assert.match(ocr.details.blocks?.[0]?.text ?? "", /OCR recovered text/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("PDF page artifacts use the separate generated-image store and reject post-registration replacement", async () => {
  const uploads = mkdtempSync(path.join(tmpdir(), "nova-document-uploads-")); const generated = mkdtempSync(path.join(tmpdir(), "nova-document-generated-"));
  try {
    const pdfPath = path.join(uploads, "scan.pdf"); writeFileSync(pdfPath, simplePdf(""));
    const attachments = new AttachmentRuntime(uploads); await attachments.buildPrompt("read", { files: [{ name: "scan.pdf", path: pdfPath, ext: "pdf" }] });
    const store = new ImageArtifactStore(generated); const runtime = new DocumentRuntime(attachments, true, (artifactPath) => store.readArtifact(artifactPath));
    const pdf = await runtime.resolve("scan.pdf"); assert.ok(pdf);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const persisted = await store.persistFromMcpResult({ images: [{ data: png.toString("base64"), mimeType: "image/png" }] }, "pdf-page");
    const ids = await runtime.registerPdfPageArtifacts(pdf, persisted.artifacts); assert.equal(ids.length, 1);
    runtime.markNeedsOcr(pdf); runtime.recordOcr(pdf, "failed");
    const pages = runtime.resolvePdfPages(pdf, ids); assert.ok(pages);
    assert.equal((await runtime.imageContent(pages)).length, 1);
    writeFileSync(persisted.artifacts[0].path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
    await assert.rejects(runtime.imageContent(pages), /changed/);
  } finally { rmSync(uploads, { recursive: true, force: true }); rmSync(generated, { recursive: true, force: true }); }
});
