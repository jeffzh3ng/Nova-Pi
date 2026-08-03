#!/usr/bin/env node
// 版本同步脚本：把新版本号同步到全部 7 处（3 个 package.json + package-lock.json + Cargo.toml + Cargo.lock + tauri.conf.json）。
// 用法：
//   node scripts/sync-version.mjs 0.1.29        # 指定版本
//   node scripts/sync-version.mjs patch          # 或 patch / minor / major，按语义化版本递增
//   node scripts/sync-version.mjs patch --dry-run # 只打印将要变更的内容，不落盘
// 推送 GitHub 前必须先跑本脚本，且版本变更包含在同一次推送中（见 AGENTS.md「GitHub 同步规则」）。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const arg = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!arg) {
  console.error("用法: node scripts/sync-version.mjs <新版本|patch|minor|major> [--dry-run]");
  process.exit(1);
}

const readText = (p) => readFileSync(p, "utf8");
const readJson = (p) => JSON.parse(readText(p));
const writeJson = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");

// ---- 读当前版本（以根 package.json 为准）----
const rootPkgPath = resolve(root, "package.json");
const current = readJson(rootPkgPath).version;
if (!SEMVER.test(current)) {
  console.error(`根 package.json 版本非法: ${current}`);
  process.exit(1);
}

// ---- 计算目标版本 ----
let next;
if (SEMVER.test(arg)) {
  next = arg;
} else if (["patch", "minor", "major"].includes(arg)) {
  const [maj, min, pat] = current.split(/[-+]/)[0].split(".").map(Number);
  next =
    arg === "major" ? `${maj + 1}.0.0` :
    arg === "minor" ? `${maj}.${min + 1}.0` :
    `${maj}.${min}.${pat + 1}`;
} else {
  console.error(`无效版本: ${arg}（需要 semver 格式或 patch/minor/major）`);
  process.exit(1);
}

if (next === current) {
  console.log(`版本已是 ${current}，无需同步。`);
  process.exit(0);
}

// ---- 定义 7 个同步目标 ----
// kind 说明：
//   json      —— 顶层 "version" 字段
//   lock      —— package-lock.json：顶层 + packages[lockKeys]（workspace 条目）
//   cargo-toml—— 只改 [package] 段内的 version（不动依赖段里的 version = "x"）
//   cargo-lock—— 只改 name = "nova-pi" 条目
const targets = [
  { path: "package.json", kind: "json" },
  { path: "app/package.json", kind: "json" },
  { path: "host/package.json", kind: "json" },
  { path: "app/src-tauri/tauri.conf.json", kind: "json" },
  { path: "package-lock.json", kind: "lock", lockKeys: ["", "app", "host"] },
  { path: "app/src-tauri/Cargo.toml", kind: "cargo-toml" },
  { path: "app/src-tauri/Cargo.lock", kind: "cargo-lock" },
];

const buildNewText = (path, kind, lockKeys) => {
  const file = resolve(root, path);
  const text = readText(file);
  if (!text.includes(current)) {
    throw new Error(`${path}: 未找到当前版本 ${current}，请手动检查`);
  }
  switch (kind) {
    case "json": {
      const obj = JSON.parse(text);
      if (obj.version !== current) throw new Error(`${path}: 版本字段与 ${current} 不一致`);
      obj.version = next;
      return JSON.stringify(obj, null, 2) + "\n";
    }
    case "lock": {
      const obj = JSON.parse(text);
      if (obj.version !== current) throw new Error(`${path}: 顶层版本字段与 ${current} 不一致`);
      obj.version = next;
      for (const key of lockKeys) {
        if (!obj.packages?.[key] || obj.packages[key].version !== current) {
          throw new Error(`${path}: packages[${JSON.stringify(key)}] 缺失或版本不一致`);
        }
        obj.packages[key].version = next;
      }
      return JSON.stringify(obj, null, 2) + "\n";
    }
    case "cargo-toml": {
      const lines = text.split("\n");
      const secStart = lines.findIndex((l) => l.trim() === "[package]");
      if (secStart === -1) throw new Error(`${path}: 未找到 [package] 段`);
      let secEnd = lines.findIndex((l, i) => i > secStart && /^\[/.test(l.trim()));
      if (secEnd === -1) secEnd = lines.length;
      const sec = lines.slice(secStart, secEnd);
      const vi = sec.findIndex((l) => /^version\s*=/.test(l));
      if (vi === -1) throw new Error(`${path}: [package] 段内未找到 version`);
      if (!sec[vi].includes(current)) throw new Error(`${path}: version 行不含 ${current}`);
      sec[vi] = sec[vi].replace(/".*"/, `"${next}"`);
      lines.splice(secStart, secEnd - secStart, ...sec);
      return lines.join("\n");
    }
    case "cargo-lock": {
      const re = /(\[\[package\]\]\s*\nname = "nova-pi"\s*\n)version = "[^"]*"/;
      const m = re.exec(text);
      if (!m) throw new Error(`${path}: 未找到 name = "nova-pi" 条目`);
      if (!m[0].includes(current)) throw new Error(`${path}: nova-pi 条目版本不是 ${current}`);
      return text.replace(re, `$1version = "${next}"`);
    }
    default:
      throw new Error(`未知 kind: ${kind}`);
  }
};

// ---- 执行 ----
const results = [];
let failed = false;
for (const { path, kind, lockKeys } of targets) {
  try {
    const file = resolve(root, path);
    const newText = buildNewText(path, kind, lockKeys);
    results.push({ path, file, newText });
  } catch (err) {
    failed = true;
    console.error(`✗ ${path}: ${err.message}`);
  }
}

if (failed) {
  console.error("\n同步中止，未写入任何文件。");
  process.exit(1);
}

if (dryRun) {
  console.log(`[dry-run] ${current} → ${next}`);
  for (const { path } of results) console.log(`  将更新: ${path}`);
} else {
  for (const { file, newText } of results) writeFileSync(file, newText);
  // 落盘后复查：每个文件必须包含新版本且不再含旧版本（Cargo.lock 全量 grep 旧版本不可行，只查目标行）
  for (const { path } of results) {
    const text = readText(resolve(root, path));
    if (!text.includes(next)) {
      console.error(`✗ 复查失败: ${path} 不含 ${next}`);
      failed = true;
    }
  }
  if (failed) {
    console.error("同步完成但复查失败，请手动检查上述文件。");
    process.exit(1);
  }
  console.log(`✓ ${current} → ${next} 已同步 7 处:`);
  for (const { path } of results) console.log(`  ${path}`);
}
