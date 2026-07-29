/**
 * Pi 模型管理服务：封装 host 的 models_* RPC，供 SettingsPanel 调用。
 *
 * 自定义模型配置基于 models.json；pi 内置供应商（例如 openai-codex）由
 * ModelRuntime 管理凭据。本服务统一封装 provider/model、API Key/OAuth 与默认模型切换。
 */

import { sendRpc, subscribePiEvents } from "./hostBridge";
import type {
  ModelsProviderInput,
  ModelsModelInput,
  ProviderSummary,
  DefaultModelInfo,
  ModelSummary,
  PiEvent,
} from "./hostBridge";

/** pi 支持的 API 类型（provider 配置的下拉选项）。与 host PI_API_TYPES 对齐。 */
export const PI_API_TYPES = [
  { value: "openai-codex", label: "OpenAI Codex（ChatGPT OAuth）" },
  { value: "openai-completions", label: "OpenAI 兼容（Completions）" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "google-generative-ai", label: "Google Generative AI" },
  { value: "bedrock-converse-stream", label: "AWS Bedrock" },
  { value: "mistral-conversations", label: "Mistral" },
] as const;

/** 列出自定义及已授权的内置 provider（含模型、可用性与凭据类型）。 */
export async function listProviders(): Promise<ProviderSummary[]> {
  return await sendRpc<ProviderSummary[]>({ type: "models_list_providers" });
}

/** 读取当前默认 provider + model。 */
export async function getDefaultModel(): Promise<DefaultModelInfo | null> {
  return await sendRpc<DefaultModelInfo | null>({ type: "models_get_default" });
}

/** 设置默认 provider + model（写入 settings.json）。 */
export async function setDefaultModel(provider: string, model: string): Promise<void> {
  await sendRpc({ type: "models_set_default", provider, model });
  window.dispatchEvent(new CustomEvent("nova-model-settings-changed", {
    detail: { provider, model },
  }));
}

/** 列出 pi 内置与自定义的全部模型，用于 OAuth 类型切换后的模型预填。 */
export async function listAllModels(): Promise<ModelSummary[]> {
  return await sendRpc<ModelSummary[]>({ type: "models_list_all" });
}

/** 通过一次极小的真实模型请求验证 Key、Base URL 和模型 ID。 */
export async function testProviderConnection(providerId: string, modelId: string): Promise<void> {
  await sendRpc({ type: "models_test_provider", providerId, modelId });
}

/** 新增或覆盖一个 provider（含模型列表）。 */
export async function upsertProvider(provider: ModelsProviderInput): Promise<DefaultModelInfo | null> {
  const autoDefault = await sendRpc<DefaultModelInfo | null>({ type: "models_upsert_provider", provider });
  if (autoDefault) {
    window.dispatchEvent(new CustomEvent("nova-model-settings-changed", {
      detail: autoDefault,
    }));
  }
  return autoDefault;
}

/** 删除一个 provider。 */
export async function removeProvider(providerId: string): Promise<void> {
  const result = await sendRpc<{ defaultCleared?: boolean }>({ type: "models_remove_provider", providerId });
  if (result.defaultCleared) {
    window.dispatchEvent(new CustomEvent("nova-model-settings-changed", { detail: null }));
  }
}

export type ModelAuthEvent = Extract<PiEvent, { type: "model_auth" }>;

/**
 * 发起 pi 内置 OAuth。host 立即返回 loginId，后续通过 model_auth 事件完成；
 * 授权地址交给设置面板展示，由用户复制到自己的浏览器。
 */
export async function loginOAuthProvider(
  providerId: string,
  modelId: string,
  callbacks: {
    onStarted?: (loginId: string) => void;
    onEvent?: (event: ModelAuthEvent) => void;
  } = {},
): Promise<DefaultModelInfo | null> {
  let loginId: string | null = null;
  const buffered: ModelAuthEvent[] = [];
  let resolveCompletion!: (value: DefaultModelInfo | null) => void;
  let rejectCompletion!: (reason: Error) => void;
  const completion = new Promise<DefaultModelInfo | null>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const handle = (event: ModelAuthEvent) => {
    callbacks.onEvent?.(event);
    if (event.phase === "complete") {
      resolveCompletion(event.defaultModel ?? null);
    } else if (event.phase === "error" || event.phase === "cancelled") {
      rejectCompletion(new Error(event.message || "账号授权失败。"));
    }
  };

  const unsubscribe = subscribePiEvents((event) => {
    if (event.type !== "model_auth" || event.providerId !== providerId) return;
    if (loginId === null) {
      buffered.push(event);
      return;
    }
    if (event.loginId === loginId) handle(event);
  });

  try {
    const started = await sendRpc<{ loginId: string }>({
      type: "models_login_oauth",
      providerId,
      modelId,
    });
    loginId = started.loginId;
    callbacks.onStarted?.(loginId);
    for (const event of buffered) {
      if (event.loginId === loginId) handle(event);
    }
    const defaultModel = await completion;
    window.dispatchEvent(new CustomEvent("nova-model-settings-changed", {
      detail: defaultModel,
    }));
    return defaultModel;
  } finally {
    unsubscribe();
  }
}

export async function cancelOAuthLogin(loginId: string): Promise<void> {
  await sendRpc({ type: "models_cancel_oauth", loginId });
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
