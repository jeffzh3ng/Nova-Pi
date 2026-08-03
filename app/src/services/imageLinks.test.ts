import assert from "node:assert/strict";
import test from "node:test";
import {
  extractRemoteImageUrls,
  extractSandboxImageReferences,
  extractWorkingDirectoryImageReferences,
  sandboxImageFileName,
} from "./imageLinks";

test("extracts image links from regular and image markdown", () => {
  assert.deepEqual(
    extractRemoteImageUrls(
      "[download](https://cdn.example.com/a.png) and ![preview](https://cdn.example.com/b.webp?token=1)",
    ),
    ["https://cdn.example.com/a.png", "https://cdn.example.com/b.webp?token=1"],
  );
});

test("ignores non-image links and deduplicates image URLs", () => {
  assert.deepEqual(
    extractRemoteImageUrls(
      "https://example.com/report https://cdn.example.com/a.jpg https://cdn.example.com/a.jpg",
    ),
    ["https://cdn.example.com/a.jpg"],
  );
});

test("extracts sandbox image links and resolves their display file name", () => {
  const reference = "sandbox:/泰康驻场项目加班补贴架构图.png";
  assert.deepEqual(
    extractSandboxImageReferences(`[查看图片](${reference})`),
    [reference],
  );
  assert.equal(sandboxImageFileName(reference), "泰康驻场项目加班补贴架构图.png");
});

test("ignores sandbox references that are not supported raster images", () => {
  assert.deepEqual(
    extractSandboxImageReferences("[script](sandbox:/diagram.svg) [doc](sandbox:/report.docx)"),
    [],
  );
});

test("recovers Windows image paths inside the authorized Nova working directory", () => {
  assert.deepEqual(
    extractWorkingDirectoryImageReferences(
      "已生成图片：`C:\\Users\\Tester\\.nova\\square abstract landscape.png`",
      "C:\\Users\\Tester\\.nova",
    ),
    ["sandbox:/square%20abstract%20landscape.png"],
  );
});

test("does not recover sibling paths that only share the working-directory prefix", () => {
  assert.deepEqual(
    extractWorkingDirectoryImageReferences(
      "C:\\Users\\Tester\\.nova-other\\outside.png",
      "C:\\Users\\Tester\\.nova",
    ),
    [],
  );
});

test("recovers POSIX image paths under the configured working directory", () => {
  assert.deepEqual(
    extractWorkingDirectoryImageReferences(
      "saved to `/Users/dp/.nova/nested/result.webp`",
      "/Users/dp/.nova/",
    ),
    ["sandbox:/nested/result.webp"],
  );
});
