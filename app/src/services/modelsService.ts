/**
 * Pi 模型管理服务：封装 host 的 models_* RPC，供 SettingsPanel 调用。
 *
 * pi 的模型配置完全基于 models.json，pi 在每次 /model 时重载。本服务通过 host
 * 读写 models.json + ModelRuntime，实现 provider/model 的增删改、API key 管理、
 * 默认模型切换。
 */

import { sendRpc } from "./hostBridge";
import type {
  ModelsProviderInput,
  ModelsModelInput,
  ProviderSummary,
  ModelSummary,
  DefaultModelInfo,
} from "./hostBridge";

/** pi 支持的 API 类型（provider 配置的下拉选项）。与 host PI_API_TYPES 对齐。 */
export const PI_API_TYPES = [
  { value: "openai-completions", label: "OpenAI 兼容（Completions）" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
  { value: "bedrock-converse-stream", label: "AWS Bedrock" },
  { value: "mistral-conversations", label: "Mistral" },
] as const;

/** 列出 models.json 里配置的全部 provider（含模型、可用性、API key 脱敏）。 */
export async function listProviders(): Promise<ProviderSummary[]> {
  return await sendRpc<ProviderSummary[]>({ type: "models_list_providers" });
}

/** 列出 runtime 中所有可用模型（pi 内置 + 自定义），供默认模型下拉选择。 */
export async function listAllModels(): Promise<ModelSummary[]> {
  return await sendRpc<ModelSummary[]>({ type: "models_list_all" });
}

/** 读取当前默认 provider + model。 */
export async function getDefaultModel(): Promise<DefaultModelInfo | null> {
  return await sendRpc<DefaultModelInfo | null>({ type: "models_get_default" });
}

/** 设置默认 provider + model（写入 settings.json）。 */
export async function setDefaultModel(provider: string, model: string): Promise<void> {
  await sendRpc({ type: "models_set_default", provider, model });
}

/** 新增或覆盖一个 provider（含模型列表）。 */
export async function upsertProvider(provider: ModelsProviderInput): Promise<void> {
  await sendRpc({ type: "models_upsert_provider", provider });
}

/** 删除一个 provider。 */
export async function removeProvider(providerId: string): Promise<void> {
  await sendRpc({ type: "models_remove_provider", providerId });
}

/** 设置 provider 的 API key（同时更新 models.json 和 runtime 内存层）。 */
export async function setProviderApiKey(providerId: string, apiKey: string): Promise<void> {
  await sendRpc({ type: "models_set_api_key", providerId, apiKey });
}

/** 给 provider 增删改单个 model。 */
export async function upsertModel(providerId: string, model: ModelsModelInput): Promise<void> {
  await sendRpc({ type: "models_upsert_model", providerId, model });
}

export async function removeModel(providerId: string, modelId: string): Promise<void> {
  await sendRpc({ type: "models_remove_model", providerId, modelId });
}
