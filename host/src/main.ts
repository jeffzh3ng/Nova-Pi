/**
 * Nova-PI sidecar 入口：pi agent 内核。
 *
 * 通信：newline-delimited JSON over stdin/stdout。
 * - stdin：RpcCommand（来自 Rust 转发）
 * - stdout：RpcResponse（同步响应，按 id 匹配）+ RpcEventEnvelope（异步事件流）
 * - stderr：日志（Rust 收集后输出到控制台/日志文件）
 *
 * Rust 启动时传入 agentDir（appDataDir/.pi/agent）作为 argv[2]。
 *
 * 注意：本文件顶部不要写 shebang。tsup 打包时通过 banner 注入 #!/usr/bin/env node，
 * 源文件里再写一遍会导致 dist 里出现两个 shebang，ESM 解析报语法错。
 */

import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionPool } from "./session-pool.js";
import { initModelRuntime, getModelRuntime } from "./model-setup.js";
import { mcpRegistry } from "./mcp/registry.js";
import { initBaseResourceLoader, listDiscoveredSkills } from "./skills/loader.js";
import { writeResponse, writeEvent, type RpcCommand, type McpServerConfig } from "./rpc-protocol.js";
import {
  initModelsManagerPaths,
  listProviders,
  listAllModels,
  getDefaultModel,
  getProviderModelSettings,
  setDefaultModel,
  testProviderConnection,
  upsertProvider,
  removeProvider,
  setProviderApiKey,
  upsertModel,
  removeModel,
  type ModelsJsonModel,
} from "./models-manager.js";
import {
  initExtensionsManagerPaths,
  listExtensions,
  addExtension,
  removeExtension,
  setExtensionEnabled,
  readExtensionContent,
  createExtension,
  DEFAULT_EXTENSION_TEMPLATE,
} from "./extensions-manager.js";

// ── 初始化 ───────────────────────────────────────────────────────────────────

const agentDir = process.argv[2] || join(process.env.HOME || process.cwd(), ".nova-pi", "agent");
mkdirSync(agentDir, { recursive: true });

let pool: SessionPool | null = null;
let shuttingDown = false;

async function bootstrap(): Promise<void> {
  stderrLog(`[nova-pi-host] agentDir=${agentDir}`);
  await initModelRuntime(agentDir);
  initModelsManagerPaths(agentDir);
  initExtensionsManagerPaths(agentDir);
  await initBaseResourceLoader(agentDir);
  pool = new SessionPool();
  try {
    const defaultModel = await getDefaultModel();
    if (defaultModel) {
      await pool.setModelSettings(
        await getProviderModelSettings(defaultModel.provider, defaultModel.model),
      );
    }
  } catch (error) {
    stderrLog(`[nova-pi-host] 默认模型加载失败：${error instanceof Error ? error.message : String(error)}`);
  }
  stderrLog("[nova-pi-host] pi runtime ready");
}

// ── 命令分发 ─────────────────────────────────────────────────────────────────

async function handleCommand(command: RpcCommand): Promise<void> {
  const id = command.id;
  try {
    switch (command.type) {
      case "new_session": {
        if (!pool) throw new Error("host 尚未就绪");
        const sessionId = await pool.createSession({
          humanId: command.humanId,
          conversationId: command.conversationId,
          mcpServiceId: command.mcpServiceId,
          resumeMessages: command.resumeMessages,
        });
        writeResponse(id, true, sessionId);
        return;
      }
      case "dispose_session": {
        await pool?.dispose(command.sessionId);
        writeResponse(id, true);
        return;
      }
      case "prompt": {
        if (!pool) throw new Error("host 尚未就绪");
        // 先校验 session 存在性：不存在直接同步失败，避免"响应成功后又收到 error 事件"
        // 的状态机不一致（前端 sendRpc 会 reject，不会误以为已开始）。
        if (!pool.hasSession(command.sessionId)) {
          writeResponse(id, false, `会话不存在：${command.sessionId}`);
          return;
        }
        // 异步触发：立即响应成功，流式事件通过 forwardEvent 回流
        writeResponse(id, true);
        void pool.prompt({
          sessionId: command.sessionId,
          message: command.message,
          attachments: command.attachments,
        }).catch((error) => {
          writeEvent({
            type: "error",
            sessionId: command.sessionId,
            message: error instanceof Error ? error.message : String(error),
            recoverable: false,
          });
        });
        return;
      }
      case "steer": {
        if (!pool) throw new Error("host 尚未就绪");
        // MVP：steer 暂不实现（pi 的 steer 需 session 在 streaming 中）
        writeResponse(id, true);
        return;
      }
      case "abort": {
        await pool?.abort(command.sessionId);
        writeResponse(id, true);
        return;
      }
      case "set_model": {
        // Rust 已把 ModelSettings 存 SQLite；这里 host 收到 set_model 时同步到 pool
        await pool?.setModelSettings({
          provider: command.provider,
          apiKey: command.apiKey ?? "",
          baseUrl: command.baseUrl ?? "",
          model: command.modelId,
          temperature: command.temperature ?? 0.2,
          maxTokens: command.maxTokens ?? 12288,
          proxyUrl: command.proxyUrl ?? "",
        });
        writeResponse(id, true);
        return;
      }
      case "test_model": {
        // 用 runtime 验证：尝试 listModels，确认 provider 有 key
        try {
          const runtime = getModelRuntime();
          const available = await runtime.getAvailable();
          if (available.length === 0) {
            writeResponse(id, false, "未检测到可用模型，请在设置面板配置 API Key。");
            return;
          }
          writeResponse(id, true, "连接成功");
        } catch (error) {
          writeResponse(id, false, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "get_state": {
        writeResponse(id, true, { status: "ready" });
        return;
      }
      case "configure_mcp": {
        const results = await mcpRegistry.configure(command.servers as McpServerConfig[]);
        writeResponse(id, true, results);
        return;
      }
      case "list_mcp_tools": {
        const server = await mcpRegistry.getOrConnect(command.serviceId);
        writeResponse(id, true, server.tools);
        return;
      }
      case "test_mcp": {
        const server = await mcpRegistry.getOrConnect(command.serviceId);
        writeResponse(id, true, { toolCount: server.tools.length });
        return;
      }
      case "mcp_call": {
        const result = await mcpRegistry.callTool(
          command.serviceId,
          command.toolName,
          command.args,
          command.timeoutSecs,
        );
        writeResponse(id, true, result);
        return;
      }
      case "list_skills": {
        writeResponse(id, true, listDiscoveredSkills());
        return;
      }
      case "resolve_skill": {
        // MVP：skills 由 pi ResourceLoader 注入 system prompt，前端命中测试用本地 resolver
        writeResponse(id, true, { skillId: null });
        return;
      }
      // 注：risk_list_matrices / risk_submit / risk_status / risk_cancel 命令已移除。
      // 风评流程完全走 mcp_call（data-security-risk-assessment-mcp 的工具），由 pi 自主调用，
      // 前端 pollRiskAssessment 每 3s 轮询 get_task_status。host 不再做风评编排。
      // ── 模型管理 ──
      case "models_list_providers": {
        writeResponse(id, true, await listProviders(getModelRuntime()));
        return;
      }
      case "models_list_all": {
        writeResponse(id, true, listAllModels(getModelRuntime()));
        return;
      }
      case "models_get_default": {
        writeResponse(id, true, await getDefaultModel());
        return;
      }
      case "models_set_default": {
        const settings = await getProviderModelSettings(command.provider, command.model);
        await setDefaultModel(command.provider, command.model);
        await pool?.setModelSettings(settings);
        writeResponse(id, true);
        return;
      }
      case "models_test_provider": {
        await testProviderConnection(command.providerId, command.modelId);
        writeResponse(id, true, "连接成功");
        return;
      }
      case "models_upsert_provider": {
        await upsertProvider(getModelRuntime(), command.provider as Parameters<typeof upsertProvider>[1]);
        writeResponse(id, true);
        return;
      }
      case "models_remove_provider": {
        await removeProvider(getModelRuntime(), command.providerId);
        writeResponse(id, true);
        return;
      }
      case "models_set_api_key": {
        await setProviderApiKey(getModelRuntime(), command.providerId, command.apiKey);
        writeResponse(id, true);
        return;
      }
      case "models_upsert_model": {
        await upsertModel(getModelRuntime(), command.providerId, command.model as ModelsJsonModel);
        writeResponse(id, true);
        return;
      }
      case "models_remove_model": {
        await removeModel(getModelRuntime(), command.providerId, command.modelId);
        writeResponse(id, true);
        return;
      }
      // ── 扩展管理 ──
      case "extensions_list": {
        writeResponse(id, true, await listExtensions());
        return;
      }
      case "extensions_add": {
        await addExtension(command.path);
        writeResponse(id, true);
        return;
      }
      case "extensions_remove": {
        await removeExtension(command.extensionId);
        writeResponse(id, true);
        return;
      }
      case "extensions_set_enabled": {
        await setExtensionEnabled(command.extensionId, command.enabled);
        writeResponse(id, true);
        return;
      }
      case "extensions_read_content": {
        writeResponse(id, true, await readExtensionContent(command.extensionId));
        return;
      }
      case "extensions_create": {
        const ext = await createExtension(command.name, command.template ?? DEFAULT_EXTENSION_TEMPLATE);
        writeResponse(id, true, ext);
        return;
      }
      case "shutdown": {
        writeResponse(id, true);
        void gracefulShutdown();
        return;
      }
      default: {
        writeResponse(id, false, `未知命令类型：${(command as { type: string }).type}`);
      }
    }
  } catch (error) {
    writeResponse(id, false, error instanceof Error ? error.message : String(error));
  }
}

// ── stdin/stdout 读写 ────────────────────────────────────────────────────────

function startRpcLoop(): void {
  // Only start consuming stdin after bootstrap has completed. Commands written
  // by Rust during startup remain buffered by the pipe, so model/MCP requests
  // cannot observe half-initialized manager paths or an empty session pool.
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let command: RpcCommand;
    try {
      command = JSON.parse(trimmed) as RpcCommand;
    } catch (error) {
      stderrLog(`[nova-pi-host] 无效 JSON：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    void handleCommand(command);
  });

  rl.on("close", () => {
    void gracefulShutdown();
  });
}

// ── 关闭 ─────────────────────────────────────────────────────────────────────

async function gracefulShutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  stderrLog("[nova-pi-host] shutting down");
  try {
    await pool?.disposeAll();
    await mcpRegistry.dispose();
  } catch (error) {
    stderrLog(`[nova-pi-host] shutdown error: ${error}`);
  }
  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown());
process.on("SIGINT", () => void gracefulShutdown());
process.on("uncaughtException", (error) => {
  stderrLog(`[nova-pi-host] uncaughtException: ${error.stack ?? error}`);
});
process.on("unhandledRejection", (reason) => {
  stderrLog(`[nova-pi-host] unhandledRejection: ${reason}`);
});

function stderrLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

// ── 启动 ─────────────────────────────────────────────────────────────────────

void bootstrap()
  .then(() => startRpcLoop())
  .catch((error) => {
    stderrLog(`[nova-pi-host] bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
    process.exit(1);
  });
