import { invoke } from "@tauri-apps/api/core";

/** 智谱 GLM-OCR 文档解析配置（仅 API Key）。未配置时内置 OCR 自动降级到 vision。 */
export type OcrSettings = {
  apiKey: string | null;
};

export type OcrSettingsStatus = {
  settings: OcrSettings;
};

export async function getOcrSettings(): Promise<OcrSettingsStatus> {
  try {
    return await invoke<OcrSettingsStatus>("get_ocr_settings");
  } catch {
    return { settings: { apiKey: null } };
  }
}

/** 保存 API Key；保存成功后 Rust 会自动把 key 同步给 sidecar（即时生效）。 */
export async function saveOcrSettings(apiKey: string | null): Promise<OcrSettingsStatus> {
  const trimmed = apiKey?.trim();
  const settings: OcrSettings = { apiKey: trimmed && trimmed.length > 0 ? trimmed : null };
  return await invoke<OcrSettingsStatus>("save_ocr_settings", { settings });
}

/** 连通性测试：用最小图片请求验证 API Key 有效（发真实网络请求）。 */
export async function testOcrConnection(): Promise<string> {
  return await invoke<string>("test_ocr_connection");
}
