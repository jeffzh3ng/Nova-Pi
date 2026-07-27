import { invoke } from "@tauri-apps/api/core";

export type ProviderId = "openai-compatible" | "deepseek" | "qwen" | "local";

export type ModelSettings = {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  proxyUrl: string;
};

export type ModelSettingsStatus = {
  settings: ModelSettings;
};

export const providerDefaults: Record<ProviderId, Pick<ModelSettings, "baseUrl" | "model">> = {
  "openai-compatible": {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  local: {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
  },
};

export const defaultSettings: ModelSettings = {
  provider: "deepseek",
  apiKey: "",
  ...providerDefaults.deepseek,
  temperature: 0.2,
  maxTokens: 12288,
  proxyUrl: "",
};

export async function getModelSettings(): Promise<ModelSettingsStatus> {
  try {
    return await invoke<ModelSettingsStatus>("get_model_settings");
  } catch {
    return {
      settings: defaultSettings,
    };
  }
}

export async function saveModelSettings(settings: ModelSettings): Promise<ModelSettingsStatus> {
  return await invoke<ModelSettingsStatus>("save_model_settings", { settings });
}

export async function resetModelSettings(): Promise<ModelSettingsStatus> {
  return await invoke<ModelSettingsStatus>("reset_model_settings");
}

export async function testModelConnection(): Promise<string> {
  return await invoke<string>("test_model_connection");
}
