use std::time::Duration;

use chrono::Local;
use reqwest::StatusCode;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

use crate::app_database;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettings {
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub proxy_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettingsStatus {
    pub settings: ModelSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatRequest {
    pub prompt: String,
    pub human_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct AgentChatResult {
    pub model: String,
    pub used_model: bool,
    pub title: String,
    pub summary: String,
    pub steps: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
    usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageSummary {
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_tokens: u64,
    pub call_count: u64,
    pub records: Vec<TokenUsageRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageRecord {
    pub id: i64,
    pub model: String,
    pub agent_name: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    pub created_at: String,
}

pub fn default_model_settings() -> ModelSettings {
    ModelSettings {
        provider: "deepseek".to_string(),
        api_key: String::new(),
        base_url: "https://api.deepseek.com".to_string(),
        model: "deepseek-v4-pro".to_string(),
        temperature: 0.2,
        max_tokens: 12_288,
        proxy_url: String::new(),
    }
}

#[tauri::command]
pub fn get_model_settings(app: AppHandle) -> Result<ModelSettingsStatus, String> {
    app_database::with_database(&app, initialize_model_db, |connection, _| {
        let settings = load_model_settings_from_db(connection)?;
        Ok(ModelSettingsStatus { settings })
    })
}

#[tauri::command]
pub fn save_model_settings(
    app: AppHandle,
    settings: ModelSettings,
) -> Result<ModelSettingsStatus, String> {
    app_database::with_database(&app, initialize_model_db, |connection, _| {
        save_model_settings_to_db(connection, &normalize_model_settings(settings))?;
        let saved = load_model_settings_from_db(connection)?;
        Ok(ModelSettingsStatus { settings: saved })
    })
}

#[tauri::command]
pub fn reset_model_settings(app: AppHandle) -> Result<ModelSettingsStatus, String> {
    save_model_settings(app, default_model_settings())
}

/// 统一的大模型调用入口。所有数字员工通过此接口调用大模型，
/// 不自行配置模型参数，统一从全局设置加载。
pub async fn call_llm(
    app: &AppHandle,
    messages: Vec<LlmMessage>,
    json_response: bool,
    agent_name: &str,
) -> Result<(String, Usage), String> {
    let settings = load_default_model_settings(app)?;
    ensure_model_is_callable(&settings)?;
    let (content, usage) = chat_completion(&settings, messages, json_response).await?;
    save_token_usage(app, &settings.model, agent_name, &usage);
    Ok((content, usage))
}

#[tauri::command]
pub async fn test_model_connection(app: AppHandle) -> Result<String, String> {
    // 先检查配置是否存在
    let settings = load_default_model_settings(&app).map_err(|e| format!("配置加载失败：{e}"))?;
    ensure_model_is_callable(&settings)?;

    let (content, _) = call_llm(
        &app,
        vec![
            LlmMessage {
                role: "system".to_string(),
                content: "你是连接测试助手，只回复 JSON。".to_string(),
            },
            LlmMessage {
                role: "user".to_string(),
                content: r#"请回复 {"ok":true,"message":"connected"}"#.to_string(),
            },
        ],
        true,
        "连接测试",
    )
    .await
    .map_err(|e| {
        format!(
            "模型调用失败：{e} | provider={} base_url={}",
            settings.provider, settings.base_url
        )
    })?;
    Ok(format!("连接成功：返回 {}", clip_text(&content, 80)))
}

#[tauri::command]
#[allow(dead_code)]
pub async fn run_agent_chat(
    app: AppHandle,
    request: AgentChatRequest,
) -> Result<AgentChatResult, String> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err("对话内容不能为空。".to_string());
    }
    let human_name = request
        .human_name
        .as_deref()
        .unwrap_or("数字员工")
        .to_string();
    let (content, _) = call_llm(
        &app,
        vec![
            LlmMessage {
                role: "system".to_string(),
                content: format!("你是迪普科技驻场服务 AI 工作台中的「{human_name}」。请用简体中文直接回答用户任务，输出简洁、可执行的结果。"),
            },
            LlmMessage { role: "user".to_string(), content: prompt.to_string() },
        ],
        false,
        &human_name,
    )
    .await?;
    let model = load_default_model_settings(&app)
        .map(|s| s.model)
        .unwrap_or_default();
    Ok(AgentChatResult {
        model,
        used_model: true,
        title: format!("{human_name} 已完成回复"),
        summary: content,
        steps: vec![
            "读取统一大模型配置".to_string(),
            "提交上下文到统一大模型 API".to_string(),
            "生成回复".to_string(),
        ],
        created_at: now_text(),
    })
}

pub fn load_default_model_settings(app: &AppHandle) -> Result<ModelSettings, String> {
    app_database::with_database(app, initialize_model_db, |connection, _| {
        load_model_settings_from_db(connection)
    })
}

pub async fn chat_completion(
    settings: &ModelSettings,
    messages: Vec<LlmMessage>,
    json_response: bool,
) -> Result<(String, Usage), String> {
    ensure_model_is_callable(settings)?;

    let endpoint = chat_completion_endpoint(&settings.base_url);
    let mut client_builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy(); // 禁用系统代理自动检测，仅使用显式配置的代理
    if !settings.proxy_url.trim().is_empty() {
        let proxy = reqwest::Proxy::all(settings.proxy_url.trim())
            .map_err(|error| format!("代理配置无效：{error}"))?;
        client_builder = client_builder.proxy(proxy);
    }

    let client = client_builder
        .build()
        .map_err(|error| format!("HTTP 客户端初始化失败：{error}"))?;
    let mut payload = json!({
        "model": settings.model,
        "messages": messages,
        "temperature": settings.temperature.clamp(0.0, 1.0),
        "max_tokens": settings.max_tokens.clamp(512, 64_000)
    });

    if json_response {
        payload["response_format"] = json!({ "type": "json_object" });
    }
    // Disable reasoning for DeepSeek models to avoid oversized response bodies
    if settings.provider == "deepseek" {
        payload["thinking"] = json!({ "type": "disabled" });
    }

    let mut request = client.post(endpoint).json(&payload);
    if !settings.api_key.trim().is_empty() {
        request = request.bearer_auth(settings.api_key.trim());
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("模型请求失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_else(|_| String::new());
        return Err(format_model_error(status, &body));
    }

    let body_bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取模型响应失败：{error}"))?;
    let body_text = String::from_utf8_lossy(&body_bytes);
    let completion: ChatCompletionResponse = serde_json::from_str(&body_text).map_err(|error| {
        format!(
            "模型响应解析失败：{error} | body={}",
            clip_text(&body_text, 200)
        )
    })?;
    let usage = completion.usage.unwrap_or(Usage {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
    });
    let content = completion
        .choices
        .into_iter()
        .next()
        .and_then(|choice| choice.message.content)
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| "模型响应中没有可用内容。".to_string())?;
    Ok((content, usage))
}

fn init_token_usage_db(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS token_usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                model TEXT NOT NULL,
                agent_name TEXT NOT NULL DEFAULT '',
                prompt_tokens INTEGER NOT NULL,
                completion_tokens INTEGER NOT NULL,
                total_tokens INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            "#,
        )
        .map_err(|error| format!("初始化 Token 用量表失败：{error}"))?;
    if !table_has_column(connection, "token_usage", "agent_name")? {
        connection
            .execute_batch(
                "ALTER TABLE token_usage ADD COLUMN agent_name TEXT NOT NULL DEFAULT '';",
            )
            .map_err(|error| format!("迁移 Token 用量表失败：{error}"))?;
    }
    Ok(())
}

pub fn save_token_usage(app: &AppHandle, model: &str, agent_name: &str, usage: &Usage) {
    let result: Result<(), String> = app_database::with_database(
        app,
        initialize_model_db,
        |connection, _| {
            init_token_usage_db(connection)?;
            connection
            .execute(
                "INSERT INTO token_usage (model, agent_name, prompt_tokens, completion_tokens, total_tokens, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    model,
                    agent_name,
                    usage.prompt_tokens,
                    usage.completion_tokens,
                    usage.total_tokens,
                    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                ],
            )
            .map(|_| ())
            .map_err(|error| format!("保存 Token 用量失败：{error}"))
        },
    );
    if let Err(error) = result {
        eprintln!("{error}");
    }
}

#[tauri::command]
pub fn list_token_usage(app: AppHandle) -> Result<TokenUsageSummary, String> {
    app_database::with_database(&app, initialize_model_db, |connection, _| {
        init_token_usage_db(connection)?;

        let mut statement = connection
            .prepare("SELECT COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), COALESCE(SUM(total_tokens),0), COUNT(*) FROM token_usage")
            .map_err(|e| e.to_string())?;
        let (total_prompt, total_completion, total_tokens, call_count) = statement
            .query_row([], |row| {
                Ok((
                    row.get::<_, i64>(0)? as u64,
                    row.get::<_, i64>(1)? as u64,
                    row.get::<_, i64>(2)? as u64,
                    row.get::<_, i64>(3)? as u64,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut records_stmt = connection
            .prepare("SELECT id, model, agent_name, prompt_tokens, completion_tokens, total_tokens, created_at FROM token_usage ORDER BY id DESC LIMIT 80")
            .map_err(|e| e.to_string())?;
        let records = records_stmt
            .query_map([], |row| {
                Ok(TokenUsageRecord {
                    id: row.get(0)?,
                    model: row.get(1)?,
                    agent_name: row.get(2)?,
                    prompt_tokens: row.get::<_, i64>(3)? as u32,
                    completion_tokens: row.get::<_, i64>(4)? as u32,
                    total_tokens: row.get::<_, i64>(5)? as u32,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        Ok(TokenUsageSummary {
            total_prompt_tokens: total_prompt,
            total_completion_tokens: total_completion,
            total_tokens,
            call_count,
            records,
        })
    })
}

pub fn ensure_model_is_callable(settings: &ModelSettings) -> Result<(), String> {
    if settings.base_url.trim().is_empty() {
        return Err("大模型 Base URL 未配置，请先在设置中保存。".to_string());
    }
    validate_http_url_scheme(&settings.base_url)?;
    if settings.model.trim().is_empty() {
        return Err("大模型名称未配置，请先在设置中保存。".to_string());
    }
    if settings.provider != "local" && settings.api_key.trim().is_empty() {
        return Err("大模型 API Key 未配置，请先在设置中保存。".to_string());
    }
    Ok(())
}

/// Reject URLs that are not `http://`/`https://` (prevents `file:`/`data:`/gopher
/// schemes and avoids sending the API key to a non-HTTP endpoint).
fn validate_http_url_scheme(url: &str) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        Ok(())
    } else {
        Err("大模型 Base URL 必须以 http:// 或 https:// 开头。".to_string())
    }
}

fn initialize_model_db(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS model_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                provider TEXT NOT NULL,
                api_key TEXT NOT NULL,
                base_url TEXT NOT NULL,
                model TEXT NOT NULL,
                temperature REAL NOT NULL,
                max_tokens INTEGER NOT NULL,
                proxy_url TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            "#,
        )
        .map_err(|error| format!("初始化模型配置表失败：{error}"))?;

    migrate_legacy_model_settings(connection)?;

    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM model_settings WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("读取模型配置表失败：{error}"))?;
    if count == 0 {
        save_model_settings_to_db(connection, &default_model_settings())?;
    }
    Ok(())
}

fn migrate_legacy_model_settings(connection: &Connection) -> Result<(), String> {
    if !table_has_column(connection, "model_settings", "context_window")? {
        return Ok(());
    }

    let result = connection.execute_batch(
        r#"
        BEGIN IMMEDIATE;
        CREATE TABLE model_settings_new (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            provider TEXT NOT NULL,
            api_key TEXT NOT NULL,
            base_url TEXT NOT NULL,
            model TEXT NOT NULL,
            temperature REAL NOT NULL,
            max_tokens INTEGER NOT NULL,
            proxy_url TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO model_settings_new (
            id, provider, api_key, base_url, model, temperature, max_tokens, proxy_url, updated_at
        )
        SELECT id, provider, api_key, base_url, model, temperature, max_tokens, proxy_url, updated_at
          FROM model_settings;
        DROP TABLE model_settings;
        ALTER TABLE model_settings_new RENAME TO model_settings;
        COMMIT;
        "#,
    );

    if let Err(error) = result {
        let _ = connection.execute_batch("ROLLBACK;");
        return Err(format!("迁移模型配置表失败：{error}"));
    }
    Ok(())
}

fn table_has_column(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|error| format!("读取 {table_name} 表结构失败：{error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("读取 {table_name} 字段失败：{error}"))?;
    for column in columns {
        if column.map_err(|error| format!("读取 {table_name} 字段失败：{error}"))? == column_name
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn load_model_settings_from_db(connection: &Connection) -> Result<ModelSettings, String> {
    connection
        .query_row(
            r#"
            SELECT provider, api_key, base_url, model, temperature, max_tokens, proxy_url
              FROM model_settings
             WHERE id = 1
            "#,
            [],
            |row| {
                Ok(ModelSettings {
                    provider: row.get(0)?,
                    api_key: row.get(1)?,
                    base_url: row.get(2)?,
                    model: row.get(3)?,
                    temperature: row.get::<_, f64>(4)? as f32,
                    max_tokens: row.get::<_, i64>(5)? as u32,
                    proxy_url: row.get(6)?,
                })
            },
        )
        .map(normalize_model_settings)
        .map_err(|error| format!("读取模型配置失败：{error}"))
}

fn save_model_settings_to_db(
    connection: &Connection,
    settings: &ModelSettings,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            INSERT INTO model_settings (
                id, provider, api_key, base_url, model, temperature, max_tokens, proxy_url, updated_at
            )
            VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                api_key = excluded.api_key,
                base_url = excluded.base_url,
                model = excluded.model,
                temperature = excluded.temperature,
                max_tokens = excluded.max_tokens,
                proxy_url = excluded.proxy_url,
                updated_at = excluded.updated_at
            "#,
            params![
                settings.provider,
                settings.api_key,
                settings.base_url,
                settings.model,
                settings.temperature,
                settings.max_tokens as i64,
                settings.proxy_url,
                now_text(),
            ],
        )
        .map(|_| ())
        .map_err(|error| format!("保存模型配置失败：{error}"))
}

fn normalize_model_settings(mut settings: ModelSettings) -> ModelSettings {
    settings.provider = settings.provider.trim().to_string();
    if settings.provider.is_empty() {
        settings.provider = "deepseek".to_string();
    }
    settings.base_url = settings.base_url.trim().trim_end_matches('/').to_string();
    settings.model = settings.model.trim().to_string();
    settings.api_key = settings.api_key.trim().to_string();
    settings.proxy_url = settings.proxy_url.trim().to_string();
    settings.temperature = settings.temperature.clamp(0.0, 1.0);
    settings.max_tokens = settings.max_tokens.clamp(512, 64_000);

    if settings.base_url.is_empty() || settings.model.is_empty() {
        let defaults = defaults_for_provider(&settings.provider);
        if settings.base_url.is_empty() {
            settings.base_url = defaults.base_url;
        }
        if settings.model.is_empty() {
            settings.model = defaults.model;
        }
    }

    settings
}

fn defaults_for_provider(provider: &str) -> ModelSettings {
    let mut settings = default_model_settings();
    match provider {
        "openai-compatible" => {
            settings.provider = "openai-compatible".to_string();
            settings.base_url = "https://api.openai.com/v1".to_string();
            settings.model = "gpt-4.1-mini".to_string();
        }
        "qwen" => {
            settings.provider = "qwen".to_string();
            settings.base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string();
            settings.model = "qwen-plus".to_string();
        }
        "local" => {
            settings.provider = "local".to_string();
            settings.base_url = "http://127.0.0.1:11434/v1".to_string();
            settings.model = "qwen2.5:7b".to_string();
        }
        _ => {}
    }
    settings
}

fn chat_completion_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

fn format_model_error(status: StatusCode, body: &str) -> String {
    format!("模型接口返回 {status}：{}", clip_text(body, 500))
}

fn clip_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() > max_chars {
        format!("{}...", value.chars().take(max_chars).collect::<String>())
    } else {
        value.to_string()
    }
}

fn now_text() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn sqlite_settings_roundtrip() {
        let db_path = std::env::temp_dir().join(format!(
            "nova-model-settings-{}.sqlite3",
            Local::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let connection =
            app_database::open_database_at(&db_path, initialize_model_db).expect("db should open");
        let mut settings = default_model_settings();
        settings.api_key = "sk-test".to_string();
        settings.model = "deepseek-v4-pro-test".to_string();
        settings.max_tokens = 4096;

        save_model_settings_to_db(&connection, &settings).expect("settings should save");
        let loaded = load_model_settings_from_db(&connection).expect("settings should load");

        assert_eq!(loaded.api_key, "sk-test");
        assert_eq!(loaded.model, "deepseek-v4-pro-test");
        assert_eq!(loaded.max_tokens, 4096);

        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn callable_validation_requires_key_for_remote_provider() {
        let mut settings = default_model_settings();
        settings.api_key.clear();

        assert!(ensure_model_is_callable(&settings).is_err());

        settings.provider = "local".to_string();
        assert!(ensure_model_is_callable(&settings).is_ok());
    }

    #[test]
    fn legacy_settings_schema_is_migrated_without_losing_active_values() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE model_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    provider TEXT NOT NULL,
                    api_key TEXT NOT NULL,
                    base_url TEXT NOT NULL,
                    model TEXT NOT NULL,
                    temperature REAL NOT NULL,
                    max_tokens INTEGER NOT NULL,
                    context_window INTEGER NOT NULL,
                    stream_output INTEGER NOT NULL,
                    confirm_tool_use INTEGER NOT NULL,
                    save_history INTEGER NOT NULL,
                    auto_title INTEGER NOT NULL,
                    proxy_url TEXT NOT NULL,
                    language TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                INSERT INTO model_settings VALUES (
                    1, 'local', 'legacy-key', 'http://127.0.0.1:11434/v1',
                    'legacy-model', 0.4, 4096, 64000, 1, 1, 1, 1, '', 'zh-CN', '2026-01-01'
                );
                "#,
            )
            .expect("legacy settings should be created");

        initialize_model_db(&connection).expect("legacy schema should migrate");
        let loaded = load_model_settings_from_db(&connection).expect("settings should load");

        assert_eq!(loaded.provider, "local");
        assert_eq!(loaded.api_key, "legacy-key");
        assert_eq!(loaded.model, "legacy-model");
        assert!(
            !table_has_column(&connection, "model_settings", "context_window")
                .expect("schema should be readable")
        );
    }
}
