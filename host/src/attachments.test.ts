import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AttachmentRuntime } from "./attachments.js";

test("attachment runtime exposes metadata only and retains controlled files", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-attachments-root-"));
  try {
    const filePath = path.join(root, "sample.txt");
    writeFileSync(filePath, "hello attachment", "utf8");
    const runtime = new AttachmentRuntime(root);
    const prompt = await runtime.buildPrompt("分析附件", {
      files: [{ name: "sample.txt", path: filePath, ext: "txt", size: 16 }],
    });
    assert.match(prompt, /sample\.txt/);
    assert.doesNotMatch(prompt, /hello attachment/);
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
      /controlled upload directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("attachment runtime rejects junction escapes inside the upload root", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-attachments-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "nova-attachments-outside-"));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
    const link = path.join(root, "linked");
    try { symlinkSync(outside, link, "junction"); } catch { return; }
    const runtime = new AttachmentRuntime(root);
    await assert.rejects(runtime.buildPrompt("analyze", { files: [{ name: "secret.txt", path: path.join(link, "secret.txt"), ext: "txt" }] }), /outside/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
