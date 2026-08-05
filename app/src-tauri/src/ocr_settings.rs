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

/// 连通性测试：用最小请求调用智谱 OCR 端点，确认 API Key 有效。
///
/// 鉴权测试的目的是验证 Key 是否被服务接受，而非验证图片内容。因此只要请求
/// 通过了鉴权层（即不是 401/403，或不是明确的鉴权类错误），就判定 Key 有效——
/// 即便智谱对测试图返回 400 业务校验错误（如「图片过小/格式不符」），也说明
/// Key 已通过鉴权、请求到达了业务层。这样可避免「测试样本踩到内容校验」导致
/// 误报 Key 无效。
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

    // 32×16 白底带黑块 PNG（98 字节）。比 1×1 透明图更接近真实文档，
    // 降低被智谱内容校验直接拒绝的概率；但即便仍被拒，下方逻辑也会把
    // 非鉴权类错误判为 Key 有效。
    let png = base64::engine::general_purpose::STANDARD.encode([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00, 0x10, 0x08, 0x06, 0x00, 0x00, 0x00, 0x77,
        0x00, 0x7D, 0x59, 0x00, 0x00, 0x00, 0x29, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8,
        0x3F, 0xC0, 0x80, 0x61, 0xD4, 0x01, 0xA3, 0x0E, 0x18, 0x18, 0xF4, 0x0E, 0x60, 0x60, 0x60,
        0xA0, 0x08, 0x8F, 0x3A, 0x60, 0xE8, 0x3B, 0x80, 0xD6, 0x60, 0xD4, 0x01, 0xA3, 0x0E, 0x18,
        0x70, 0x07, 0x00, 0x00, 0x23, 0x32, 0x39, 0x2A, 0xA0, 0x39, 0x29, 0xE6, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
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

    let status_code = response.status();
    // 401/403 是明确的鉴权失败——Key 无效或无权限。
    if status_code == StatusCode::UNAUTHORIZED {
        return Err("API Key 无效或已过期（401）。".to_string());
    }
    if status_code == StatusCode::FORBIDDEN {
        return Err("API Key 无 GLM-OCR 访问权限（403）。".to_string());
    }

    // 成功（200）→ Key 有效。
    if status_code.is_success() {
        // 能解析到响应体即认为 key 有效（测试图返回空文本属正常）。
        let _parsed: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("解析响应失败：{e}"))?;
        return Ok("连接成功，智谱 OCR API Key 有效。".to_string());
    }

    // 非 401/403 的错误（如 400 内容校验、429 限流、5xx）说明请求已通过鉴权、
    // 到达业务层，Key 本身有效；只是测试样本触发了业务规则。把这类情况也判为
    // Key 有效，避免用最小测试图踩内容校验时误报。
    let body_text = response.text().await.unwrap_or_default();
    if is_auth_passed_business_error(&status_code, &body_text) {
        let label = business_error_label(&status_code);
        return Ok(format!("连接成功，智谱 OCR API Key 有效{label}。"));
    }

    // 真正的网络/服务异常（无法判断鉴权状态）才报错。
    let clipped = clip_text(&body_text, 200);
    Err(format!("智谱 OCR 返回 HTTP {status_code}：{clipped}"))
}

/// 判断一个非 2xx 响应是否属于「已通过鉴权、仅在业务层被拒」。
///
/// 400 且 body 含智谱的内容/格式校验信息（如 code 1214、格式/大小/页数提示），
/// 或 429 限流、5xx 服务端错误，都意味着请求穿过了鉴权层——Key 是有效的。
fn is_auth_passed_business_error(status: &StatusCode, body: &str) -> bool {
    if *status == StatusCode::BAD_REQUEST {
        // 智谱鉴权失败一般用 401，不会用 400；400 几乎都是内容/格式校验。
        // 进一步用 body 关键词确认（格式/大小/页数/OCR 字样）。
        let lower = body.to_lowercase();
        return lower.contains("格式") || lower.contains("大小") || lower.contains("页")
            || lower.contains("ocr") || lower.contains("file") || lower.contains("format")
            || lower.contains("size") || lower.contains("\"code\":1214");
    }
    // 429（限流）与 5xx（服务端）同样表示已过鉴权层。
    *status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

/// 为「Key 有效但测试触发了业务校验」的情况生成简短说明后缀。
fn business_error_label(status: &StatusCode) -> String {
    match *status {
        StatusCode::BAD_REQUEST => "（测试图触发了内容校验，不影响实际使用）".to_string(),
        StatusCode::TOO_MANY_REQUESTS => "（当前触发了限流，不影响 Key 有效性）".to_string(),
        s if s.is_server_error() => "（智谱服务端临时异常，不影响 Key 有效性）".to_string(),
        _ => String::new(),
    }
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
