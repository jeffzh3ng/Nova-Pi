const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
]);

function hasSupportedImageExtension(pathname: string): boolean {
  const dotIndex = pathname.lastIndexOf(".");
  const extension = dotIndex >= 0 ? pathname.slice(dotIndex).toLowerCase() : "";
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeWorkingDirectory(value: string): string {
  let normalized = value.trim().replace(/\\/g, "/");
  while (
    normalized.length > 1
    && normalized.endsWith("/")
    && !/^[a-zA-Z]:\/$/.test(normalized)
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function normalizeSandboxImageReference(raw: string): string | undefined {
  const candidate = raw.trim().replace(/^<|>$/g, "");
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "sandbox:" || parsed.host || parsed.search || parsed.hash) return undefined;
    if (!hasSupportedImageExtension(parsed.pathname)) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

export function extractRemoteImageUrls(text: string, limit = 8): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    const raw = match[0].replace(/[),.;\]}]+$/, "");
    try {
      const parsed = new URL(raw);
      if (!hasSupportedImageExtension(parsed.pathname) || seen.has(parsed.href)) continue;
      seen.add(parsed.href);
      urls.push(parsed.href);
      if (urls.length >= limit) break;
    } catch {
      // Ignore malformed links in ordinary assistant text.
    }
  }

  return urls;
}

export function extractSandboxImageReferences(text: string, limit = 8): string[] {
  const references: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const normalized = normalizeSandboxImageReference(raw);
    if (!normalized || seen.has(normalized) || references.length >= limit) return;
    seen.add(normalized);
    references.push(normalized);
  };

  // Markdown destinations may contain spaces when wrapped in angle brackets.
  for (const match of text.matchAll(/\]\(\s*(<?sandbox:[^)>]+>?)\s*\)/gi)) add(match[1]);
  for (const match of text.matchAll(/sandbox:\/{1,3}[^\s"'<>)}\]]+/gi)) add(match[0]);
  return references;
}

/**
 * 把助手文本中位于 Nova 授权工作目录内的绝对图片路径转换为 sandbox 引用。
 * 这里只做候选提取；Host 仍会通过 realpath、目录边界和图片魔数重新校验。
 */
export function extractWorkingDirectoryImageReferences(
  text: string,
  workingDirectory: string,
  limit = 8,
): string[] {
  const root = normalizeWorkingDirectory(workingDirectory);
  if (!root || limit <= 0) return [];

  const normalizedText = text.replace(/\\/g, "/");
  const separator = root.endsWith("/") ? "" : "/";
  const flags = /^[a-zA-Z]:\//.test(root) ? "gi" : "g";
  const matcher = new RegExp(
    `${escapeRegExp(root)}${separator}[^\\r\\n\`"<>|?#]*?\\.(?:png|jpe?g|gif|webp|bmp|tiff?)(?=$|[\\s\\x60),;，。；：\\]])`,
    flags,
  );
  const references: string[] = [];
  const seen = new Set<string>();

  for (const match of normalizedText.matchAll(matcher)) {
    const relativePath = match[0].slice(root.length).replace(/^\/+/, "");
    if (!relativePath) continue;
    const encodedPath = relativePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const reference = `sandbox:/${encodedPath}`;
    if (seen.has(reference)) continue;
    seen.add(reference);
    references.push(reference);
    if (references.length >= limit) break;
  }
  return references;
}

export function sandboxImageFileName(reference: string): string | undefined {
  const normalized = normalizeSandboxImageReference(reference);
  if (!normalized) return undefined;
  try {
    const pathname = decodeURIComponent(new URL(normalized).pathname).replace(/\\/g, "/");
    const name = pathname.split("/").filter(Boolean).at(-1)?.trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}
