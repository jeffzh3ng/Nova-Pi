import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { inspectAttachment } from "./attachment-processing.js";

test("built-in attachment processing reads text and extracts DOCX body", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-attachment-processing-"));
  try {
    const textPath = path.join(root, "notes.txt");
    writeFileSync(textPath, "受控附件文本", "utf8");
    const text = await inspectAttachment({ name: "notes.txt", path: textPath, ext: "txt" });
    assert.equal(text.parser, "text");
    assert.match(text.text, /受控附件文本/);

    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`);
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>加班工时结算与节假日补贴方案</w:t></w:r></w:p></w:body>
      </w:document>`);
    const docxPath = path.join(root, "proposal.docx");
    writeFileSync(docxPath, await zip.generateAsync({ type: "nodebuffer" }));
    const docx = await inspectAttachment({ name: "proposal.docx", path: docxPath, ext: "docx" });
    assert.equal(docx.parser, "docx");
    assert.match(docx.text, /加班工时结算与节假日补贴方案/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
