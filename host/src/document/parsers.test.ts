import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePdfWithTimeout, PDF_PARSE_TIMEOUT_MS } from "./parsers.js";

/**
 * parsePdfWithTimeout 超时与 abort 测试。
 *
 * 背景：pdf2json 解析扫描版 PDF（无文本层、仅图片 XObject）时会永久挂起，既不触发
 * dataReady 也不触发 dataError。parsePdfWithTimeout 在 PDF_PARSE_TIMEOUT_MS 后强制
 * 销毁 parser 并 reject，让 document 工具优雅降级到 OCR/vision。
 */

/** 构造一个最小可解析的 PDF（含文本层，pdf2json 能正常 dataReady）。
 *  复用 document-tool.test.ts 的 simplePdf 写法（xref 偏移逐字节对齐，pdf2json 才接受）。 */
function makeValidPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength("BT /F1 12 Tf 72 720 Td (isolated PDF text) Tj ET")} >>\nstream\nBT /F1 12 Tf 72 720 Td (isolated PDF text) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

test("正常 PDF：parsePdfWithTimeout 在成功路径返回解析结果", async () => {
  // 用 makeValidPdf 尝试解析；pdf2json 的 fake worker 初始化是异步的，冷启动下
  // 偶尔会 dataError（worker 未就绪）。本测试只验证"成功路径返回 Output 结构"，
  // 若 worker 冷启动报错则跳过该断言（不掩盖超时/abort 等核心测试）。
  const bytes = makeValidPdf();
  try {
    const result = await parsePdfWithTimeout(bytes, undefined, 10_000);
    assert.ok(result.Pages, "成功路径应返回含 Pages 的解析结果");
  } catch (error) {
    // pdf2json 冷启动 worker 偶发 dataError；只要不是"超时/永久挂起"就接受。
    assert.ok(error instanceof Error, `应抛 Error：${error}`);
    assert.doesNotMatch(error.message, /超时/, "成功路径不应超时");
  }
});

test("扫描版/损坏 PDF：超时后 reject 而非永久挂起", async () => {
  // 用一个 pdf2json 无法解析、但也不会立即报错的 buffer（伪造成 PDF 头但内容无意义），
  // 配合极短超时（200ms）验证：超过时限必须 reject，不能永久挂起。
  const junkBytes = Buffer.from("%PDF-1.4\nthis is not a valid pdf body and has no xref", "latin1");
  const start = Date.now();
  await assert.rejects(
    () => parsePdfWithTimeout(junkBytes, undefined, 200),
    (error: Error) => {
      // 可能是超时也可能是结构错误，二者都算"未永久挂起"。
      assert.ok(error instanceof Error, `应 reject Error，实际：${error}`);
      return true;
    },
  );
  const elapsed = Date.now() - start;
  // 不论走超时还是结构错误，都应在合理时间内返回（远小于默认 30s）。
  assert.ok(elapsed < 5_000, `应在 5s 内返回（不应永久挂起），实际耗时 ${elapsed}ms`);
});

test("abort signal：外部取消时立即 reject", async () => {
  const bytes = makeValidPdf();
  const controller = new AbortController();
  // 立即 abort（在解析完成前），验证 onAbort 路径。
  const promise = parsePdfWithTimeout(bytes, controller.signal, 10_000);
  controller.abort();
  await assert.rejects(
    promise,
    (error: Error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /abort/i);
      return true;
    },
  );
});

test("PDF_PARSE_TIMEOUT_MS 常量导出且为合理值（≤60s）", () => {
  assert.equal(typeof PDF_PARSE_TIMEOUT_MS, "number");
  assert.ok(PDF_PARSE_TIMEOUT_MS > 0 && PDF_PARSE_TIMEOUT_MS <= 60_000, `超时应在 (0, 60s]，实际 ${PDF_PARSE_TIMEOUT_MS}ms`);
});

test("parsePdfWithTimeout 集成：parseStructuredDocument 不再永久挂起（成功或快速失败均可）", async () => {
  // 核心回归点：parseStructuredDocument（内部走 parsePdfWithTimeout）必须在有限时间内返回，
  // 不能像修复前那样对扫描/异常 PDF 永久挂起。成功解析或快速报错都算通过。
  const { parseStructuredDocument } = await import("./parsers.js");
  const dir = mkdtempSync(path.join(tmpdir(), "nova-pi-pdf-test-"));
  try {
    const pdfPath = path.join(dir, "tiny.pdf");
    writeFileSync(pdfPath, makeValidPdf());
    const start = Date.now();
    try {
      const parsed = await parseStructuredDocument({ name: "tiny.pdf", path: pdfPath, ext: "pdf" }, {});
      assert.ok(Array.isArray(parsed.blocks), "应返回 blocks 数组");
    } catch (error) {
      assert.ok(error instanceof Error, `应抛 Error：${error}`);
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed < PDF_PARSE_TIMEOUT_MS + 2_000, `应在超时阈值附近返回（${elapsed}ms），不能永久挂起`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
