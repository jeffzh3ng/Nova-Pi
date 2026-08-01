import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AttachmentRuntime } from "./attachments.js";

test("attachment runtime previews safe text and retains controlled files", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-attachments-root-"));
  try {
    const filePath = path.join(root, "sample.txt");
    writeFileSync(filePath, "hello attachment", "utf8");
    const runtime = new AttachmentRuntime(root);
    const prompt = await runtime.buildPrompt("分析附件", {
      files: [{ name: "sample.txt", path: filePath, ext: "txt", size: 16 }],
    });
    assert.match(prompt, /hello attachment/);
    assert.equal((await runtime.resolve("sample.txt"))?.path, filePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attachment runtime rejects paths outside the controlled upload root", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-attachments-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "nova-attachments-outside-"));
  try {
    const filePath = path.join(outside, "secret.txt");
    writeFileSync(filePath, "must not be exposed", "utf8");
    const runtime = new AttachmentRuntime(root);
    await assert.rejects(
      runtime.buildPrompt("分析附件", {
        files: [{ name: "secret.txt", path: filePath, ext: "txt" }],
      }),
      /受控上传目录/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
