import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourceEntry = join(scriptDir, "..", "dist", "main.js");
const isolatedDir = await mkdtemp(join(tmpdir(), "nova-pi-host-bundle-"));
const isolatedEntry = join(isolatedDir, "main.js");
const agentDir = join(isolatedDir, "agent");
let child;

const waitForExit = async (process, timeoutMs = 5_000) => {
  if (process.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => process.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("standalone host did not exit in time")), timeoutMs),
    ),
  ]);
};

try {
  const bundleSource = await readFile(sourceEntry, "utf8");
  if (!bundleSource.includes("Select OpenAI Codex login method")) {
    throw new Error("standalone host did not statically bundle the OpenAI Codex OAuth flow");
  }
  await copyFile(sourceEntry, isolatedEntry);
  child = spawn(process.execPath, [isolatedEntry, agentDir], {
    cwd: isolatedDir,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });

  const pending = new Map();
  const receivedEvents = [];
  const eventWaiters = new Set();
  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.type === "event" && message.event) {
        receivedEvents.push(message.event);
        for (const waiter of eventWaiters) {
          if (!waiter.predicate(message.event)) continue;
          eventWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(message.event);
        }
        return;
      }
      if (message.type !== "response" || typeof message.id !== "string") return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.success) waiter.resolve(message.data);
      else waiter.reject(new Error(message.error || "standalone host RPC failed"));
    } catch {
      // Host stdout is a JSON-line protocol; non-JSON output is ignored here and
      // will still make the requested RPC time out with stderr attached.
    }
  });

  const rpc = (command, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const id = `bundle-${command.type}-${Date.now()}-${Math.random()}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`standalone host RPC timeout: ${command.type}\n${stderr}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });

  const waitForEvent = (predicate, timeoutMs = 15_000) => {
    const existing = receivedEvents.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          eventWaiters.delete(waiter);
          reject(new Error(`standalone host event timeout\n${stderr}`));
        }, timeoutMs),
      };
      eventWaiters.add(waiter);
    });
  };

  const state = await rpc({ type: "get_state" });
  if (state?.status !== "ready") throw new Error("standalone host did not become ready");

  await rpc({
    type: "models_upsert_provider",
    provider: {
      id: "bundle-smoke",
      name: "Bundle Smoke",
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      apiKey: "bundle-smoke-key",
      models: [{ id: "bundle-smoke-model" }],
    },
  });
  const providers = await rpc({ type: "models_list_providers" });
  if (!providers?.some((provider) => provider.id === "bundle-smoke")) {
    throw new Error("standalone host did not persist the provider");
  }
  const defaultModel = await rpc({ type: "models_get_default" });
  if (defaultModel?.provider !== "bundle-smoke" || defaultModel?.model !== "bundle-smoke-model") {
    throw new Error("standalone host did not make the first provider model the default");
  }

  const oauth = await rpc({
    type: "models_login_oauth",
    providerId: "openai-codex",
    modelId: "gpt-5.5",
  });
  await waitForEvent((event) => event.type === "model_auth" && event.loginId === oauth.loginId && event.phase === "auth_url");
  await rpc({ type: "models_cancel_oauth", loginId: oauth.loginId });
  await waitForEvent((event) => event.type === "model_auth" && event.loginId === oauth.loginId && event.phase === "cancelled");

  await rpc({ type: "shutdown" });
  await waitForExit(child);
  console.log("Standalone host bundle verification passed.");
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await waitForExit(child).catch(() => undefined);
  }
  await rm(isolatedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
