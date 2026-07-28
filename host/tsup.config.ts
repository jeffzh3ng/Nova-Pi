import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  // sidecar 不发布类型（只作为可执行进程），关闭 DTS 避免 tsup 内部 tsc 的
  // baseUrl deprecation 报错。类型检查由 npm run typecheck 单独保证。
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  // 飞书 SDK 必须随 host/dist 打包；生产安装包只携带 dist，不携带工作区 node_modules。
  noExternal: ["@larksuiteoapi/node-sdk"],
  // pi-coding-agent and pi-ai ship ESM + native deps; keep them external
  // so the sidecar resolves them at runtime from node_modules.
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/compat",
    "@earendil-works/pi-ai/oauth",
    "@earendil-works/pi-ai/providers/all",
    "@modelcontextprotocol/sdk",
    "typebox",
    "jiti",
    "undici",
    "chalk",
    "cross-spawn",
    "diff",
    "glob",
    "highlight.js",
    "hosted-git-info",
    "ignore",
    "minimatch",
    "proper-lockfile",
    "semver",
    "yaml",
    "@silvia-oddywerr/photon-node",
    "@anthropic-ai/sdk",
    "@aws-sdk/client-bedrock-runtime",
    "@google/genai",
    "@mistralai/mistralai",
    "@opentelemetry/api",
    "@smithy/node-http-handler",
    "http-proxy-agent",
    "https-proxy-agent",
    "openai",
    "partial-json",
  ],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
