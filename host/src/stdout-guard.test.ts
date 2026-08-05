import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * stdout-guard 守卫测试。
 *
 * 守卫封装 process.stdout.write：合法 JSON-line 帧放行，非 JSON 输出转投 stderr。
 * 由于守卫是进程级全局副作用，直接在同一进程测试会污染 node:test 的 TAP 报告输出
 *（TAP 走 stdout）。因此本测试用子进程隔离：在子进程里用 tsx 执行临时 TS 脚本加载守卫并
 * 触发各类写入，父进程通过子进程的 stdout/stderr 管道断言守卫行为，TAP 报告本身不受影响。
 *
 * 用临时文件而非 --eval，避免 Windows 命令行引号/换行转义在多层嵌套下失效。
 * 临时脚本以本测试文件所在目录（host/src）为基准，相对 import "../stdout-guard.js"。
 */

// 基于本测试文件位置定位 host/src，避免依赖 process.cwd()（npm workspace 下 cwd 会变）。
const HOST_SRC = dirname(fileURLToPath(import.meta.url));

/** 运行一段 TS 脚本（写入临时文件再用 tsx 执行），返回 stdout/stderr 分行捕获与退出码。 */
function runChild(scriptBody: string, sidecar: boolean): Promise<{ stdout: string[]; stderr: string[]; code: number | null }> {
  const tmpDir = join(HOST_SRC, ".stdout-guard-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const scriptPath = join(tmpDir, `child-${process.pid}-${Math.random().toString(36).slice(2)}.mts`);
  // 临时脚本位于 host/src/.stdout-guard-tmp/，回退一层 import host/src/stdout-guard.js。
  const script = `import "../stdout-guard.js";\n${scriptBody}\n`;
  writeFileSync(scriptPath, script, "utf8");

  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
    if (sidecar) env.NOVA_PI_SIDECAR = "1";
    else delete env.NOVA_PI_SIDECAR;
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath], { env, cwd: process.cwd() });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      try { rmSync(scriptPath, { force: true }); } catch { /* best effort */ }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8").split("\n").filter(Boolean),
        stderr: Buffer.concat(stderr).toString("utf8").split("\n").filter(Boolean),
        code,
      });
    });
  });
}

test("sidecar 模式下：pdf2json 风格的非 JSON 输出被拦截，不进入 stdout", async () => {
  const body = `
    // 模拟 pdf2json 直接调用 process.stdout.write 的三类污染输出。
    process.stdout.write("Warning: Setting up fake worker.\\n");
    process.stdout.write("(while reading XRef): Error: Invalid XRef stream header\\n");
    process.stdout.write("Error: Error: Error: Invalid XRef stream header\\n    at re (pdfparser.cjs:1:23583)\\n");
  `;
  const { stdout, stderr } = await runChild(body, true);

  // 守卫应把所有非 JSON 行转投 stderr，stdout 保持干净。
  assert.equal(stdout.length, 0, `stdout 应无污染，但捕获到：${JSON.stringify(stdout)}`);
  const guardLines = stderr.filter((l) => l.includes("[stdout-guard]"));
  assert.equal(guardLines.length, 3, `应拦截 3 条污染，实际 stderr 守卫行：${guardLines.length}`);
  assert.ok(guardLines[0].includes("Setting up fake worker"), "首条应保留原文片段");
});

test("sidecar 模式下：合法 JSON-line 帧正常通过 stdout", async () => {
  const body = `
    process.stdout.write(JSON.stringify({ type: "response", id: "abc", success: true }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "event", event: { kind: "message_update", text: "hi" } }) + "\\n");
  `;
  const { stdout, stderr } = await runChild(body, true);

  // 两条合法 JSON 帧都应出现在 stdout，且不被守卫转投 stderr。
  assert.equal(stdout.length, 2, `stdout 应有 2 条 JSON 帧，实际：${JSON.stringify(stdout)}`);
  assert.ok(stdout[0].startsWith('{"type":"response"'), "首条应是 response 帧");
  assert.ok(stdout[1].startsWith('{"type":"event"'), "次条应是 event 帧");
  const guardLines = stderr.filter((l) => l.includes("[stdout-guard]"));
  assert.equal(guardLines.length, 0, `合法帧不应触发守卫，但 stderr 有：${JSON.stringify(guardLines)}`);
});

test("sidecar 模式下：含内部裸换行的 JSON 被拦截", async () => {
  const body = `
    // 异常拼接：两帧被粘进一次写入。writeJsonLine 不会产生这种输入。
    process.stdout.write('{"type":"event"}\\n{"second":"frame"}\\n');
  `;
  const { stdout, stderr } = await runChild(body, true);
  assert.equal(stdout.length, 0, "含内部换行的输出不应进入 stdout");
  const guardLines = stderr.filter((l) => l.includes("[stdout-guard]"));
  assert.equal(guardLines.length, 1, "应作为单次非法写入被拦截一次");
});

test("sidecar 模式下：write(chunk, cb) 拦截后回调被触发", async () => {
  // 用退出码传递 callback 是否触发，避免依赖 stdout 报告。
  const body = `
    let called = false;
    process.stdout.write("Warning: Setting up fake worker.\\n", () => { called = true; });
    process.exit(called ? 0 : 1);
  `;
  const { code } = await runChild(body, true);
  assert.equal(code, 0, "callback 必须被触发（退出码应为 0）");
});

test("sidecar 模式下：write(chunk, encoding, cb) 三参重载回调被触发", async () => {
  const body = `
    let called = false;
    process.stdout.write("Warning: Setting up fake worker.\\n", "utf8", () => { called = true; });
    process.exit(called ? 0 : 1);
  `;
  const { code } = await runChild(body, true);
  assert.equal(code, 0, "三参重载的 callback 必须被触发");
});

test("非 sidecar 模式下：守卫不激活，stdout 写入不被拦截", async () => {
  // 不设置 NOVA_PI_SIDECAR（子进程 env 显式删除该变量），守卫不应安装。
  const body = `
    process.stdout.write("Warning: Setting up fake worker.\\n");
    process.exit(0);
  `;
  const { stdout, code } = await runChild(body, false);
  assert.equal(code, 0, "子进程应正常退出");
  // 守卫未激活时，污染行应原样进入 stdout。
  assert.equal(stdout.length, 1, "未激活守卫时 stdout 应含原始写入");
  assert.ok(stdout[0].includes("Setting up fake worker"), "应保留原文");
});
