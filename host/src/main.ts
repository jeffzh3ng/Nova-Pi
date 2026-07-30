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
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
// ModelRuntime 来自 coding-agent 自带的 pi-ai 实例。显式注册同一实例的静态 OAuth
// loaders，确保 tsup 的单文件安装包不会保留运行时无法解析的动态 import。
import { registerBunOAuthFlows } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/bun-oauth.js";
import { SessionPool } from "./session-pool.js";
import { initModelRuntime, getModelRuntime } from "./model-setup.js";
import { mcpRegistry } from "./mcp/registry.js";
import {
  initBaseResourceLoader,
  listDiscoveredSkills,
  reloadSkillResources,
} from "./skills/loader.js";
import { initSkillRuntime } from "./skills/runtime.js";
import { writeResponse, writeEvent, type RpcCommand, type McpServerConfig } from "./rpc-protocol.js";
import {
  initModelsManagerPaths,
  listProviders,
  listAllModels,
  getDefaultModel,
  getProviderModelSettings,
  setDefaultModel,
  testProviderConnection,
  loginOAuthProvider,
  upsertProvider,
  removeProvider,
  setProviderApiKey,
  upsertModel,
  removeModel,
  generateTitleWithLlm,
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
import { WeixinBotManager } from "./weixinbot/manager.js";
import { TelegramBotManager } from "./telegrambot/manager.js";
import type { TelegramConfig } from "./telegrambot/types.js";
import { FeishuBotManager } from "./feishubot/manager.js";
import { normalizeFeishuConfig, type FeishuConfig } from "./feishubot/types.js";

// ── 初始化 ───────────────────────────────────────────────────────────────────

const agentDir = process.argv[2] || join(process.env.HOME || process.cwd(), ".nova-pi", "agent");
const bundledSkillDir = process.argv[3]?.trim() || "";
const skillStatePath = process.argv[4]?.trim() || join(agentDir, "..", "..", "skill-state.json");
const additionalSkillPaths = bundledSkillDir ? [bundledSkillDir] : [];
mkdirSync(agentDir, { recursive: true });
registerBunOAuthFlows();

let pool: SessionPool | null = null;
let weixinBot: WeixinBotManager | null = null;
/** telegramBot 懒初始化：首次 telegram_start 时按前端 config 创建。 */
let telegramBot: TelegramBotManager | null = null;
/** 飞书按渠道实例 ID 管理，允许多个应用同时连接并分别绑定数字员工。 */
const feishuBots = new Map<string, FeishuBotManager>();
let shuttingDown = false;
const pendingOAuthLogins = new Map<string, AbortController>();

async function bootstrap(): Promise<void> {
  stderrLog(`[nova-pi-host] agentDir=${agentDir}`);
  await initModelRuntime(agentDir);
  initModelsManagerPaths(agentDir);
  initExtensionsManagerPaths(agentDir);
  initSkillRuntime(agentDir, additionalSkillPaths, skillStatePath);
  await initBaseResourceLoader(agentDir, additionalSkillPaths);
  pool = new SessionPool();
  weixinBot = new WeixinBotManager(pool, agentDir);
  try {
    const defaultModel = await getDefaultModel();
    if (defaultModel) {
      await pool.setModelSettings(
        await getProviderModelSettings(getModelRuntime(), defaultModel.provider, defaultModel.model),
      );
    }
  } catch (error) {
    stderrLog(`[nova-pi-host] 默认模型加载失败：${error instanceof Error ? error.message : String(error)}`);
  }
  stderrLog("[nova-pi-host] pi runtime ready");
}

async function runOAuthLogin(
  loginId: string,
  providerId: string,
  modelId: string | undefined,
  controller: AbortController,
): Promise<void> {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 5 * 60_000);
  try {
    await loginOAuthProvider(getModelRuntime(), providerId, modelId, {
      signal: controller.signal,
      prompt: async (prompt) => {
        if (prompt.type === "select") return "browser";
        if (prompt.type === "manual_code") {
          return waitForOAuthAbort(controller.signal, prompt.signal);
        }
        throw new Error("当前 OAuth 流程要求了未支持的输入。请重试授权。");
      },
      notify: (event) => {
        if (event.type === "auth_url") {
          writeEvent({
            type: "model_auth",
            loginId,
            providerId,
            phase: "auth_url",
            url: event.url,
            message: event.instructions ?? "请在浏览器中完成 ChatGPT 授权。",
          });
        } else if (event.type === "device_code") {
          writeEvent({
            type: "model_auth",
            loginId,
            providerId,
            phase: "device_code",
            url: event.verificationUri,
            userCode: event.userCode,
            message: "请在浏览器中输入设备码完成授权。",
          });
        } else if (event.type === "progress" || event.type === "info") {
          writeEvent({
            type: "model_auth",
            loginId,
            providerId,
            phase: "progress",
            message: event.message,
            url: event.type === "info" ? event.links?.[0]?.url : undefined,
          });
        }
      },
    });

    const defaultModel = await getDefaultModel();
    if (defaultModel?.provider === providerId) {
      await pool?.setModelSettings(
        await getProviderModelSettings(
          getModelRuntime(),
          defaultModel.provider,
          defaultModel.model,
        ),
      );
    }
    writeEvent({
      type: "model_auth",
      loginId,
      providerId,
      phase: "complete",
      message: "ChatGPT 账号授权成功。",
      defaultModel,
    });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    writeEvent({
      type: "model_auth",
      loginId,
      providerId,
      phase: cancelled ? "cancelled" : "error",
      message: timedOut
        ? "等待账号授权超时，请重新保存配置后再试。"
        : cancelled
          ? "已取消账号授权。"
          : error instanceof Error
            ? error.message
            : String(error),
    });
  } finally {
    clearTimeout(timeout);
    pendingOAuthLogins.delete(loginId);
  }
}

function waitForOAuthAbort(...signals: Array<AbortSignal | undefined>): Promise<string> {
  return new Promise((_resolve, reject) => {
    const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
    const cleanup = () => {
      for (const signal of activeSignals) signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("授权等待已取消。"));
    };
    if (activeSignals.some((signal) => signal.aborted)) {
      onAbort();
      return;
    }
    for (const signal of activeSignals) signal.addEventListener("abort", onAbort, { once: true });
  });
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
        // abort 是"尽力而为"：失败时仍响应成功（前端会乐观地退出 busy），
        // 但额外 emit 一个 recoverable error 事件，让 UI 知道 agent loop 可能仍在跑。
        // 这比之前静默吞错（前端永远卡 busy 直到 5min 安全超时）更可控。
        try {
          await pool?.abort(command.sessionId);
        } catch (error) {
          writeEvent({
            type: "error",
            sessionId: command.sessionId,
            message: `中止失败，agent loop 可能仍在运行：${error instanceof Error ? error.message : String(error)}`,
            recoverable: true,
          });
        }
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
        writeResponse(id, true, { status: "ready", nova: pool?.getNovaStatus() });
        return;
      }
      case "configure_computer_agent": {
        if (!pool) throw new Error("host 尚未就绪");
        const settings = await pool.configureComputerAgent(command.settings);
        writeResponse(id, true, settings);
        return;
      }
      case "update_nova_context": {
        if (!pool) throw new Error("host 尚未就绪");
        pool.updateNovaContext(command.conversations as Parameters<SessionPool["updateNovaContext"]>[0]);
        writeResponse(id, true);
        return;
      }
      case "get_nova_status": {
        if (!pool) throw new Error("host 尚未就绪");
        writeResponse(id, true, pool.getNovaStatus());
        return;
      }
      case "manage_nova_task": {
        if (!pool) throw new Error("host 尚未就绪");
        const result = await pool.manageNovaTask(command.conversationId, command.action);
        writeResponse(id, true, result);
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
        writeResponse(id, true, {
          toolCount: server.tools.length,
          transportKind: server.transportKind,
          protocolEra: server.protocolEra,
          protocolVersion: server.protocolVersion,
        });
        return;
      }
      case "reconnect_mcp": {
        // 强制断开旧子进程后重新 spawn；用于 Python 侧 config.local.json 变化后让用户手动重启。
        const server = await mcpRegistry.reconnect(command.serviceId);
        writeResponse(id, true, {
          toolCount: server.tools.length,
          transportKind: server.transportKind,
          protocolEra: server.protocolEra,
          protocolVersion: server.protocolVersion,
        });
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
      case "reload_skills": {
        await reloadSkillResources();
        await pool?.reloadSkillSessions();
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
        const settings = await getProviderModelSettings(getModelRuntime(), command.provider, command.model);
        await setDefaultModel(command.provider, command.model);
        await pool?.setModelSettings(settings);
        writeResponse(id, true);
        return;
      }
      case "models_test_provider": {
        await testProviderConnection(getModelRuntime(), command.providerId, command.modelId);
        writeResponse(id, true, "连接成功");
        return;
      }
      case "models_login_oauth": {
        if (command.providerId !== "openai-codex") {
          throw new Error(`暂不支持该 OAuth 供应商：${command.providerId}`);
        }
        const loginId = randomUUID();
        const controller = new AbortController();
        pendingOAuthLogins.set(loginId, controller);
        writeResponse(id, true, { loginId });
        setImmediate(() => {
          void runOAuthLogin(loginId, command.providerId, command.modelId, controller);
        });
        return;
      }
      case "models_cancel_oauth": {
        const controller = pendingOAuthLogins.get(command.loginId);
        controller?.abort();
        writeResponse(id, true, Boolean(controller));
        return;
      }
      case "models_upsert_provider": {
        const autoDefault = await upsertProvider(
          getModelRuntime(),
          command.provider as Parameters<typeof upsertProvider>[1],
        );
        if (autoDefault) {
          await pool?.setModelSettings(
            await getProviderModelSettings(getModelRuntime(), autoDefault.provider, autoDefault.model),
          );
        }
        writeResponse(id, true, autoDefault);
        return;
      }
      case "models_remove_provider": {
        const defaultCleared = await removeProvider(getModelRuntime(), command.providerId);
        writeResponse(id, true, { defaultCleared });
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
      case "generate_title": {
        // transcript 由 Rust 拼好（取自 SQLite 会话消息）；host 只负责用默认模型调一次 LLM。
        // 失败时返回 null，Rust 端回退到首条用户消息截断。
        try {
          const title = await generateTitleWithLlm(getModelRuntime(), command.transcript);
          writeResponse(id, true, { title });
        } catch (error) {
          writeResponse(id, true, { title: null, error: error instanceof Error ? error.message : String(error) });
        }
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
      // ── 微信机器人 ──
      case "weixin_start": {
        if (!weixinBot) throw new Error("host 尚未就绪");
        await weixinBot.start(command.humanId);
        writeResponse(id, true);
        return;
      }
      case "weixin_stop": {
        await weixinBot?.stop();
        writeResponse(id, true);
        return;
      }
      case "weixin_login": {
        if (!weixinBot) throw new Error("host 尚未就绪");
        // 异步触发：扫码流程较长，立即响应成功，二维码/状态通过事件回流
        writeResponse(id, true);
        void weixinBot.login().catch((error) => {
          writeEvent({
            type: "wechat_status",
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }
      case "weixin_status": {
        writeResponse(id, true, weixinBot?.getStatus() ?? { kind: "offline" });
        return;
      }
      case "weixin_switch_human": {
        if (!weixinBot) throw new Error("host 尚未就绪");
        await weixinBot.switchHuman(command.humanId);
        writeResponse(id, true);
        return;
      }
      // ── Telegram 机器人 ──
      case "telegram_start": {
        if (!pool) throw new Error("host 尚未就绪");
        const config = command.config as unknown as TelegramConfig;
        // 首次创建实例；后续 start 复用并更新 config。
        // /start 配对后 service 会 emit online 状态（带 allowedUserId），
        // 前端订阅时发现 allowedUserId 变化主动 saveMessageChannel 持久化。
        if (!telegramBot) {
          telegramBot = new TelegramBotManager(pool, config);
        }
        const ok = await telegramBot.start(command.humanId, config);
        writeResponse(id, true, { started: ok });
        return;
      }
      case "telegram_stop": {
        await telegramBot?.stop();
        writeResponse(id, true);
        return;
      }
      case "telegram_dispose": {
        // 彻底释放单例：stop + 置 null，下次 start 会按新 config 重建实例。
        // 删除渠道 / 切换账号 / 解除配对时调用，避免幽灵 bot 长轮询和跨用户串号。
        const bot = telegramBot;
        telegramBot = null;
        if (bot) await bot.stop().catch(() => {});
        writeResponse(id, true);
        return;
      }
      case "telegram_status": {
        writeResponse(id, true, telegramBot?.getStatus() ?? { kind: "offline" });
        return;
      }
      case "telegram_update_config": {
        // 前端注册配置写回 sink（/start 配对后用），或运行时更新 config
        if (command.config) {
          telegramBot?.updateConfig(command.config as unknown as TelegramConfig);
        }
        writeResponse(id, true);
        return;
      }
      case "telegram_reset_pair": {
        // 解除当前 allowedUserId 配对：清空后回到 awaiting_pair，下个 /start 可重新锁定。
        if (telegramBot) {
          const reset = telegramBot.resetPairing();
          writeResponse(id, true, { reset });
        } else {
          writeResponse(id, true, { reset: false });
        }
        return;
      }
      // ── 飞书机器人（多实例） ──
      case "feishu_start": {
        if (!pool) throw new Error("host 尚未就绪");
        const config = normalizeFeishuConfig(command.config as Partial<FeishuConfig>);
        const previous = feishuBots.get(command.channelId);
        if (previous) await previous.stop().catch(() => {});
        const manager = new FeishuBotManager(command.channelId, pool, agentDir);
        feishuBots.set(command.channelId, manager);
        const started = await manager.start(command.humanId, config);
        writeResponse(id, true, { started });
        return;
      }
      case "feishu_stop": {
        await feishuBots.get(command.channelId)?.stop();
        writeResponse(id, true);
        return;
      }
      case "feishu_dispose": {
        const manager = feishuBots.get(command.channelId);
        feishuBots.delete(command.channelId);
        await manager?.stop().catch(() => {});
        writeResponse(id, true);
        return;
      }
      case "feishu_status": {
        writeResponse(id, true, feishuBots.get(command.channelId)?.getStatus() ?? { kind: "offline" });
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
    for (const controller of pendingOAuthLogins.values()) controller.abort();
    pendingOAuthLogins.clear();
    await weixinBot?.stop();
    await telegramBot?.stop();
    await Promise.all([...feishuBots.values()].map((manager) => manager.stop().catch(() => {})));
    feishuBots.clear();
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
