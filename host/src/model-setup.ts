/**
 * ModelRuntime 配置：把 Rust 存的 ModelSettings 同步到 pi 的 ModelRuntime。
 *
 * pi 内置 DeepSeek provider（api.deepseek.com，openai-completions API），与原 Nova
 * 默认一致。OpenAI 兼容（qwen/local/自定义 baseUrl）通过 setRuntimeApiKey + models.json
 * 覆盖 baseUrl 实现。
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export type HostModelSettings = {
  provider: string; // deepseek | openai-compatible | qwen | local
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  proxyUrl: string;
};

let modelRuntime: ModelRuntime | null = null;

/** 初始化 ModelRuntime（在 appDataDir 下存 auth.json / models.json）。 */
export async function initModelRuntime(agentDir: string): Promise<ModelRuntime> {
  mkdirSync(agentDir, { recursive: true });
  modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  return modelRuntime;
}

export function getModelRuntime(): ModelRuntime {
  if (!modelRuntime) throw new Error("ModelRuntime 未初始化。");
  return modelRuntime;
}

/** 解析模型：优先用 provider/modelId 匹配 pi 内置目录，否则按 baseUrl 构造 OpenAI 兼容模型。 */
export function resolveModel(settings: HostModelSettings): Model<any> {
  const runtime = getModelRuntime();
  const configuredModelId = settings.model || "default";
  const runtimeModel = runtime.getModel(settings.provider, configuredModelId);
  if (runtimeModel) {
    return settings.baseUrl ? { ...runtimeModel, baseUrl: settings.baseUrl } : runtimeModel;
  }

  // DeepSeek：pi 内置 provider，按 id 匹配
  if (settings.provider === "deepseek") {
    const modelId = settings.model || "deepseek-v4-pro";
    // 优先用 runtime 注册的（可能已通过 models.json 自定义 baseUrl）
    const fromRuntime = runtime.getModel("deepseek", modelId);
    if (fromRuntime) return fromRuntime as Model<any>;
    // 回退到 pi 内置目录（getModel 的 modelId 是字面量联合，这里动态传入需 as any）
    const builtin = getModel("deepseek", modelId as never);
    if (builtin) {
      return settings.baseUrl ? { ...builtin, baseUrl: settings.baseUrl } : builtin;
    }
    // 未知 deepseek 模型：构造一个最小兼容模型
    return makeOpenAiCompatModel("deepseek", modelId, settings.baseUrl || "https://api.deepseek.com");
  }

  // qwen / local / openai-compatible：全部按 OpenAI 兼容处理
  const provider = settings.provider || "openai-compatible";
  const modelId = settings.model || "gpt-4.1-mini";
  const baseUrl = settings.baseUrl || defaultBaseUrlForProvider(provider);
  return makeOpenAiCompatModel(provider, modelId, baseUrl);
}

function defaultBaseUrlForProvider(provider: string): string {
  switch (provider) {
    case "qwen":
      return "https://dashscope.aliyuncs.com/compatible-mode/v1";
    case "local":
      return "http://127.0.0.1:11434/v1";
    default:
      return "https://api.openai.com/v1";
  }
}

/** 构造一个 OpenAI 兼容（openai-completions API）的最小模型描述符。 */
function makeOpenAiCompatModel(provider: string, modelId: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 12_288,
  } as unknown as Model<"openai-completions">;
}

/** 把 API key 同步到 ModelRuntime（每次 set_model / prompt 前调用）。 */
export function applyApiKey(settings: HostModelSettings): void {
  if (settings.apiKey) {
    const provider = settings.provider === "deepseek" ? "deepseek" : settings.provider || "openai-compatible";
    getModelRuntime().setRuntimeApiKey(provider, settings.apiKey);
  }
}
