//! 智谱 GLM-OCR 文档解析配置：仅存 API Key（单例表）。
//!
//! 复用 `llm_settings.rs` 的单例表 + `app_database::with_database` 模式。
//! Key 明文存储（与 `model_settings.api_key` 一致）；保存后通过 RPC 推给 sidecar。

use base64::Engine as _;
use chrono::Local;
use reqwest::StatusCode;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

use crate::app_database;

/// 智谱 GLM-OCR 文档解析服务的固定端点。
const GLM_OCR_ENDPOINT: &str = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";
const GLM_OCR_MODEL: &str = "glm-ocr";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrSettings {
    /// 明文 API Key；未配置时为 None，内置 OCR 自动降级到 vision。
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrSettingsStatus {
    pub settings: OcrSettings,
}

#[tauri::command]
pub fn get_ocr_settings(app: AppHandle) -> Result<OcrSettingsStatus, String> {
    app_database::with_database(&app, initialize_ocr_db, |connection, _| {
        let settings = load_ocr_settings_from_db(connection)?;
        Ok(OcrSettingsStatus { settings })
    })
}

#[tauri::command]
pub async fn save_ocr_settings(
    app: AppHandle,
    settings: OcrSettings,
) -> Result<OcrSettingsStatus, String> {
    let normalized = normalize_ocr_settings(settings);
    app_database::with_database(&app, initialize_ocr_db, |connection, _| {
        save_ocr_settings_to_db(connection, &normalized)?;
        let saved = load_ocr_settings_from_db(connection)?;
        Ok(OcrSettingsStatus { settings: saved })
    })?;
    // 保存成功后立即把 key 推给 sidecar，避免下次会话才生效。
    let _ = crate::sync_ocr_settings_to_sidecar(&app).await;
    Ok(OcrSettingsStatus { settings: normalized })
}

/// 连通性测试：用最小请求（1×1 透明 PNG）调用智谱 OCR，确认 key 有效。
///
/// 注意：这里发真实网络请求；离线或无 key 时返回明确错误信息给前端。
#[tauri::command]
pub async fn test_ocr_connection(app: AppHandle) -> Result<String, String> {
    let settings = get_ocr_settings(app.clone())
        .map_err(|e| format!("读取配置失败：{e}"))?
        .settings;
    let api_key = settings
        .api_key
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "尚未填写智谱 OCR API Key。".to_string())?;

    // 1×1 透明 PNG（67 字节）的最小 base64 编码。
    let png = base64::engine::general_purpose::STANDARD.encode(&[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ]);
    let body = json!({
        "model": GLM_OCR_MODEL,
        "file": format!("data:image/png;base64,{png}"),
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))?;
    let response = client
        .post(GLM_OCR_ENDPOINT)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求智谱 OCR 失败：{e}"))?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("API Key 无效或已过期（401）。".to_string());
    }
    if response.status() == StatusCode::FORBIDDEN {
        return Err("API Key 无 GLM-OCR 访问权限（403）。".to_string());
    }
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let clipped = clip_text(&text, 200);
        return Err(format!("智谱 OCR 返回 HTTP {status}：{clipped}"));
    }
    // 能解析到响应体即认为 key 有效（1×1 图返回空文本属正常）。
    let _parsed: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败：{e}"))?;
    Ok("连接成功，智谱 OCR API Key 有效。".to_string())
}

fn initialize_ocr_db(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS ocr_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                api_key TEXT,
                updated_at TEXT NOT NULL
            );
            "#,
        )
        .map_err(|error| format!("初始化 OCR 配置表失败：{error}"))?;
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM ocr_settings WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取 OCR 配置表失败：{error}"))?;
    if count == 0 {
        save_ocr_settings_to_db(connection, &OcrSettings::default())?;
    }
    Ok(())
}

fn normalize_ocr_settings(settings: OcrSettings) -> OcrSettings {
    let api_key = settings
        .api_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    OcrSettings { api_key }
}

fn load_ocr_settings_from_db(connection: &Connection) -> Result<OcrSettings, String> {
    connection
        .query_row(
            "SELECT api_key FROM ocr_settings WHERE id = 1",
            [],
            |row| {
                let raw: Option<String> = row.get(0)?;
                Ok(OcrSettings { api_key: raw })
            },
        )
        .map_err(|error| format!("读取 OCR 配置失败：{error}"))
}

fn save_ocr_settings_to_db(connection: &Connection, settings: &OcrSettings) -> Result<(), String> {
    let now = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    connection
        .execute(
            r#"
            INSERT INTO ocr_settings (id, api_key, updated_at)
            VALUES (1, ?1, ?2)
            ON CONFLICT(id) DO UPDATE SET
                api_key = excluded.api_key,
                updated_at = excluded.updated_at
            "#,
            params![settings.api_key, now],
        )
        .map_err(|error| format!("保存 OCR 配置失败：{error}"))?;
    Ok(())
}

fn clip_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let clipped: String = text.chars().take(max_chars).collect();
    format!("{clipped}…")
}
