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
  sourcemap: false,
  clean: true,
  // 安装包只携带 host/dist，不携带工作区 node_modules。所有 JS 运行时依赖都必须
  // 进入单文件 bundle，否则开发模式会从仓库 node_modules 偷跑成功，安装版却在启动时
  // 报 ERR_MODULE_NOT_FOUND。Node 内置模块仍由 esbuild 自动保留为 external。
  noExternal: [/.*/],
  banner: {
    // Bundled CommonJS dependencies in the Feishu SDK still load Node built-ins
    // (for example `util`) through require() and inspect their own package path.
    // Recreate the CommonJS globals instead of using esbuild's throwing fallback.
    js: `#!/usr/bin/env node
import { createRequire as __createRequireForBundle } from "node:module";
import { fileURLToPath as __fileURLToPathForBundle } from "node:url";
import { dirname as __dirnameForBundle } from "node:path";
const require = __createRequireForBundle(import.meta.url);
const __filename = __fileURLToPathForBundle(import.meta.url);
const __dirname = __dirnameForBundle(__filename);`,
  },
});
