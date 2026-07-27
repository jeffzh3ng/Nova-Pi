/**
 * Pi 扩展管理：读写 settings.json 的 extensions 数组，并发现已安装的扩展文件。
 *
 * pi 的扩展发现机制（见 pi.dev/docs/extensions）：
 * - settings.json 的 "extensions": ["./path.ts", "./dir/"] 数组（本地文件/目录）
 * - 全局目录 ~/.pi/agent/extensions/ 下的 .ts 文件或子目录里的 index.ts
 * - 项目目录 .pi/extensions/ 下的 .ts 文件
 *
 * 本模块把 settings.json 的 extensions 数组作为用户管理的入口（增删路径），
 * 同时扫描全局 extensions 目录列出已存在的扩展文件，让用户在 UI 里看到全部。
 *
 * 扩展文件格式：导出 default 工厂函数 `(pi: ExtensionAPI) => { ... }`，
 * 可注册 tool / command / provider / hook。pi 通过 jiti 直接加载 .ts，无需编译。
 */

import { join, basename, dirname, resolve } from "node:path";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readFile as readFileSync } from "node:fs/promises";

let settingsJsonPath = "";
let globalExtensionsDir = ""; // ~/.pi/agent/extensions 或 appDataDir/.pi/agent/extensions

/** 初始化路径。 */
export function initExtensionsManagerPaths(agentDir: string): void {
  settingsJsonPath = join(agentDir, "settings.json");
  globalExtensionsDir = join(agentDir, "extensions");
}

/** 扩展摘要（前端卡片展示）。 */
export type ExtensionSummary = {
  /** 唯一标识：规范化后的路径（相对 agentDir 或绝对）。 */
  id: string;
  /** 显示名：文件名或目录名（去 .ts 后缀）。 */
  name: string;
  /** 源路径。 */
  path: string;
  /** 来源：user-managed（settings.json 显式声明）/ global-dir（全局目录扫描）。 */
  source: "user-managed" | "global-dir";
  /** 是否在 settings.json 里启用（user-managed 永远 true；global-dir 看是否在数组里）。 */
  enabled: boolean;
  /** 文件是否存在。 */
  exists: boolean;
  /** 描述：尝试从扩展文件头部注释提取首行。 */
  description: string;
  /** 是否是目录（目录型扩展含 index.ts）。 */
  isDirectory: boolean;
};

type PiSettings = {
  extensions?: string[];
  defaultProvider?: string;
  defaultModel?: string;
  packages?: unknown[];
};

/** 列出全部扩展：settings.json 显式声明的 + 全局目录扫描的，去重合并。 */
export async function listExtensions(): Promise<{ extensions: ExtensionSummary[]; errors: string[] }> {
  const settings = await readSettingsJson();
  const declared = settings.extensions ?? [];
  const errors: string[] = [];
  const result: ExtensionSummary[] = [];
  const seen = new Set<string>();

  // 1. settings.json 显式声明的扩展
  for (const rawPath of declared) {
    const normalized = normalizeExtensionPath(rawPath);
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    const exists = await pathExists(normalized.resolved);
    const isDir = exists ? await isDirectory(normalized.resolved) : false;
    const description = exists ? await extractDescription(normalized.resolved, isDir) : "";
    result.push({
      id: normalized.id,
      name: normalized.display,
      path: normalized.resolved,
      source: "user-managed",
      enabled: true,
      exists,
      description,
      isDirectory: isDir,
    });
  }

  // 2. 全局目录扫描（~/.pi/agent/extensions）
  if (existsSync(globalExtensionsDir)) {
    const entries = await scanExtensionsDir(globalExtensionsDir);
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      result.push({
        ...entry,
        // 全局目录扫描出的扩展，若未在 settings.json 显式声明，视为"已启用"（pi 自动加载）
        enabled: true,
        source: "global-dir",
      });
    }
  }

  return { extensions: result, errors };
}

/** 新增一个扩展路径（写入 settings.json 的 extensions 数组）。
 *  支持文件路径、目录路径、或 npm 包名（包名走 packages，这里只处理本地路径）。 */
export async function addExtension(rawPath: string): Promise<void> {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error("扩展路径不能为空。");
  // 简单校验：本地路径应存在（npm 包名由 packages 管理，此处拒绝）
  if (!trimmed.startsWith(".") && !trimmed.startsWith("/") && !trimmed.startsWith("~")) {
    throw new Error("仅支持本地扩展路径（以 ./ 、/ 或 ~/ 开头）。npm 包请用 packages 配置。");
  }
  const settings = await readSettingsJson();
  const list = settings.extensions ?? [];
  const normalized = normalizeExtensionPath(trimmed);
  if (list.some((p) => normalizeExtensionPath(p).id === normalized.id)) {
    throw new Error(`扩展已存在：${trimmed}`);
  }
  list.push(trimmed);
  settings.extensions = list;
  await writeSettingsJson(settings);
}

/** 移除一个扩展（从 settings.json extensions 数组删除；不删磁盘文件）。 */
export async function removeExtension(extensionId: string): Promise<void> {
  const settings = await readSettingsJson();
  const list = settings.extensions ?? [];
  const next = list.filter((p) => normalizeExtensionPath(p).id !== extensionId);
  if (next.length === list.length) {
    // 可能是全局目录扫描出的扩展（不在 settings.json 里），此处无法移除，提示用户手动删文件
    throw new Error("该扩展来自全局扩展目录，未在 settings.json 中声明。请直接删除对应的 .ts 文件。");
  }
  settings.extensions = next;
  await writeSettingsJson(settings);
}

/** 启用/禁用扩展（通过加入/移出 settings.json extensions 数组）。 */
export async function setExtensionEnabled(extensionId: string, enabled: boolean): Promise<void> {
  const settings = await readSettingsJson();
  let list = settings.extensions ?? [];
  if (enabled) {
    if (!list.some((p) => normalizeExtensionPath(p).id === extensionId)) {
      list.push(extensionId);
    }
  } else {
    list = list.filter((p) => normalizeExtensionPath(p).id !== extensionId);
  }
  settings.extensions = list;
  await writeSettingsJson(settings);
}

/** 读取一个扩展文件的内容（前端详情面板展示源码）。 */
export async function readExtensionContent(extensionId: string): Promise<string> {
  const { extensions } = await listExtensions();
  const ext = extensions.find((e) => e.id === extensionId);
  if (!ext) throw new Error(`扩展不存在：${extensionId}`);
  if (!ext.exists) throw new Error("扩展文件不存在。");
  const target = ext.isDirectory ? join(ext.path, "index.ts") : ext.path;
  return await readFile(target, "utf8");
}

/** 在全局扩展目录创建一个新的扩展文件（带模板代码），并自动加入 settings.json。 */
export async function createExtension(name: string, template: string): Promise<ExtensionSummary> {
  const safeName = name.trim().replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (!safeName) throw new Error("扩展名只能包含字母、数字、点、下划线、短横线。");
  await mkdir(globalExtensionsDir, { recursive: true });
  const filePath = join(globalExtensionsDir, `${safeName}.ts`);
  if (existsSync(filePath)) throw new Error(`扩展已存在：${safeName}.ts`);
  await writeFile(filePath, template, "utf8");
  await addExtension(filePath);
  const { extensions } = await listExtensions();
  const created = extensions.find((e) => e.path === filePath);
  if (!created) throw new Error("创建成功但未在列表中找到。");
  return created;
}

// ── 内部帮助 ──

async function readSettingsJson(): Promise<PiSettings> {
  if (!existsSync(settingsJsonPath)) return {};
  try {
    const raw = await readFile(settingsJsonPath, "utf8");
    return JSON.parse(stripJsonComments(raw)) as PiSettings;
  } catch {
    return {};
  }
}

async function writeSettingsJson(settings: PiSettings): Promise<void> {
  await mkdir(join(settingsJsonPath, ".."), { recursive: true });
  await writeFile(settingsJsonPath, JSON.stringify(settings, null, 2), "utf8");
}

type NormalizedPath = { id: string; display: string; resolved: string };

function normalizeExtensionPath(rawPath: string): NormalizedPath {
  // 展开 ~ 为 HOME
  let p = rawPath.replace(/^~/, process.env.HOME ?? "~");
  // 相对路径基于 settings.json 所在目录解析
  if (!p.startsWith("/")) {
    p = resolve(dirname(settingsJsonPath), p);
  }
  const base = basename(p);
  const display = base.replace(/\.ts$/i, "").replace(/^index$/i, basename(dirname(p)));
  return { id: p, display, resolved: p };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 扫描全局扩展目录，发现 *.ts 文件和含 index.ts 的子目录。 */
async function scanExtensionsDir(dir: string): Promise<Omit<ExtensionSummary, "enabled" | "source">[]> {
  const results: Omit<ExtensionSummary, "enabled" | "source">[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stats = await stat(full).catch(() => null);
    if (!stats) continue;
    if (stats.isFile() && entry.endsWith(".ts")) {
      results.push({
        id: full,
        name: entry.replace(/\.ts$/i, ""),
        path: full,
        exists: true,
        description: await extractDescription(full, false),
        isDirectory: false,
      });
    } else if (stats.isDirectory()) {
      const indexPath = join(full, "index.ts");
      if (existsSync(indexPath)) {
        results.push({
          id: indexPath,
          name: entry,
          path: full,
          exists: true,
          description: await extractDescription(indexPath, false),
          isDirectory: true,
        });
      }
    }
  }
  return results;
}

/** 从扩展文件头部 JSDoc 注释提取首行描述。 */
async function extractDescription(filePath: string, _isDir: boolean): Promise<string> {
  try {
    const target = (await isDirectory(filePath)) ? join(filePath, "index.ts") : filePath;
    const content = await readFileSync(target, "utf8");
    // 匹配 /** ... */ 第一段
    const match = content.match(/\/\*\*([\s\S]*?)\*\//);
    if (match?.[1]) {
      const lines = match[1]
        .split("\n")
        .map((l) => l.replace(/^\s*\* ?/, "").trim())
        .filter((l) => l && !l.startsWith("@"));
      return lines[0] ?? "";
    }
    return "";
  } catch {
    return "";
  }
}

function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      if (char === "\\") {
        result += char + (next ?? "");
        i += 2;
        continue;
      }
      if (char === '"') inString = false;
      result += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    result += char;
    i += 1;
  }
  return result;
}

/** 默认扩展模板（供 createExtension 使用）。 */
export const DEFAULT_EXTENSION_TEMPLATE = `/**
 * Pi 扩展：<描述你的扩展功能>
 * 文档：https://pi.dev/docs/latest/extensions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 监听 agent 生命周期事件
  pi.on("agent_start", () => {
    console.log("[扩展] agent 启动");
  });

  // 注册一个自定义工具（LLM 可按需调用）
  pi.registerTool({
    name: "my_tool",
    label: "我的工具",
    description: "在这里描述工具的用途，LLM 会据此决定是否调用。",
    parameters: Type.Object({
      input: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      return {
        content: [{ type: "text", text: \`处理了：\${params.input}\` }],
        details: {},
      };
    },
  });

  // 注册一个斜杠命令
  pi.registerCommand("mycommand", {
    description: "我的命令",
    handler: async (args, ctx) => {
      ctx.ui.notify(\`执行了 mycommand：\${args}\`, "info");
    },
  });
}
`;
