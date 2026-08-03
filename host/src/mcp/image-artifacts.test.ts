import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ImageArtifactStore } from "./image-artifacts.js";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=";

test("MCP Base64 images are persisted as local artifacts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-image-artifacts-"));
  try {
    const store = new ImageArtifactStore(root);
    const result = await store.persistFromMcpResult({
      content: [{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }],
    }, "run_model");
    assert.equal(result.errors.length, 0);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].ext, "png");
    assert.equal(existsSync(result.artifacts[0].path), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote image localization rejects private network URLs", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-image-artifacts-private-"));
  try {
    const store = new ImageArtifactStore(root);
    const result = await store.persistFromMcpResult({ images: [{ url: "http://127.0.0.1/private.png" }] }, "run_model");
    assert.equal(result.artifacts.length, 0);
    assert.match(result.errors.join("\n"), /内网/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sandbox image localization copies only files inside the authorized working directory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-sandbox-images-"));
  const workingRoot = path.join(root, "working");
  const generatedRoot = path.join(root, "generated");
  mkdirSync(workingRoot, { recursive: true });
  writeFileSync(path.join(workingRoot, "架构图.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
  writeFileSync(path.join(root, "outside.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
  try {
    const store = new ImageArtifactStore(generatedRoot);
    const result = await store.persistSandboxReferences(
      ["sandbox:/架构图.png", "sandbox:/../outside.png", "sandbox:/%2e%2e/outside.png"],
      workingRoot,
    );
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].name, "架构图.png");
    assert.equal(existsSync(result.artifacts[0].path), true);
    assert.equal(result.errors.length, 2);
    assert.match(result.errors.join("\n"), /超出 Nova 工作目录/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
