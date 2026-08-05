import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extractMcpPayload } from "./payload.js";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_CANDIDATES = 8;
const MAX_REDIRECTS = 5;

export type LocalImageArtifact = {
  kind: "image";
  name: string;
  path: string;
  ext: string;
  size: number;
  mimeType: string;
};

type ImageCandidate =
  | { type: "base64"; data: string; mimeType: string }
  | { type: "url"; url: string };

export type PersistedImageResult = {
  artifacts: LocalImageArtifact[];
  errors: string[];
};

function imageInfo(bytes: Buffer, declaredMime = ""): { ext: string; mimeType: string } | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { ext: "png", mimeType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", mimeType: "image/jpeg" };
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) {
    return { ext: "gif", mimeType: "image/gif" };
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { ext: "webp", mimeType: "image/webp" };
  }
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM") {
    return { ext: "bmp", mimeType: "image/bmp" };
  }
  if (
    bytes.length >= 4
    && (bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
      || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))
  ) {
    return { ext: "tif", mimeType: "image/tiff" };
  }
  // 不接收 SVG：它是可执行标记语言，不应作为普通位图在 WebView 中展示。
  if (declaredMime.toLowerCase().startsWith("image/")) return undefined;
  return undefined;
}

const EXPLICIT_IMAGE_OUTPUT_KEYS = new Set([
  "image",
  "images",
  "imageurl",
  "imageurls",
  "imageuri",
  "imageuris",
  "outputimage",
  "outputimages",
  "outputimageurl",
  "outputimageurls",
  "generatedimage",
  "generatedimages",
  "generatedimageurl",
  "generatedimageurls",
]);
const IMAGE_VALUE_URL_KEYS = new Set(["url", "urls", "uri", "uris", "src", "href", "downloadurl"]);
const IMAGE_VALUE_CONTAINER_KEYS = new Set(["data", "items", "outputs", "result"]);

function normalizedKey(key: string): string {
  return key.replace(/[-_]/g, "").toLowerCase();
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return /^(https?):$/.test(url.protocol);
  } catch {
    return false;
  }
}

function collectCandidates(raw: unknown): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const urls = new Set<string>();
  const base64Images = new Set<string>();

  const pushUrl = (url: string) => {
    if (candidates.length >= MAX_IMAGE_CANDIDATES || urls.has(url) || !isHttpUrl(url)) return;
    urls.add(url);
    candidates.push({ type: "url", url });
  };

  const pushBase64 = (data: string, mimeType: string) => {
    if (
      candidates.length >= MAX_IMAGE_CANDIDATES
      || base64Images.has(data)
      || !mimeType.toLowerCase().startsWith("image/")
    ) return;
    base64Images.add(data);
    candidates.push({ type: "base64", data, mimeType });
  };

  const visitExplicitImageValue = (value: unknown, depth = 0): void => {
    if (depth > 5 || candidates.length >= MAX_IMAGE_CANDIDATES || value == null) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (isHttpUrl(trimmed)) {
        pushUrl(trimmed);
      } else if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 500_000) {
        try { visitExplicitImageValue(JSON.parse(trimmed), depth + 1); } catch { /* not JSON */ }
      }
      return;
    }
    if (typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item) => visitExplicitImageValue(item, depth + 1));
      return;
    }
    const node = value as Record<string, unknown>;
    if (
      node.type === "image"
      && typeof node.data === "string"
      && typeof node.mimeType === "string"
    ) {
      pushBase64(node.data, node.mimeType);
    } else if (
      typeof node.data === "string"
      && typeof (node.mimeType ?? node.mime_type) === "string"
    ) {
      pushBase64(node.data, String(node.mimeType ?? node.mime_type));
    } else if (typeof node.b64_json === "string") {
      pushBase64(node.b64_json, "image/png");
    }
    for (const [key, child] of Object.entries(node)) {
      const normalized = normalizedKey(key);
      if (IMAGE_VALUE_URL_KEYS.has(normalized)) {
        if (typeof child === "string") pushUrl(child.trim());
        else if (Array.isArray(child)) child.forEach((item) => {
          if (typeof item === "string") pushUrl(item.trim());
        });
      } else if (
        EXPLICIT_IMAGE_OUTPUT_KEYS.has(normalized)
        || IMAGE_VALUE_CONTAINER_KEYS.has(normalized)
      ) {
        visitExplicitImageValue(child, depth + 1);
      }
    }
  };

  const visitContentBlocks = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const block of value) {
      if (!block || typeof block !== "object") continue;
      const node = block as Record<string, unknown>;
      if (node.type === "image" && typeof node.data === "string" && typeof node.mimeType === "string") {
        pushBase64(node.data, node.mimeType);
      } else if (node.type === "image_url") {
        visitExplicitImageValue(node.image_url ?? node.url);
      }
    }
  };

  const visitExplicitRoot = (value: unknown): void => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 500_000) {
        try { visitExplicitRoot(JSON.parse(trimmed)); } catch { /* not JSON */ }
      }
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (EXPLICIT_IMAGE_OUTPUT_KEYS.has(normalizedKey(key))) {
        visitExplicitImageValue(child);
      }
    }
  };

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const envelope = raw as Record<string, unknown>;
    visitContentBlocks(envelope.content);
  }
  // 兼容 structuredContent、FastMCP result JSON 字符串和直接业务对象；
  // 解包后仍只读取根级明确图片字段，不递归扫描普通搜索结果。
  visitExplicitRoot(extractMcpPayload(raw).data);
  return candidates;
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) return privateIpv4(address);
  const lower = address.toLowerCase().split("%")[0];
  if (lower.startsWith("::ffff:")) return privateIpv4(lower.slice(7));
  return lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd")
    || /^fe[89ab]/.test(lower);
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (!/^(https?):$/.test(url.protocol) || url.username || url.password) {
    throw new Error("图片链接必须是无凭据的 HTTP(S) 地址。");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) throw new Error("拒绝访问本机图片地址。");
  if (isIP(hostname)) {
    if (privateAddress(hostname)) throw new Error("拒绝访问内网图片地址。");
    return;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => privateAddress(item.address))) {
    throw new Error("图片域名解析到了内网地址，已拒绝下载。");
  }
}

async function readResponseBytes(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error("远程图片超过 25 MB。");
  if (!response.body) throw new Error("远程图片响应为空。");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error("远程图片超过 25 MB。");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function downloadImage(rawUrl: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType: string }> {
  let url = new URL(rawUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicUrl(url);
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000);
    const response = await fetch(url, { redirect: "manual", signal: requestSignal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS) throw new Error("图片链接重定向无效或次数过多。");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`);
    return {
      bytes: await readResponseBytes(response),
      mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "",
    };
  }
  throw new Error("图片链接重定向次数过多。");
}

function safeArtifactName(label: string, index: number, ext: string): string {
  const safe = basename(label)
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "generated-image";
  return `${safe}-${index + 1}.${ext}`;
}

function safeLocalImageName(name: string, index: number, ext: string): string {
  const safe = basename(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .trim()
    .slice(0, 120);
  return safe || `generated-image-${index + 1}.${ext}`;
}

function sandboxRelativePath(reference: string): string {
  const separator = reference.indexOf(":");
  const rawPath = separator >= 0 ? reference.slice(separator + 1) : "";
  if (
    separator <= 0
    || reference.slice(0, separator).toLowerCase() !== "sandbox"
    || !rawPath.startsWith("/")
    || rawPath.startsWith("//")
    || rawPath.includes("?")
    || rawPath.includes("#")
  ) {
    throw new Error("仅支持无主机名、查询参数或片段的 sandbox 图片引用。");
  }
  const decoded = decodeURIComponent(rawPath).replace(/\\/g, "/");
  const segments = decoded.split("/").filter(Boolean);
  if (
    segments.length === 0
    || segments.some((segment) => segment === "." || segment === "..")
    || /^[a-zA-Z]:/.test(segments[0])
  ) {
    throw new Error("sandbox 图片超出 Nova 工作目录，已拒绝读取。");
  }
  const relativePath = segments.join("/");
  if (isAbsolute(relativePath)) throw new Error("sandbox 图片超出 Nova 工作目录，已拒绝读取。");
  return relativePath;
}

function staysWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

export class ImageArtifactStore {
  constructor(private readonly root: string) {}

  async readArtifact(path: string): Promise<Buffer> {
    const [canonicalRoot, canonicalPath] = await Promise.all([realpath(this.root), realpath(path)]).catch(() => { throw new Error("generated image artifact is unavailable"); });
    if (!staysWithin(canonicalRoot, canonicalPath)) throw new Error("generated image artifact is outside its controlled store");
    const info = await stat(canonicalPath);
    if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) throw new Error("generated image artifact is invalid");
    return readFile(canonicalPath);
  }

  async persistFromMcpResult(raw: unknown, label: string, signal?: AbortSignal): Promise<PersistedImageResult> {
    const artifacts: LocalImageArtifact[] = [];
    const errors: string[] = [];
    const seenPaths = new Set<string>();
    const candidates = collectCandidates(raw);
    await mkdir(this.root, { recursive: true });

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        const downloaded = candidate.type === "base64"
          ? { bytes: Buffer.from(candidate.data, "base64"), mimeType: candidate.mimeType }
          : await downloadImage(candidate.url, signal);
        if (downloaded.bytes.length === 0 || downloaded.bytes.length > MAX_IMAGE_BYTES) {
          throw new Error("图片数据为空或超过 25 MB。");
        }
        const info = imageInfo(downloaded.bytes, downloaded.mimeType);
        if (!info) throw new Error("返回内容不是受支持的位图格式。");
        const hash = createHash("sha256").update(downloaded.bytes).digest("hex");
        const path = join(this.root, `${hash.slice(0, 24)}.${info.ext}`);
        if (!seenPaths.has(path)) {
          await writeFile(path, downloaded.bytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
          seenPaths.add(path);
          artifacts.push({
            kind: "image",
            name: safeArtifactName(label, index, info.ext),
            path,
            ext: info.ext,
            size: downloaded.bytes.length,
            mimeType: info.mimeType,
          });
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { artifacts, errors };
  }

  async persistSandboxReferences(
    references: string[],
    allowedWorkingRoot: string,
  ): Promise<PersistedImageResult> {
    const artifacts: LocalImageArtifact[] = [];
    const errors: string[] = [];
    const seenPaths = new Set<string>();
    await mkdir(this.root, { recursive: true });

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(allowedWorkingRoot);
    } catch (error) {
      return {
        artifacts,
        errors: [`无法读取 Nova 工作目录：${error instanceof Error ? error.message : String(error)}`],
      };
    }

    for (let index = 0; index < references.slice(0, MAX_IMAGE_CANDIDATES).length; index += 1) {
      try {
        const sourcePath = resolve(canonicalRoot, sandboxRelativePath(references[index]));
        const canonicalSource = await realpath(sourcePath);
        if (!staysWithin(canonicalRoot, canonicalSource)) {
          throw new Error("sandbox 图片超出 Nova 工作目录，已拒绝读取。");
        }
        const sourceInfo = await stat(canonicalSource);
        if (!sourceInfo.isFile() || sourceInfo.size === 0 || sourceInfo.size > MAX_IMAGE_BYTES) {
          throw new Error("sandbox 图片不存在、为空或超过 25 MB。");
        }
        const bytes = await readFile(canonicalSource);
        const info = imageInfo(bytes);
        if (!info) throw new Error("sandbox 引用不是受支持的位图格式。");
        const hash = createHash("sha256").update(bytes).digest("hex");
        const path = join(this.root, `${hash.slice(0, 24)}.${info.ext}`);
        if (seenPaths.has(path)) continue;
        await writeFile(path, bytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        seenPaths.add(path);
        artifacts.push({
          kind: "image",
          name: safeLocalImageName(canonicalSource, index, info.ext),
          path,
          ext: info.ext,
          size: bytes.length,
          mimeType: info.mimeType,
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { artifacts, errors };
  }
}
