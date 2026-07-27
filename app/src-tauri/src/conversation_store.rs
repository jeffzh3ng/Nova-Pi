use chrono::Local;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::app_database;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    id: String,
    title: String,
    title_source: String,
    agent_id: String,
    agent_name: String,
    status: String,
    last_message: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleResult {
    title: String,
    updated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessageRecord {
    id: String,
    role: String,
    title: Option<String>,
    content: String,
    time: String,
    steps: Option<Vec<String>>,
    suggestions: Option<Vec<String>>,
    detail: Option<String>,
    attachments: Option<Value>,
    alert_analysis_result: Option<Value>,
    risk_assessment_result: Option<Value>,
    risk_assessment_job: Option<Value>,
    used_skill: Option<Value>,
    pending_skill_execution: Option<Value>,
    exported_file: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSnapshot {
    id: String,
    title: String,
    agent_id: String,
    agent_name: String,
    status: String,
    messages: Vec<ConversationMessageRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedConversation {
    summary: ConversationSummary,
    messages: Vec<ConversationMessageRecord>,
}

#[tauri::command]
pub fn list_conversations(app: AppHandle) -> Result<Vec<ConversationSummary>, String> {
    app_database::with_database(&app, initialize_conversation_db, |connection, _| {
        let mut statement = connection
            .prepare(
                r#"
                SELECT c.id,
                       c.title,
                       c.title_source,
                       c.agent_id,
                       c.agent_name,
                       c.status,
                       COALESCE((
                           SELECT m.content
                             FROM conversation_messages m
                            WHERE m.conversation_id = c.id
                              AND TRIM(m.content) <> ''
                            ORDER BY m.sort_order DESC
                            LIMIT 1
                       ), '') AS last_message,
                       c.created_at,
                       c.updated_at
                  FROM conversations c
                 WHERE c.archived = 0
                 ORDER BY c.updated_at DESC
                 LIMIT 80
                "#,
            )
            .map_err(|error| format!("读取会话列表失败：{error}"))?;

        let rows = statement
            .query_map([], conversation_summary_from_row)
            .map_err(|error| format!("读取会话列表失败：{error}"))?;

        let mut summaries = Vec::new();
        for row in rows {
            summaries.push(row.map_err(|error| format!("解析会话列表失败：{error}"))?);
        }
        Ok(summaries)
    })
}

#[tauri::command]
pub fn load_conversation(
    app: AppHandle,
    conversation_id: String,
) -> Result<LoadedConversation, String> {
    app_database::with_database(&app, initialize_conversation_db, |connection, _| {
        let summary = match connection.query_row(
            r#"
            SELECT c.id, c.title, c.title_source, c.agent_id, c.agent_name, c.status,
                   COALESCE((
                       SELECT m.content
                         FROM conversation_messages m
                        WHERE m.conversation_id = c.id
                          AND TRIM(m.content) <> ''
                        ORDER BY m.sort_order DESC
                        LIMIT 1
                   ), '') AS last_message,
                   c.created_at, c.updated_at
              FROM conversations c
             WHERE c.id = ?1
            "#,
            params![conversation_id],
            conversation_summary_from_row,
        ) {
            Ok(summary) => summary,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                return Err(format!("会话不存在：{conversation_id}"));
            }
            Err(error) => return Err(format!("读取会话失败：{error}")),
        };

        let messages = load_messages(connection, &summary.id)?;
        Ok(LoadedConversation { summary, messages })
    })
}

#[tauri::command]
pub fn save_conversation_snapshot(
    app: AppHandle,
    snapshot: ConversationSnapshot,
) -> Result<ConversationSummary, String> {
    app_database::with_database_mut(&app, initialize_conversation_db, |connection, _| {
        let now = now_text();
        let transaction = connection
            .transaction()
            .map_err(|error| format!("保存会话失败：{error}"))?;
        transaction
            .execute(
                r#"
                INSERT INTO conversations (
                    id, title, title_source, agent_id, agent_name, status, created_at, updated_at, archived
                )
                VALUES (?1, ?2, 'pending', ?3, ?4, ?5, ?6, ?6, 0)
                ON CONFLICT(id) DO UPDATE SET
                    agent_id = excluded.agent_id,
                    agent_name = excluded.agent_name,
                    status = excluded.status,
                    updated_at = excluded.updated_at
                "#,
                params![
                    snapshot.id,
                    snapshot.title,
                    snapshot.agent_id,
                    snapshot.agent_name,
                    snapshot.status,
                    now,
                ],
            )
            .map_err(|error| format!("保存会话失败：{error}"))?;

        transaction
            .execute(
                "DELETE FROM conversation_messages WHERE conversation_id = ?1",
                params![snapshot.id],
            )
            .map_err(|error| format!("更新会话消息失败：{error}"))?;

        for (index, message) in snapshot.messages.iter().enumerate() {
            let steps_json = serde_json::to_string(&message.steps.clone().unwrap_or_default())
                .map_err(|error| format!("序列化消息步骤失败：{error}"))?;
            let suggestions_json =
                serde_json::to_string(&message.suggestions.clone().unwrap_or_default())
                    .map_err(|error| format!("序列化消息选项失败：{error}"))?;
            let exported_file_json = message
                .exported_file
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| format!("序列化导出文件信息失败：{error}"))?;

            let attachments_json = message
                .attachments
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| format!("序列化消息附件失败：{error}"))?;

            let alert_analysis_result_json = message
                .alert_analysis_result
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| format!("序列化告警研判结果失败：{error}"))?;

            let risk_assessment_result_json = message
                .risk_assessment_result
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| format!("序列化数据安全风险评估结果失败：{error}"))?;

            let risk_assessment_job_json = message
                .risk_assessment_job
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| format!("序列化数据安全风险评估任务失败：{error}"))?;

            let used_skill_json = message
                .used_skill
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| format!("serialize used skill failed: {error}"))?;

            let pending_skill_execution_json = message
                .pending_skill_execution
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|error| format!("serialize pending skill execution failed: {error}"))?;

            transaction
                .execute(
                    r#"
                    INSERT INTO conversation_messages (
                        id, conversation_id, role, title, content, time, sort_order,
                        steps_json, suggestions_json, detail, attachments_json,
                        alert_analysis_result_json, risk_assessment_result_json,
                        risk_assessment_job_json, used_skill_json, pending_skill_execution_json,
                        exported_file_json
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                    "#,
                    params![
                        message.id,
                        snapshot.id,
                        message.role,
                        message.title,
                        message.content,
                        message.time,
                        index as i64,
                        steps_json,
                        suggestions_json,
                        message.detail,
                        attachments_json,
                        alert_analysis_result_json,
                        risk_assessment_result_json,
                        risk_assessment_job_json,
                        used_skill_json,
                        pending_skill_execution_json,
                        exported_file_json,
                    ],
                )
                .map_err(|error| format!("保存会话消息失败：{error}"))?;
        }

        transaction
            .commit()
            .map_err(|error| format!("提交会话保存失败：{error}"))?;

        connection
            .query_row(
                r#"
                SELECT c.id, c.title, c.title_source, c.agent_id, c.agent_name, c.status,
                       COALESCE((
                           SELECT m.content
                             FROM conversation_messages m
                            WHERE m.conversation_id = c.id
                              AND TRIM(m.content) <> ''
                            ORDER BY m.sort_order DESC
                            LIMIT 1
                       ), '') AS last_message,
                       c.created_at, c.updated_at
                  FROM conversations c
                 WHERE c.id = ?1
                "#,
                params![snapshot.id],
                conversation_summary_from_row,
            )
            .map_err(|error| format!("读取已保存会话失败：{error}"))
    })
}

#[tauri::command]
pub fn archive_conversation(app: AppHandle, conversation_id: String) -> Result<(), String> {
    app_database::with_database(&app, initialize_conversation_db, |connection, _| {
        connection
            .execute(
                "UPDATE conversations SET archived = 1, updated_at = ?2 WHERE id = ?1",
                params![conversation_id, now_text()],
            )
            .map(|_| ())
            .map_err(|error| format!("归档会话失败：{error}"))
    })
}

#[tauri::command]
pub fn list_archived_conversations(app: AppHandle) -> Result<Vec<ConversationSummary>, String> {
    app_database::with_database(&app, initialize_conversation_db, |connection, _| {
        let mut statement = connection
            .prepare(
                r#"
                SELECT c.id,
                       c.title,
                       c.title_source,
                       c.agent_id,
                       c.agent_name,
                       c.status,
                       COALESCE((
                           SELECT m.content
                             FROM conversation_messages m
                            WHERE m.conversation_id = c.id
                              AND TRIM(m.content) <> ''
                            ORDER BY m.sort_order DESC
                            LIMIT 1
                       ), '') AS last_message,
                       c.created_at,
                       c.updated_at
                  FROM conversations c
                 WHERE c.archived = 1
                 ORDER BY c.updated_at DESC
                 LIMIT 80
                "#,
            )
            .map_err(|error| format!("读取归档列表失败：{error}"))?;

        let rows = statement
            .query_map([], conversation_summary_from_row)
            .map_err(|error| format!("读取归档列表失败：{error}"))?;

        let mut summaries = Vec::new();
        for row in rows {
            summaries.push(row.map_err(|error| format!("解析归档列表失败：{error}"))?);
        }
        Ok(summaries)
    })
}

#[tauri::command]
pub fn restore_conversation(app: AppHandle, conversation_id: String) -> Result<(), String> {
    app_database::with_database(&app, initialize_conversation_db, |connection, _| {
        connection
            .execute(
                "UPDATE conversations SET archived = 0, updated_at = ?2 WHERE id = ?1",
                params![conversation_id, now_text()],
            )
            .map(|_| ())
            .map_err(|error| format!("恢复会话失败：{error}"))
    })
}

#[tauri::command]
pub fn delete_conversation(app: AppHandle, conversation_id: String) -> Result<(), String> {
    app_database::with_database(&app, initialize_conversation_db, |connection, _| {
        connection
            .execute(
                "DELETE FROM conversations WHERE id = ?1",
                params![conversation_id],
            )
            .map(|_| ())
            .map_err(|error| format!("删除会话失败：{error}"))
    })
}

#[tauri::command]
pub fn rename_conversation(
    app: AppHandle,
    conversation_id: String,
    title: String,
) -> Result<(), String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("会话名称不能为空。".to_string());
    }
    app_database::with_database(&app, initialize_conversation_db, |connection, _| {
        connection
            .execute(
                "UPDATE conversations SET title = ?1, title_source = 'manual', updated_at = ?2 WHERE id = ?3",
                params![trimmed, now_text(), conversation_id],
            )
            .map(|_| ())
            .map_err(|error| format!("重命名会话失败：{error}"))
    })
}

/// 大模型提炼任务名。仅在 `title_source = 'pending'` 的活动会话上执行；
/// 用户手动改过（`manual`）或已自动提炼过（`auto`）的会话直接跳过。
/// 用条件 UPDATE 防竞态：LLM 调用期间用户若手改，影响 0 行，返回 updated=false。
#[tauri::command]
pub async fn generate_conversation_title(
    app: AppHandle,
    conversation_id: String,
) -> Result<TitleResult, String> {
    // 先读会话标题来源与最近几条消息
    let (title_source, current_title, transcript) =
        app_database::with_database(&app, initialize_conversation_db, |connection, _| {
            let (title_source, current_title): (String, String) =
                match connection.query_row(
                    "SELECT title_source, title FROM conversations WHERE id = ?1",
                    params![conversation_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                ) {
                    Ok(value) => value,
                    Err(rusqlite::Error::QueryReturnedNoRows) => {
                        return Err(format!("会话不存在：{conversation_id}"));
                    }
                    Err(error) => return Err(format!("读取会话失败：{error}")),
                };
            let messages = load_messages(connection, &conversation_id)?;
            Ok((title_source, current_title, build_title_transcript(&messages)))
        })?;

    // 用户已手动改名或已自动提炼过：跳过，不动标题。
    if title_source != "pending" {
        return Ok(TitleResult {
            title: current_title,
            updated: false,
        });
    }

    let proposed = generate_title_with_llm(&app, &transcript, &current_title).await?;

    // 条件 UPDATE：仅在仍为 pending 且未归档时更新（防竞态）。
    let updated = app_database::with_database_mut(
        &app,
        initialize_conversation_db,
        |connection, _| {
            connection
                .execute(
                    "UPDATE conversations SET title = ?1, title_source = 'auto', updated_at = ?2 \
                     WHERE id = ?3 AND title_source = 'pending' AND archived = 0",
                    params![proposed, now_text(), conversation_id],
                )
                .map(|affected| affected > 0)
                .map_err(|error| format!("更新任务名失败：{error}"))
        },
    )?;

    Ok(TitleResult {
        title: if updated { proposed } else { current_title },
        updated,
    })
}

/// 拼接供大模型提炼标题的对话文本：取最近 6 条消息，每条内容截断到 300 字。
fn build_title_transcript(messages: &[ConversationMessageRecord]) -> String {
    let recent = messages.iter().rev().take(6).collect::<Vec<_>>();
    let mut lines = Vec::new();
    for message in recent.into_iter().rev() {
        if message.content.trim().is_empty() {
            continue;
        }
        let role = if message.role == "user" { "用户" } else { "助手" };
        let clipped = clip_chars(&message.content, 300);
        lines.push(format!("[{role}]: {clipped}"));
    }
    lines.join("\n")
}

/// 调用大模型提炼标题；失败或结果不可用则回退到首条用户消息截断。
///
/// 经 host sidecar 的 `generate_title` RPC 调用 pi（completeSimple），
/// 使用用户在设置面板实际配置的默认模型。Rust 的 model_settings 表在新架构下
/// 不再被前端写入（call_llm 路径废弃），直接走它会因空 API Key 失败、标题永远不变。
async fn generate_title_with_llm(
    app: &AppHandle,
    transcript: &str,
    fallback_title: &str,
) -> Result<String, String> {
    let trimmed_transcript = transcript.trim();
    if trimmed_transcript.is_empty() {
        return Ok(fallback_title.to_string());
    }

    let command = serde_json::json!({
        "type": "generate_title",
        "transcript": trimmed_transcript,
    });
    // host 侧单次 LLM 调用设 18s 超时，这里给 25s 余量（避免 Rust 先超时导致响应被丢弃）。
    let response = crate::rpc::send_rpc_blocking_with_timeout(
        app,
        command,
        std::time::Duration::from_secs(25),
    )
    .await?;

    let raw = response
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let cleaned = clean_title_output(raw);
    if cleaned.is_empty() {
        Ok(fallback_title.to_string())
    } else {
        Ok(cleaned)
    }
}

/// 清洗大模型返回的标题：去空白、首尾引号/书名号、常见前缀、尾标点，截断到 24 字符。
fn clean_title_output(raw: &str) -> String {
    let mut value = raw.trim();
    // 反复去引号/书名号成对包裹
    for _ in 0..3 {
        let stripped = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('“')
                    .and_then(|v| v.strip_suffix('”'))
            })
            .or_else(|| {
                value
                    .strip_prefix('「')
                    .and_then(|v| v.strip_suffix('」'))
            })
            .or_else(|| {
                value
                    .strip_prefix('《')
                    .and_then(|v| v.strip_suffix('》'))
            });
        value = stripped.unwrap_or(value).trim();
    }
    // 去常见前缀
    for prefix in ["任务名称：", "任务名：", "标题：", "名称：", "任务："] {
        if let Some(rest) = value.strip_prefix(prefix) {
            value = rest.trim();
            break;
        }
    }
    // 去尾部中英文标点
    value = value.trim_end_matches(|c: char| {
        matches!(c, '。' | '，' | ',' | '.' | '、' | '；' | ';' | '：' | ':' | '！' | '!' | '？' | '?')
    });
    clip_chars(value.trim(), 24)
}

/// 按 Unicode 字符（而非字节）截断，避免把多字节字符切断。
fn clip_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn conversation_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationSummary> {
    Ok(ConversationSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        title_source: row.get(2)?,
        agent_id: row.get(3)?,
        agent_name: row.get(4)?,
        status: row.get(5)?,
        last_message: normalize_last_message(&row.get::<_, String>(6)?),
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn normalize_last_message(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(260)
        .collect()
}

fn load_messages(
    connection: &Connection,
    conversation_id: &str,
) -> Result<Vec<ConversationMessageRecord>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, role, title, content, time, steps_json, suggestions_json, detail,
                   attachments_json, alert_analysis_result_json, risk_assessment_result_json,
                   risk_assessment_job_json, used_skill_json, pending_skill_execution_json,
                   exported_file_json
              FROM conversation_messages
             WHERE conversation_id = ?1
             ORDER BY sort_order ASC
            "#,
        )
        .map_err(|error| format!("读取会话消息失败：{error}"))?;
    let rows = statement
        .query_map(params![conversation_id], |row| {
            let steps_json: String = row.get(5)?;
            let suggestions_json: String = row.get(6)?;
            let detail: Option<String> = row.get(7)?;
            let attachments_json: Option<String> = row.get(8)?;
            let alert_analysis_result_json: Option<String> = row.get(9)?;
            let risk_assessment_result_json: Option<String> = row.get(10)?;
            let risk_assessment_job_json: Option<String> = row.get(11)?;
            let used_skill_json: Option<String> = row.get(12)?;
            let pending_skill_execution_json: Option<String> = row.get(13)?;
            let exported_file_json: Option<String> = row.get(14)?;
            Ok(ConversationMessageRecord {
                id: row.get(0)?,
                role: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                time: row.get(4)?,
                steps: serde_json::from_str::<Vec<String>>(&steps_json).ok(),
                suggestions: serde_json::from_str::<Vec<String>>(&suggestions_json).ok(),
                detail,
                attachments: attachments_json
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok()),
                alert_analysis_result: alert_analysis_result_json
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok()),
                risk_assessment_result: risk_assessment_result_json
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok()),
                risk_assessment_job: risk_assessment_job_json
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok()),
                used_skill: used_skill_json
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok()),
                pending_skill_execution: pending_skill_execution_json
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok()),
                exported_file: exported_file_json
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok()),
            })
        })
        .map_err(|error| format!("读取会话消息失败：{error}"))?;

    let mut messages = Vec::new();
    for row in rows {
        messages.push(row.map_err(|error| format!("解析会话消息失败：{error}"))?);
    }
    Ok(messages)
}

fn initialize_conversation_db(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                title_source TEXT NOT NULL DEFAULT 'pending',
                agent_id TEXT NOT NULL,
                agent_name TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS conversation_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                title TEXT,
                content TEXT NOT NULL,
                time TEXT NOT NULL,
                sort_order INTEGER NOT NULL,
                steps_json TEXT NOT NULL,
                suggestions_json TEXT NOT NULL,
                detail TEXT,
                attachments_json TEXT,
                alert_analysis_result_json TEXT,
                risk_assessment_result_json TEXT,
                risk_assessment_job_json TEXT,
                used_skill_json TEXT,
                pending_skill_execution_json TEXT,
                exported_file_json TEXT,
                FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
                ON conversations(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_conversation_messages_order
                ON conversation_messages(conversation_id, sort_order);
            "#,
        )
        .map_err(|error| format!("初始化会话表失败：{error}"))?;

    ensure_column(
        connection,
        "conversations",
        "archived",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        connection,
        "conversations",
        "title_source",
        "TEXT NOT NULL DEFAULT 'pending'",
    )?;
    ensure_column(connection, "conversation_messages", "detail", "TEXT")?;
    ensure_column(
        connection,
        "conversation_messages",
        "attachments_json",
        "TEXT",
    )?;
    ensure_column(
        connection,
        "conversation_messages",
        "alert_analysis_result_json",
        "TEXT",
    )?;
    ensure_column(
        connection,
        "conversation_messages",
        "risk_assessment_result_json",
        "TEXT",
    )?;
    ensure_column(
        connection,
        "conversation_messages",
        "risk_assessment_job_json",
        "TEXT",
    )?;
    ensure_column(
        connection,
        "conversation_messages",
        "used_skill_json",
        "TEXT",
    )?;
    ensure_column(
        connection,
        "conversation_messages",
        "pending_skill_execution_json",
        "TEXT",
    )?;
    ensure_column(
        connection,
        "conversation_messages",
        "exported_file_json",
        "TEXT",
    )?;
    migrate_legacy_conversation_schema(connection)?;

    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
    definition: &str,
) -> Result<(), String> {
    if table_has_column(connection, table_name, column_name)? {
        return Ok(());
    }
    connection
        .execute_batch(&format!(
            "ALTER TABLE {table_name} ADD COLUMN {column_name} {definition};"
        ))
        .map_err(|error| format!("添加 {table_name}.{column_name} 字段失败：{error}"))
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

fn migrate_legacy_conversation_schema(connection: &Connection) -> Result<(), String> {
    let legacy_conversations = table_has_column(connection, "conversations", "mode")?
        || table_has_column(connection, "conversations", "last_message")?
        || table_has_column(connection, "conversations", "classification_session_json")?;
    let legacy_messages = table_has_column(
        connection,
        "conversation_messages",
        "classification_result_json",
    )?;
    if !legacy_conversations && !legacy_messages {
        return Ok(());
    }

    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|error| format!("准备迁移会话表失败：{error}"))?;
    let migration = connection.execute_batch(
        r#"
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS conversations_new;
        DROP TABLE IF EXISTS conversation_messages_new;
        CREATE TABLE conversations_new (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            title_source TEXT NOT NULL DEFAULT 'pending',
            agent_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE conversation_messages_new (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            title TEXT,
            content TEXT NOT NULL,
            time TEXT NOT NULL,
            sort_order INTEGER NOT NULL,
            steps_json TEXT NOT NULL,
            suggestions_json TEXT NOT NULL,
            detail TEXT,
            attachments_json TEXT,
            alert_analysis_result_json TEXT,
            risk_assessment_result_json TEXT,
            risk_assessment_job_json TEXT,
            used_skill_json TEXT,
            pending_skill_execution_json TEXT,
            exported_file_json TEXT,
            FOREIGN KEY(conversation_id) REFERENCES conversations_new(id) ON DELETE CASCADE
        );
        INSERT INTO conversations_new (
            id, title, agent_id, agent_name, status, created_at, updated_at, archived
        )
        SELECT id, title, agent_id, agent_name, status, created_at, updated_at, archived
          FROM conversations;
        INSERT INTO conversation_messages_new (
            id, conversation_id, role, title, content, time, sort_order, steps_json,
            suggestions_json, detail, attachments_json, alert_analysis_result_json,
            risk_assessment_result_json, risk_assessment_job_json, used_skill_json,
            pending_skill_execution_json, exported_file_json
        )
        SELECT id, conversation_id, role, title, content, time, sort_order, steps_json,
               suggestions_json, detail, attachments_json, alert_analysis_result_json,
               risk_assessment_result_json, risk_assessment_job_json, used_skill_json,
               pending_skill_execution_json, exported_file_json
          FROM conversation_messages;
        DROP TABLE conversation_messages;
        DROP TABLE conversations;
        ALTER TABLE conversations_new RENAME TO conversations;
        ALTER TABLE conversation_messages_new RENAME TO conversation_messages;
        CREATE INDEX idx_conversations_updated_at
            ON conversations(updated_at DESC);
        CREATE INDEX idx_conversation_messages_order
            ON conversation_messages(conversation_id, sort_order);
        COMMIT;
        "#,
    );

    if let Err(error) = migration {
        let _ = connection.execute_batch("ROLLBACK; PRAGMA foreign_keys = ON;");
        return Err(format!("迁移会话表失败：{error}"));
    }
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("完成会话表迁移失败：{error}"))?;
    Ok(())
}

fn now_text() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_schema_migration_preserves_live_conversation_data() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    status TEXT NOT NULL,
                    last_message TEXT NOT NULL,
                    classification_session_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE conversation_messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    title TEXT,
                    content TEXT NOT NULL,
                    time TEXT NOT NULL,
                    sort_order INTEGER NOT NULL,
                    steps_json TEXT NOT NULL,
                    suggestions_json TEXT NOT NULL,
                    detail TEXT,
                    attachments_json TEXT,
                    classification_result_json TEXT,
                    alert_analysis_result_json TEXT,
                    used_skill_json TEXT,
                    pending_skill_execution_json TEXT,
                    exported_file_json TEXT,
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );
                INSERT INTO conversations VALUES (
                    'c1', 'title', 'agent', '数字员工', 'personal', 'completed',
                    'stale message', '{"step":"done"}', '2026-01-01', '2026-01-02', 1
                );
                INSERT INTO conversation_messages VALUES (
                    'm1', 'c1', 'assistant', NULL, 'latest message', '10:00', 0,
                    '[]', '[]', NULL, '[{"name":"a.txt"}]', '{"legacy":true}',
                    '{"summary":"kept"}', '{"id":"skill"}', NULL, '{"path":"result.xlsx"}'
                );
                "#,
            )
            .expect("legacy schema should be created");

        initialize_conversation_db(&connection).expect("legacy schema should migrate");

        assert!(!table_has_column(&connection, "conversations", "mode")
            .expect("conversation schema should be readable"));
        assert!(!table_has_column(
            &connection,
            "conversation_messages",
            "classification_result_json"
        )
        .expect("message schema should be readable"));
        let archived: i64 = connection
            .query_row(
                "SELECT archived FROM conversations WHERE id = 'c1'",
                [],
                |row| row.get(0),
            )
            .expect("conversation should remain");
        let alert_result: String = connection
            .query_row(
                "SELECT alert_analysis_result_json FROM conversation_messages WHERE id = 'm1'",
                [],
                |row| row.get(0),
            )
            .expect("message should remain");
        assert_eq!(archived, 1);
        assert_eq!(alert_result, r#"{"summary":"kept"}"#);
    }

    #[test]
    fn title_source_column_defaults_to_pending_on_existing_db() {
        // 模拟现有用户数据库：已有 archived 列但尚无 title_source 列。
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE conversations (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO conversations (id, title, agent_id, agent_name, status, created_at, updated_at)
                VALUES ('c1', '旧标题', 'agent', '数字员工', 'done', '2026-01-01', '2026-01-02');
                CREATE TABLE conversation_messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    title TEXT,
                    content TEXT NOT NULL,
                    time TEXT NOT NULL,
                    sort_order INTEGER NOT NULL,
                    steps_json TEXT NOT NULL,
                    suggestions_json TEXT NOT NULL,
                    detail TEXT,
                    attachments_json TEXT,
                    alert_analysis_result_json TEXT,
                    used_skill_json TEXT,
                    pending_skill_execution_json TEXT,
                    exported_file_json TEXT,
                    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );
                "#,
            )
            .expect("pre-migration schema should be created");

        initialize_conversation_db(&connection).expect("migration should add title_source");

        assert!(table_has_column(&connection, "conversations", "title_source")
            .expect("schema should be readable"));
        let source: String = connection
            .query_row(
                "SELECT title_source FROM conversations WHERE id = 'c1'",
                [],
                |row| row.get(0),
            )
            .expect("conversation should remain");
        assert_eq!(source, "pending");
    }

    #[test]
    fn clean_title_output_strips_quotes_and_prefixes() {
        assert_eq!(clean_title_output("「告警研判」"), "告警研判");
        assert_eq!(clean_title_output("任务名称：数据包分析"), "数据包分析");
        assert_eq!(clean_title_output("标题：异常流量排查。"), "异常流量排查");
        assert_eq!(clean_title_output("  \"PCAP解析\"  "), "PCAP解析");
        // 超长内容截断到 24 字符
        let long = "这是一个非常非常非常非常非常非常非常非常长的任务名称";
        let cleaned = clean_title_output(long);
        assert_eq!(cleaned.chars().count(), 24);
    }
}
