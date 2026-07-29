/**
 * Pi 模型管理：直接读写 pi 的 models.json，并通过 ModelRuntime 反映变更。
 *
 * pi 的模型配置完全基于 ~/.pi/agent/models.json（pi 每次 /model 时重载）。
 * 自定义 provider/model 直接改写该文件；pi 内置 OAuth provider 则由 ModelRuntime
 * 和 auth.json 管理。两类配置均无需重启 sidecar即可生效。
 *
 * models.json 格式（见 pi packages/coding-agent/src/core/model-config.ts）：
 * {
 *   "providers": {
 *     "my-provider": {
 *       "name": "显示名",
 *       "baseUrl": "https://...",
 *       "api": "openai-completions" | "anthropic-messages" | ...,
 *       "apiKey": "sk-... 或 $ENV_VAR",
 *       "models": [ { "id": "...", "name": "...", "contextWindow": 128000, ... } ]
 *     }
 *   }
 * }
 *
 * auth.json 由 ModelRuntime.setRuntimeApiKey 管理（runtime 内存层），同时我们把它
 * 也写进 models.json 的 apiKey 字段持久化，保证重启后仍可用。
 */

import { join, dirname } from "node:path";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveModel, applyApiKey, type HostModelSettings } from "./model-setup.js";

/** pi 支持的 API 类型（用于 provider 配置的下拉选择）。 */
export const PI_API_TYPES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "bedrock-converse-stream",
  "mistral-conversations",
] as const;
export type PiApiType = (typeof PI_API_TYPES)[number];

/** models.json 里的单个 model 定义（pi ModelDefinitionSchema 的子集，足够前端编辑）。 */
export type ModelsJsonModel = {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
};

/** models.json 里的 provider 定义。 */
export type ModelsJsonProvider = {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  models?: ModelsJsonModel[];
};

/** models.json 根结构。 */
export type ModelsJson = {
  providers: Record<string, ModelsJsonProvider>;
};

/** 前端展示用的 provider 摘要（含脱敏的 apiKey、模型数、可用性）。 */
export type ProviderSummary = {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  authType: "api_key" | "oauth";
  hasApiKey: boolean;
  apiKeyHint: string; // 脱敏：sk-***1234
  modelCount: number;
  available: boolean; // 该 provider 是否有可用凭据（ModelRuntime.hasConfiguredAuth）
  models: ModelSummary[];
};

export type ModelSummary = {
  id: string;
  name: string;
  provider: string;
  api: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  available: boolean;
};

/** settings.json 里的默认 provider/model（前端高亮当前选中）。 */
export type DefaultModelInfo = {
  provider: string;
  model: string;
};

let modelsJsonPath = "";
let settingsJsonPath = "";

// 全局写锁：所有 read-modify-write 操作（upsert/remove/setKey）串行化，
// 防止两个并发 RPC 读到同一份旧数据后互相覆盖（导致 apiKey 或 model 丢失）。
let writeChain: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task, task);
  // 无论 task 成功失败，链都继续；保存错误用于返回。
  writeChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** 初始化路径（agentDir = appDataDir/.pi/agent）。 */
export function initModelsManagerPaths(agentDir: string): void {
  modelsJsonPath = join(agentDir, "models.json");
  settingsJsonPath = join(agentDir, "settings.json");
}

/** 读取 models.json（支持 JSON 注释，容错：不存在则返回空 providers）。 */
export async function readModelsJson(): Promise<ModelsJson> {
  if (!existsSync(modelsJsonPath)) return { providers: {} };
  try {
    const raw = await readFile(modelsJsonPath, "utf8");
    const stripped = stripJsonComments(raw);
    const parsed = JSON.parse(stripped) as Partial<ModelsJson>;
    return { providers: parsed.providers ?? {} };
  } catch (error) {
    throw new Error(`读取 models.json 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 写入 models.json（原子写：先写唯一临时文件再 rename）。 */
async function writeModelsJson(config: ModelsJson): Promise<void> {
  await mkdir(dirname(modelsJsonPath), { recursive: true });
  const content = JSON.stringify(config, null, 2);
  // 用 randomUUID 而非 process.pid 做临时文件后缀：同一进程并发写会用相同 tmp 路径，
  // 后写覆盖前写且 rename 顺序不可控，导致写入丢失。
  const tmp = `${modelsJsonPath}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, modelsJsonPath);
}

/** 列出所有 provider + 模型（结合 ModelRuntime 的可用性判断）。 */
export async function listProviders(runtime: ModelRuntime): Promise<ProviderSummary[]> {
  const config = await readModelsJson();
  const settings = await readSettingsJson();
  const summaries: ProviderSummary[] = [];
  for (const [id, provider] of Object.entries(config.providers)) {
    const models: ModelSummary[] = (provider.models ?? []).map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: id,
      api: provider.api ?? "openai-completions",
      reasoning: m.reasoning ?? false,
      contextWindow: m.contextWindow ?? 128_000,
      maxTokens: m.maxTokens ?? 4096,
      available: runtime.hasConfiguredAuth(id),
    }));
    summaries.push({
      id,
      name: provider.name ?? id,
      baseUrl: provider.baseUrl ?? "",
      api: provider.api ?? "openai-completions",
      authType: "api_key",
      hasApiKey: Boolean(provider.apiKey),
      apiKeyHint: maskApiKey(provider.apiKey),
      modelCount: models.length,
      available: runtime.hasConfiguredAuth(id),
      models,
    });
  }
  if (runtime.hasConfiguredAuth("openai-codex")) {
    const provider = runtime.getProvider("openai-codex");
    let oauthAvailable = true;
    let availableModels: readonly Model<Api>[];
    try {
      availableModels = await runtime.getAvailable("openai-codex");
    } catch {
      oauthAvailable = false;
      availableModels = runtime.getModels("openai-codex");
    }
    const preferredModelId = settings.novaProviderModels?.["openai-codex"]
      ?? (settings.defaultProvider === "openai-codex" ? settings.defaultModel : undefined)
      ?? "gpt-5.5";
    const models = availableModels
      .map(modelToSummary(runtime))
      .sort((left, right) => Number(right.id === preferredModelId) - Number(left.id === preferredModelId));
    summaries.push({
      id: "openai-codex",
      name: provider?.name ?? "OpenAI Codex",
      baseUrl: provider?.baseUrl ?? "https://chatgpt.com/backend-api",
      api: "openai-codex",
      authType: "oauth",
      hasApiKey: false,
      apiKeyHint: "ChatGPT OAuth",
      modelCount: models.length,
      available: oauthAvailable,
      models,
    });
  }
  return summaries;
}

/** 新增或覆盖一个 provider（含其模型列表）。 */
export async function upsertProvider(
  runtime: ModelRuntime,
  params: {
    id: string;
    name?: string;
    baseUrl: string;
    api: string;
    apiKey?: string;
    models?: ModelsJsonModel[];
  },
): Promise<DefaultModelInfo | null> {
  return withWriteLock(async () => {
    const id = params.id.trim();
    if (!id) throw new Error("Provider ID 不能为空。");
    const config = await readModelsJson();
    const existing = config.providers[id];
    const provider: ModelsJsonProvider = {
      name: params.name?.trim() || existing?.name || id,
      baseUrl: params.baseUrl.trim(),
      api: params.api,
      models: params.models ?? existing?.models ?? [{ id: "default" }],
    };
    // apiKey 为空时不覆盖已有值（保留旧 key）；非空时更新。
    if (params.apiKey !== undefined && params.apiKey.trim() !== "") {
      provider.apiKey = params.apiKey.trim();
    } else if (existing?.apiKey) {
      provider.apiKey = existing.apiKey;
    }
    config.providers[id] = provider;
    await writeModelsJson(config);
    // apply 到 runtime 失败时回滚 models.json：避免"文件已写、runtime 内存层未注册"
    // 的不一致状态。回滚后 throw 让调用方知道本次 upsert 未生效。
    try {
      applyProviderToRuntime(runtime, id, provider);
    } catch (error) {
      const rollback: ModelsJson = { providers: { ...config.providers } };
      if (existing) {
        rollback.providers[id] = existing;
      } else {
        delete rollback.providers[id];
      }
      await writeModelsJson(rollback).catch(() => undefined);
      throw new Error(
        `应用 provider ${id} 到 runtime 失败，已回滚 models.json：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 初始配置没有默认供应商。首次新增供应商时，将它的第一个有效模型
    // 自动设为默认模型；后续新增或编辑供应商都不改变用户已有的选择。
    if (!existing && !(await getDefaultModel())) {
      const firstModel = provider.models?.find((model) => model.id.trim());
      if (firstModel) {
        const settings = await readSettingsJson();
        settings.defaultProvider = id;
        settings.defaultModel = firstModel.id;
        await writeSettingsJson(settings);
        return { provider: id, model: firstModel.id };
      }
    }
    return null;
  });
}

/** 删除一个 provider。 */
export async function removeProvider(runtime: ModelRuntime, providerId: string): Promise<boolean> {
  return withWriteLock(async () => {
    if (providerId === "openai-codex") {
      await runtime.logout(providerId);
      return clearDefaultModelIfProvider(providerId);
    }
    const config = await readModelsJson();
    if (!config.providers[providerId]) return false;
    delete config.providers[providerId];
    await writeModelsJson(config);
    try {
      await runtime.removeRuntimeApiKey(providerId);
    } catch {
      // ignore
    }
    return clearDefaultModelIfProvider(providerId);
  });
}

/** 设置 provider 的 API key（同时更新 models.json 和 runtime 内存层）。 */
export async function setProviderApiKey(
  runtime: ModelRuntime,
  providerId: string,
  apiKey: string,
): Promise<void> {
  return withWriteLock(async () => {
    const config = await readModelsJson();
    const provider = config.providers[providerId];
    if (!provider) throw new Error(`Provider 不存在：${providerId}`);
    const previousKey = provider.apiKey;
    provider.apiKey = apiKey.trim();
    await writeModelsJson(config);
    // apply 失败时回滚旧 key，保持文件与 runtime 内存层一致。
    try {
      runtime.setRuntimeApiKey(providerId, apiKey.trim());
    } catch (error) {
      provider.apiKey = previousKey;
      await writeModelsJson(config).catch(() => undefined);
      throw new Error(
        `应用 API Key 到 runtime 失败，已回滚 models.json：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

/** 给 provider 增删改单个 model。 */
export async function upsertModel(
  _runtime: ModelRuntime,
  providerId: string,
  model: ModelsJsonModel,
): Promise<void> {
  return withWriteLock(async () => {
    const config = await readModelsJson();
    const provider = config.providers[providerId];
    if (!provider) throw new Error(`Provider 不存在：${providerId}`);
    provider.models = provider.models ?? [];
    const idx = provider.models.findIndex((m) => m.id === model.id);
    if (idx >= 0) provider.models[idx] = model;
    else provider.models.push(model);
    await writeModelsJson(config);
  });
}

export async function removeModel(
  _runtime: ModelRuntime,
  providerId: string,
  modelId: string,
): Promise<void> {
  return withWriteLock(async () => {
    const config = await readModelsJson();
    const provider = config.providers[providerId];
    if (!provider?.models) return;
    provider.models = provider.models.filter((m) => m.id !== modelId);
    await writeModelsJson(config);
  });
}

/** 读取/写入 settings.json 的默认 provider + model。 */
export async function getDefaultModel(): Promise<DefaultModelInfo | null> {
  const settings = await readSettingsJson();
  if (settings.defaultProvider && settings.defaultModel) {
    return { provider: settings.defaultProvider, model: settings.defaultModel };
  }
  return null;
}

/** 把 models.json 中的供应商配置转换为 SessionPool 可直接应用的模型设置。 */
export async function getProviderModelSettings(
  runtime: ModelRuntime,
  providerId: string,
  modelId: string,
): Promise<HostModelSettings> {
  const config = await readModelsJson();
  const provider = config.providers[providerId];
  if (!provider) {
    const model = runtime.getModel(providerId, modelId);
    if (!model) throw new Error(`模型不存在：${providerId}/${modelId}`);
    if (!(await runtime.getAuth(model))) throw new Error("尚未完成账号授权。");
    return {
      provider: providerId,
      apiKey: "",
      baseUrl: "",
      model: modelId,
      temperature: 0.2,
      maxTokens: model.maxTokens,
      proxyUrl: "",
    };
  }
  const model = provider.models?.find((item) => item.id === modelId);
  if (!model) throw new Error(`模型不存在：${providerId}/${modelId}`);
  const apiKey = resolveApiKey(provider.apiKey ?? "");
  if (!apiKey) throw new Error("未配置可用的 API Key。");
  return {
    provider: providerId,
    apiKey,
    baseUrl: provider.baseUrl ?? "",
    model: modelId,
    temperature: 0.2,
    maxTokens: model.maxTokens ?? 4096,
    proxyUrl: "",
  };
}

export async function setDefaultModel(provider: string, model: string): Promise<void> {
  const settings = await readSettingsJson();
  settings.defaultProvider = provider;
  settings.defaultModel = model;
  settings.novaProviderModels = { ...settings.novaProviderModels, [provider]: model };
  await writeSettingsJson(settings);
}

/** 列出 runtime 中所有可用模型（含 pi 内置 + models.json 自定义），供默认模型选择。 */
export function listAllModels(runtime: ModelRuntime): ModelSummary[] {
  return runtime.getModels().map(modelToSummary(runtime));
}

/** 运行 pi 内置 OAuth，并在没有默认模型时把本次供应商设为默认。 */
export async function loginOAuthProvider(
  runtime: ModelRuntime,
  providerId: string,
  requestedModelId: string | undefined,
  interaction: Parameters<ModelRuntime["login"]>[2],
): Promise<DefaultModelInfo> {
  const provider = runtime.getProvider(providerId);
  if (!provider?.auth.oauth) throw new Error(`供应商不支持 OAuth：${providerId}`);
  if (!runtime.hasConfiguredAuth(providerId)) {
    await runtime.login(providerId, "oauth", interaction);
  }

  const models = await runtime.getAvailable(providerId);
  const model = models.find((item) => item.id === requestedModelId)
    ?? models.find((item) => item.id === "gpt-5.5")
    ?? models[0];
  if (!model) throw new Error(`供应商没有可用模型：${providerId}`);

  const selected = { provider: providerId, model: model.id };
  const currentDefault = await getDefaultModel();
  const settings = await readSettingsJson();
  settings.novaProviderModels = { ...settings.novaProviderModels, [providerId]: model.id };
  if (!currentDefault || currentDefault.provider === providerId) {
    settings.defaultProvider = selected.provider;
    settings.defaultModel = selected.model;
  }
  await writeSettingsJson(settings);
  return selected;
}

/**
 * 发起一次极小的真实请求，验证 provider 的 Key、Base URL 和模型 ID。
 * hasConfiguredAuth 只能说明“存在凭据”，不能证明凭据有效，因此卡片状态必须使用本结果。
 */
export async function testProviderConnection(
  runtime: ModelRuntime,
  providerId: string,
  modelId?: string,
): Promise<void> {
  const config = await readModelsJson();
  const provider = config.providers[providerId];
  if (!provider) {
    const model = modelId ? runtime.getModel(providerId, modelId) : runtime.getModels(providerId)[0];
    if (!model) throw new Error(`供应商或模型不存在：${providerId}/${modelId ?? ""}`);
    if (!(await runtime.getAuth(model))) throw new Error("尚未完成账号授权。");
    await completeConnectionTest(runtime, model);
    return;
  }

  const modelConfig = modelId
    ? provider.models?.find((model) => model.id === modelId)
    : provider.models?.[0];
  if (!modelConfig) throw new Error("未配置模型 ID。");

  const apiKey = resolveApiKey(provider.apiKey ?? "");
  if (!apiKey) throw new Error("未配置可用的 API Key。");
  if (!provider.baseUrl?.trim()) throw new Error("未配置 Base URL。");

  const model: Model<Api> = {
    id: modelConfig.id,
    name: modelConfig.name ?? modelConfig.id,
    api: provider.api ?? "openai-completions",
    provider: providerId,
    baseUrl: provider.baseUrl.trim(),
    reasoning: modelConfig.reasoning ?? false,
    input: modelConfig.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelConfig.contextWindow ?? 128_000,
    maxTokens: modelConfig.maxTokens ?? 4096,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await completeSimple(
      model,
      {
        messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }],
      },
      {
        apiKey,
        maxTokens: 8,
        maxRetries: 0,
        timeoutMs: 10_000,
        signal: controller.signal,
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || "模型连接验证失败。");
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error("模型连接验证超时。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 用用户配置的默认模型提炼任务名。
 *
 * 之所以放在 host 而非 Rust：用户实际配置的模型在 pi 的 models.json / ModelRuntime 里，
 * Rust 的 model_settings 表在新架构下已不被前端设置面板写入（call_llm 路径废弃），
 * 直接走 Rust call_llm 会因空 API Key 失败、回退到 fallback 标题，导致标题永远不变。
 * 这里复用 getProviderModelSettings（默认 provider/model + apiKey）+ completeSimple 做单次调用。
 *
 * 失败时返回 null，由调用方（Rust）决定回退策略。
 */
export async function generateTitleWithLlm(
  runtime: ModelRuntime,
  transcript: string,
): Promise<string | null> {
  const text = transcript.trim();
  if (!text) return null;

  const defaultModel = await getDefaultModel();
  if (!defaultModel) {
    throw new Error("未配置默认模型，请在设置面板选择默认供应商和模型。");
  }
  const settings = await getProviderModelSettings(runtime, defaultModel.provider, defaultModel.model);
  const model = resolveModel(settings);
  applyApiKey(settings);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = runtime.isUsingOAuth(model.provider)
      ? await runtime.completeSimple(
          model,
          {
            systemPrompt:
              "你是任务命名助手。根据对话内容提炼一个简明扼要的任务名称。" +
              "要求：8-20 个字，概括核心目标与关键对象，信息要丰富完整；" +
              "不要包含时间、序号、客套话；" +
              "不要加引号、书名号或「任务」「标题」等前缀；不要带标点；" +
              "只输出名称本身，不要任何解释。",
            messages: [{ role: "user", content: `对话内容：\n${text}`, timestamp: Date.now() }],
          },
          {
            maxTokens: 32,
            maxRetries: 0,
            timeoutMs: 18_000,
            signal: controller.signal,
          },
        )
      : await completeSimple(
      model,
      {
        systemPrompt:
          "你是任务命名助手。根据对话内容提炼一个简明扼要的任务名称。" +
          "要求：8-20 个字，概括核心目标与关键对象，信息要丰富完整；" +
          "不要包含时间、序号、客套话；" +
          "不要加引号、书名号或「任务」「标题」等前缀；不要带标点；" +
          "只输出名称本身，不要任何解释。",
        messages: [{ role: "user", content: `对话内容：\n${text}`, timestamp: Date.now() }],
      },
      {
        apiKey: settings.apiKey,
        maxTokens: 32,
        maxRetries: 0,
        timeoutMs: 18_000,
        signal: controller.signal,
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || "模型调用失败。");
    }
    // 提取首个 TextContent 的文本（与 models-manager.ts 既有用法一致）
    const title = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    return title || null;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("提炼任务名超时。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ── 内部帮助 ──

type PiSettings = {
  defaultProvider?: string;
  defaultModel?: string;
  extensions?: string[];
  packages?: unknown[];
  novaProviderModels?: Record<string, string>;
};

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

async function clearDefaultModelIfProvider(providerId: string): Promise<boolean> {
  const settings = await readSettingsJson();
  const wasDefault = settings.defaultProvider === providerId;
  if (wasDefault) {
    delete settings.defaultProvider;
    delete settings.defaultModel;
  }
  const hadPreferredModel = Boolean(settings.novaProviderModels?.[providerId]);
  if (hadPreferredModel && settings.novaProviderModels) {
    delete settings.novaProviderModels[providerId];
  }
  if (wasDefault || hadPreferredModel) await writeSettingsJson(settings);
  return wasDefault;
}

function modelToSummary(runtime: ModelRuntime) {
  return (model: Model<Api>): ModelSummary => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    api: model.api,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    available: runtime.hasConfiguredAuth(model.provider),
  });
}

async function completeConnectionTest(runtime: ModelRuntime, model: Model<Api>): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await runtime.completeSimple(
      model,
      { messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }] },
      { maxTokens: 8, maxRetries: 0, timeoutMs: 10_000, signal: controller.signal },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || "模型连接验证失败。");
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error("模型连接验证超时。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 把 models.json 的 provider 应用到 ModelRuntime 内存层（apiKey + 模型注册）。
 *
 * 失败时向上抛错而非静默吞掉。调用方负责回滚 models.json，否则会出现"文件里有 key
 * 但 runtime 内存层没有"的不一致状态——LLM 调用会因 hasConfiguredAuth=false 而失败，
 * 但 UI 读 models.json 却显示已配置，用户困惑。
 */
function applyProviderToRuntime(runtime: ModelRuntime, providerId: string, provider: ModelsJsonProvider): void {
  if (provider.apiKey) {
    const resolved = resolveApiKey(provider.apiKey);
    if (resolved) runtime.setRuntimeApiKey(providerId, resolved);
  }
}

/** 解析 apiKey 字段：支持明文、$ENV、${ENV}、!command（!command 不在此解析，返回空）。 */
function resolveApiKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("!")) return ""; // shell command 形式，留给 runtime 解析
  if (trimmed.startsWith("$")) {
    const envName = trimmed.replace(/^\$\{?/, "").replace(/\}$/, "");
    return process.env[envName] ?? "";
  }
  return trimmed;
}

/** 脱敏 API key 用于展示：保留前 4 + 后 4，中间用 *。 */
function maskApiKey(raw?: string): string {
  if (!raw) return "";
  const resolved = resolveApiKey(raw);
  if (!resolved) return raw.startsWith("$") ? raw : "已配置（环境变量）";
  if (resolved.length <= 8) return "****";
  return `${resolved.slice(0, 4)}****${resolved.slice(-4)}`;
}

/** 简易 JSON 注释剥离（pi 的 stripJsonComments 等价实现）。 */
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
      // 块注释未闭合（读到末尾）：直接结束，不要再 += 2（否则 i 越界，
      // 下次循环 text[i] 为 undefined，与 "/" 不等落入 result += char，死循环 CPU 100%）。
      if (i >= text.length) break;
      i += 2; // 跳过结尾的 */
      continue;
    }
    result += char;
    i += 1;
  }
  return result;
}
