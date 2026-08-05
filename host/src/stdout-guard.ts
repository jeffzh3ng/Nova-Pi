/**
 * stdout 守卫：保护 JSON-line RPC 通道不被第三方库污染。
 *
 * host 与 Rust 之间通过 stdin/stdout 交换 newline-delimited JSON（RpcResponse +
 * RpcEventEnvelope）。但部分依赖（pdf2json 内嵌的 pdf.js fragment 会打印
 * "Warning: Setting up fake worker." / "(while reading XRef): Error: ..." 等）
 * 直接调用 `process.stdout.write`，这些非 JSON 文本会被 Rust 端的行解析器
 * 当成非法帧丢弃（`invalid stdout JSON: expected value at line 1 column 1`），
 * 严重时吞掉紧随其后的 RPC 响应，导致请求-响应匹配断裂、任务永久挂起。
 *
 * 实测：扫描版 PDF 触发 pdf2json 解析时，每次都会向 stdout 喷 3 行警告，
 * 与 sidecar.log 中 document 工具执行时段的 3 条 `invalid stdout JSON` 完全对应。
 *
 * 守卫策略：封装 `process.stdout.write`，只放行 `writeJsonLine` 产生的合法 JSON 行
 *（以 `{` 开头、单行完整），其它内容一律转投 stderr（Rust 的 stderr 线程会加 `host:`
 * 前缀写入 sidecar.log，便于排查但不破坏 RPC）。
 *
 * 激活条件：仅在 sidecar 模式（由 Rust 注入 NOVA_PI_SIDECAR=1）下激活。这样
 * node:test 测试运行器和 --verify-document-pdf standalone smoke 的 stdout 报告
 * 不会被守卫拦截。测试如需验证守卫行为，调用 {@link installStdoutGuard} 强制安装。
 *
 * 必须在所有可能触发第三方库加载的 import 之前导入本模块（main.ts 第一行）。
 */

/** 合法 JSON-line 帧的判定：去掉首尾换行后以 `{` 开头、以 `}` 结尾，且内部不含裸换行。 */
function isJsonLineFrame(text: string): boolean {
  const stripped = text.replace(/\r?\n$/, "");
  if (!stripped.startsWith("{") || !stripped.endsWith("}")) return false;
  // writeJsonLine 保证每次写一个完整 `{...}\n`；含内部换行的输入属于异常拼接。
  return !stripped.includes("\n");
}

/** 守卫是否已安装（幂等，避免重复封装）。 */
let installed = false;

/**
 * 安装 stdout 守卫。封装 `process.stdout.write`：合法 JSON-line 帧透传到真实 stdout，
 * 非 JSON 输出转投 stderr 并加 `[stdout-guard]` 前缀，调用方回调契约保持不变。
 * 幂等：重复调用安全。
 */
export function installStdoutGuard(): void {
  if (installed) return;
  installed = true;

  const realStdoutWrite = process.stdout.write.bind(process.stdout);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patchedWrite: any = function patchedStdoutWrite(
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((error?: Error | null) => void),
    maybeCb?: ((error?: Error | null) => void) | BufferEncoding,
  ) {
    const hasEncoding = typeof encodingOrCb === "string";
    const callback = hasEncoding ? maybeCb : encodingOrCb;
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");

    if (isJsonLineFrame(text)) {
      // 合法 RPC 帧：透传真实 stdout，保留 encoding 与回调契约。
      const result = hasEncoding
        ? realStdoutWrite(chunk, encodingOrCb as BufferEncoding, maybeCb as (error?: Error | null) => void)
        : realStdoutWrite(chunk, encodingOrCb as (error?: Error | null) => void);
      if (typeof callback === "function") callback();
      return result;
    }

    // 非法帧：转投 stderr 并标注来源（截断超长内容），触发调用方回调避免重试分支。
    const preview = text.length > 500 ? text.slice(0, 500) + "…" : text;
    process.stderr.write(`[stdout-guard] 拦截非 JSON stdout 写入：${preview}\n`);
    if (typeof callback === "function") callback();
    return true;
  };

  process.stdout.write = patchedWrite;
}

// 模块加载时：仅在 sidecar 模式自动安装。测试与 standalone smoke 不受影响。
// NOVA_PI_SIDECAR 由 Rust 在 spawn sidecar 时注入（sidecar.rs）。
if (process.env.NOVA_PI_SIDECAR === "1") {
  installStdoutGuard();
}
