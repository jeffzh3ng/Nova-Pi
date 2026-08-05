/**
 * ModelRuntime 配置：把 Rust 存的 ModelSettings 同步到 pi 的 ModelRuntime。
 *
 * pi 内置 DeepSeek provider（api.deepseek.com，openai-completions API），与原 Nova
 * 默认一致。OpenAI 兼容（qwen/local/自定义 baseUrl）通过 setRuntimeApiKey + models.json
 * 覆盖 baseUrl 实现。
 *
 * maxTokens：pi 的 agent loop 调模型时不传 options.maxTokens，最终由
 * pi-ai 的 buildBaseOptions 用 `options?.maxTokens ?? model.maxTokens` 取值
 *（见 node_modules/@earendil-works/pi-ai/dist/api/simple-options.js）。因此前端
 * 设置的 max_tokens 必须覆盖到 model.maxTokens 才能生效——否则永远用 models.json
 * 里的目录值（如 deepseek-v4-pro 的 4096），前端配置被静默忽略。
 *
 * temperature：pi-ai 的 buildBaseOptions 用 `options?.temperature`，而 agent loop
 * 不传该 option、Model 接口也无此字段，故当前架构下前端 temperature 配置无法生效
 *（属 SDK 限制，非本层可修复）。
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
  // 把前端配置的 baseUrl / maxTokens 覆盖到解析出的 model 上。
  // - baseUrl：允许前端指向自建网关或镜像。
  // - maxTokens：pi 的 agent loop 不传 options.maxTokens，最终由 buildBaseOptions
  //   取 model.maxTokens（见文件头注释）。不覆盖则前端配置被静默忽略。
  const applyOverrides = (model: Model<any>): Model<any> => ({
    ...model,
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    ...(Number.isFinite(settings.maxTokens) && settings.maxTokens > 0 ? { maxTokens: settings.maxTokens } : {}),
  });
  const runtimeModel = runtime.getModel(settings.provider, configuredModelId);
  if (runtimeModel) {
    return applyOverrides(runtimeModel);
  }

  // DeepSeek：pi 内置 provider，按 id 匹配
  if (settings.provider === "deepseek") {
    const modelId = settings.model || "deepseek-v4-pro";
    // 优先用 runtime 注册的（可能已通过 models.json 自定义 baseUrl）
    const fromRuntime = runtime.getModel("deepseek", modelId);
    if (fromRuntime) return applyOverrides(fromRuntime as Model<any>);
    // 回退到 pi 内置目录（getModel 的 modelId 是字面量联合，这里动态传入需 as any）
    const builtin = getModel("deepseek", modelId as never);
    if (builtin) {
      return applyOverrides(builtin);
    }
    // 未知 deepseek 模型：构造一个最小兼容模型
    return applyOverrides(makeOpenAiCompatModel("deepseek", modelId, settings.baseUrl || "https://api.deepseek.com"));
  }

  // qwen / local / openai-compatible：全部按 OpenAI 兼容处理
  const provider = settings.provider || "openai-compatible";
  const modelId = settings.model || "gpt-4.1-mini";
  const baseUrl = settings.baseUrl || defaultBaseUrlForProvider(provider);
  return applyOverrides(makeOpenAiCompatModel(provider, modelId, baseUrl));
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
