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

test("explicit remote image outputs reject private network URLs", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-image-artifacts-private-"));
  try {
    const store = new ImageArtifactStore(root);
    const result = await store.persistFromMcpResult({
      structuredContent: { images: [{ url: "http://127.0.0.1/private.png" }] },
    }, "run_model");
    assert.equal(result.artifacts.length, 0);
    assert.match(result.errors.join("\n"), /内网/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search and extraction page assets are not promoted to image artifacts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-image-artifacts-search-"));
  try {
    const store = new ImageArtifactStore(root);
    const result = await store.persistFromMcpResult({
      content: [{
        type: "text",
        text: "搜索正文含站点素材 https://cdn.example.com/code.png 和头像 https://cdn.example.com/avatar.webp",
      }],
      structuredContent: {
        results: [{
          title: "普通搜索结果",
          image_url: "http://127.0.0.1/avatar.png",
          page: { images: [{ url: "http://127.0.0.1/code.png" }] },
        }],
        thumbnail: "http://127.0.0.1/thumbnail.png",
        preview: "http://127.0.0.1/preview.png",
      },
    }, "batch_search");
    assert.deepEqual(result, { artifacts: [], errors: [] });

    const wrappedResult = await store.persistFromMcpResult({
      structuredContent: {
        result: JSON.stringify({
          results: [{
            title: "FastMCP 搜索结果",
            image_url: "http://127.0.0.1/avatar.png",
          }],
        }),
      },
    }, "batch_search");
    assert.deepEqual(wrappedResult, { artifacts: [], errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only top-level explicit image fields are localized from structured output", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-image-artifacts-explicit-"));
  try {
    const store = new ImageArtifactStore(root);
    const result = await store.persistFromMcpResult({
      structuredContent: {
        image_url: "http://127.0.0.1/generated-image",
        results: [{ image_url: "http://127.0.0.1/search-thumbnail.png" }],
      },
    }, "generate_image");
    assert.equal(result.artifacts.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /内网/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FastMCP result wrappers preserve explicit image outputs", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nova-image-artifacts-fastmcp-"));
  try {
    const store = new ImageArtifactStore(root);
    const result = await store.persistFromMcpResult({
      structuredContent: {
        result: JSON.stringify({ images: [{ url: "http://127.0.0.1/generated.png" }] }),
      },
    }, "generate_image");
    assert.equal(result.artifacts.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /内网/);
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
