//! 消息通道（微信/飞书/...）配置：SQLite 表 + CRUD。
//!
//! 与 mcp_settings.rs 同风格：通过 app_database::with_database 拿连接，
//! initialize 函数里仅建表（不 seed 任何默认渠道——所有渠道都由用户在面板手动新建）。
//!
//! 每个渠道一行配置：是否启用、是否自动启动、用哪个数字员工处理消息、
//! 是否在面板显示消息记录、渠道特有配置（JSON）。
//!
//! 安全：`config_json` 内的敏感字段（Telegram botToken 等）在落库前由
//! secrets 模块做本地混淆（XOR + base64 + 机器绑定密钥），防止明文外泄。
//! 读取时自动解密；旧明文数据向后兼容。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::app_database;
use crate::secrets;

/// 支持的渠道类型白名单（save 时校验 channel_id，防止前端任意构造 id）。
/// 新增渠道（飞书等）在此登记。
const BUILTIN_CHANNEL_TYPES: &[&str] = &["wechat", "telegram", "feishu", "dingtalk"];

/// config_json 中需要混淆存储的字段路径（按渠道类型）。
/// Telegram Bot Token 与飞书 App Secret 都按现有本地密钥机制混淆保存。
fn sensitive_keys_for(channel_type: &str) -> &'static [&'static str] {
    match channel_type {
        "telegram" => &["botToken"],
        "feishu" => &["appSecret"],
        _ => &[],
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageChannel {
    pub channel_id: String,
    /// 渠道类型与实例 ID 分离。飞书允许多个实例，例如 `feishu-<uuid>`。
    #[serde(default)]
    pub channel_type: String,
    pub display_name: String,
    /// 是否启用（禁用的渠道不出现在 Tab）
    pub enabled: bool,
    /// 应用启动时是否自动连接
    pub auto_start: bool,
    /// 处理该渠道消息的数字员工 id
    pub human_id: String,
    /// 是否在面板显示消息记录（默认隐藏，用户可手动展开）
    pub show_messages: bool,
    /// 渠道特有配置（飞书的 app_id/secret 等），JSON 字符串
    #[serde(default)]
    pub config_json: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageChannelList {
    pub channels: Vec<MessageChannel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageChannelRecord {
    pub record_id: i64,
    pub channel_id: String,
    pub event_key: String,
    pub external_message_id: Option<String>,
    pub conversation_key: Option<String>,
    pub role: String,
    pub sender_id: Option<String>,
    pub content: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageChannelRecordList {
    pub records: Vec<MessageChannelRecord>,
}

// ── 数据库初始化（建表 + 旧库迁移） ──

fn initialize_message_channels_db(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS message_channels (
                channel_id   TEXT PRIMARY KEY,
                channel_type TEXT NOT NULL DEFAULT '',
                display_name TEXT NOT NULL DEFAULT '',
                enabled      INTEGER NOT NULL DEFAULT 0,
                auto_start   INTEGER NOT NULL DEFAULT 1,
                human_id     TEXT NOT NULL DEFAULT 'general-chat',
                show_messages INTEGER NOT NULL DEFAULT 0,
                config_json  TEXT NOT NULL DEFAULT '{}',
                updated_at   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS message_channel_records (
                record_id           INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id          TEXT NOT NULL,
                event_key           TEXT NOT NULL,
                external_message_id TEXT,
                conversation_key    TEXT,
                role                TEXT NOT NULL,
                sender_id           TEXT,
                content             TEXT NOT NULL,
                created_at_ms       INTEGER NOT NULL,
                UNIQUE(channel_id, event_key)
            );
            CREATE INDEX IF NOT EXISTS idx_message_channel_records_channel_time
              ON message_channel_records(channel_id, created_at_ms DESC, record_id DESC);
            "#,
        )
        .map_err(|error| format!("初始化消息通道表失败：{error}"))?;

    // 兼容旧库：早期版本以 channel_id 同时表示类型和实例，没有 channel_type 列。
    let has_channel_type = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('message_channels') WHERE name = 'channel_type'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("检查消息通道表结构失败：{error}"))?
        > 0;
    if !has_channel_type {
        connection
            .execute(
                "ALTER TABLE message_channels ADD COLUMN channel_type TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|error| format!("升级消息通道表失败：{error}"))?;
    }
    connection
        .execute(
            "UPDATE message_channels SET channel_type = CASE WHEN channel_id LIKE 'feishu-%' THEN 'feishu' ELSE channel_id END WHERE channel_type = ''",
            [],
        )
        .map_err(|error| format!("补全消息通道类型失败：{error}"))?;

    // 不再 seed 任何默认渠道：所有渠道（含微信）都由用户在面板「新建渠道」手动添加。
    // 全新安装时 message_channels 表为空，面板显示空状态引导用户新建。

    Ok(())
}

// ── 行映射 ──

fn row_to_channel(row: &rusqlite::Row) -> rusqlite::Result<MessageChannel> {
    Ok(MessageChannel {
        channel_id: row.get::<_, String>(0)?,
        channel_type: row.get::<_, String>(1)?,
        display_name: row.get::<_, String>(2)?,
        enabled: row.get::<_, i64>(3)? != 0,
        auto_start: row.get::<_, i64>(4)? != 0,
        human_id: row.get::<_, String>(5)?,
        show_messages: row.get::<_, i64>(6)? != 0,
        config_json: row.get::<_, String>(7)?,
        updated_at: row.get::<_, String>(8)?,
    })
}

fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<MessageChannelRecord> {
    Ok(MessageChannelRecord {
        record_id: row.get(0)?,
        channel_id: row.get(1)?,
        event_key: row.get(2)?,
        external_message_id: row.get(3)?,
        conversation_key: row.get(4)?,
        role: row.get(5)?,
        sender_id: row.get(6)?,
        content: row.get(7)?,
        created_at_ms: row.get(8)?,
    })
}

// ── config_json 敏感字段混淆 ──

/// 把 config_json 中指定 key 的字符串值加密（落库前调）。
/// 解析失败或非对象 JSON 时原样返回，不影响其他字段。
fn encrypt_config_sensitive(config_json: &str, channel_id: &str, key_seed: &str) -> String {
    let keys = sensitive_keys_for(channel_id);
    if keys.is_empty() || config_json.is_empty() {
        return config_json.to_string();
    }
    let mut value: Value = match serde_json::from_str(config_json) {
        Ok(v) => v,
        Err(_) => return config_json.to_string(), // 容错：非合法 JSON 不动它
    };
    let obj = match value.as_object_mut() {
        Some(o) => o,
        None => return config_json.to_string(),
    };
    for key in keys {
        if let Some(s) = obj.get(*key).and_then(|v| v.as_str()) {
            // 已是密文不再重复加密
            if !secrets::is_cipher(s) {
                obj.insert(
                    (*key).to_string(),
                    Value::String(secrets::encrypt(s, key_seed)),
                );
            }
        }
    }
    serde_json::to_string(&value).unwrap_or_else(|_| config_json.to_string())
}

/// 把 config_json 中指定 key 的字符串值解密（读取后调）。
fn decrypt_config_sensitive(config_json: &str, channel_id: &str, key_seed: &str) -> String {
    let keys = sensitive_keys_for(channel_id);
    if keys.is_empty() || config_json.is_empty() {
        return config_json.to_string();
    }
    let mut value: Value = match serde_json::from_str(config_json) {
        Ok(v) => v,
        Err(_) => return config_json.to_string(),
    };
    let obj = match value.as_object_mut() {
        Some(o) => o,
        None => return config_json.to_string(),
    };
    for key in keys {
        if let Some(s) = obj.get(*key).and_then(|v| v.as_str()) {
            if secrets::is_cipher(s) {
                obj.insert(
                    (*key).to_string(),
                    Value::String(secrets::decrypt(s, key_seed)),
                );
            }
        }
    }
    serde_json::to_string(&value).unwrap_or_else(|_| config_json.to_string())
}

fn resolve_channel_type(channel_id: &str, channel_type: &str) -> String {
    if !channel_type.trim().is_empty() {
        return channel_type.trim().to_string();
    }
    if channel_id.starts_with("feishu-") {
        return "feishu".to_string();
    }
    channel_id.to_string()
}

/// 校验渠道类型和实例 ID。飞书可多实例，其他现有渠道仍保持单实例。
fn validate_channel_id(channel_id: &str, channel_type: &str) -> Result<(), String> {
    if channel_id.trim().is_empty() {
        return Err("渠道 ID 不能为空".to_string());
    }
    if !BUILTIN_CHANNEL_TYPES.contains(&channel_type) {
        return Err(format!("不支持的消息通道类型：{channel_type}"));
    }
    if channel_type == "feishu" {
        let valid = channel_id == "feishu"
            || (channel_id.starts_with("feishu-")
                && channel_id.len() <= 80
                && channel_id
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
        if !valid {
            return Err("飞书通道实例 ID 格式不正确".to_string());
        }
    } else if channel_id != channel_type {
        return Err(format!("{channel_type} 通道暂不支持创建多个实例"));
    }
    Ok(())
}

// ── Tauri commands ──

#[tauri::command]
pub fn list_message_channels(app: AppHandle) -> Result<MessageChannelList, String> {
    app_database::with_database(
        &app,
        initialize_message_channels_db,
        |connection, db_path| {
            // key_seed 用数据库文件路径（机器 + 用户 + 安装位置绑定）
            let key_seed = db_path.to_string_lossy().to_string();
            let mut stmt = connection
            .prepare("SELECT channel_id, channel_type, display_name, enabled, auto_start, human_id, show_messages, config_json, updated_at FROM message_channels ORDER BY updated_at DESC, channel_id")
            .map_err(|error| format!("查询消息通道失败：{error}"))?;
            let channels = stmt
                .query_map([], row_to_channel)
                .map_err(|error| format!("查询消息通道失败：{error}"))?
                .collect::<rusqlite::Result<Vec<MessageChannel>>>()
                .map_err(|error| format!("查询消息通道失败：{error}"))?;
            // 出库后解密敏感字段
            let channels = channels
                .into_iter()
                .map(|mut c| {
                    c.config_json =
                        decrypt_config_sensitive(&c.config_json, &c.channel_type, &key_seed);
                    c
                })
                .collect();
            Ok(MessageChannelList { channels })
        },
    )
}

#[tauri::command]
pub fn get_message_channel(app: AppHandle, channel_id: String) -> Result<MessageChannel, String> {
    app_database::with_database(
        &app,
        initialize_message_channels_db,
        |connection, db_path| {
            let key_seed = db_path.to_string_lossy().to_string();
            let mut channel = connection
            .query_row(
                "SELECT channel_id, channel_type, display_name, enabled, auto_start, human_id, show_messages, config_json, updated_at FROM message_channels WHERE channel_id = ?1",
                rusqlite::params![channel_id],
                row_to_channel,
            )
            .map_err(|error| format!("查询消息通道失败：{error}"))?;
            channel.config_json =
                decrypt_config_sensitive(&channel.config_json, &channel.channel_type, &key_seed);
            Ok(channel)
        },
    )
}

/// 保存（upsert）一个消息通道配置。
/// 校验 channel_id 白名单；敏感字段（telegram.botToken 等）落库前混淆。
#[tauri::command]
pub fn save_message_channel(app: AppHandle, channel: MessageChannel) -> Result<(), String> {
    let channel_type = resolve_channel_type(&channel.channel_id, &channel.channel_type);
    validate_channel_id(&channel.channel_id, &channel_type)?;
    app_database::with_database_mut(
        &app,
        initialize_message_channels_db,
        |connection, db_path| {
            let key_seed = db_path.to_string_lossy().to_string();
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            let raw_config = if channel.config_json.is_empty() {
                "{}".to_string()
            } else {
                channel.config_json
            };
            // 入库前加密敏感字段
            let config_json = encrypt_config_sensitive(&raw_config, &channel_type, &key_seed);
            connection
            .execute(
                r#"INSERT INTO message_channels
                   (channel_id, channel_type, display_name, enabled, auto_start, human_id, show_messages, config_json, updated_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                   ON CONFLICT(channel_id) DO UPDATE SET
                     channel_type = excluded.channel_type,
                     display_name = excluded.display_name,
                     enabled = excluded.enabled,
                     auto_start = excluded.auto_start,
                     human_id = excluded.human_id,
                     show_messages = excluded.show_messages,
                     config_json = excluded.config_json,
                     updated_at = excluded.updated_at"#,
                rusqlite::params![
                    channel.channel_id,
                    channel_type,
                    channel.display_name,
                    channel.enabled as i64,
                    channel.auto_start as i64,
                    channel.human_id,
                    channel.show_messages as i64,
                    config_json,
                    now,
                ],
            )
            .map_err(|error| format!("保存消息通道失败：{error}"))?;
            Ok(())
        },
    )
}

#[tauri::command]
pub fn list_message_channel_records(
    app: AppHandle,
    channel_id: String,
    limit: Option<u32>,
    before_id: Option<i64>,
) -> Result<MessageChannelRecordList, String> {
    let limit = i64::from(limit.unwrap_or(200).clamp(1, 500));
    app_database::with_database(&app, initialize_message_channels_db, |connection, _| {
        let mut records = if let Some(before_id) = before_id {
            let mut stmt = connection
                .prepare(
                    "SELECT record_id, channel_id, event_key, external_message_id, conversation_key, role, sender_id, content, created_at_ms FROM message_channel_records WHERE channel_id = ?1 AND record_id < ?2 ORDER BY record_id DESC LIMIT ?3",
                )
                .map_err(|error| format!("查询消息记录失败：{error}"))?;
            let rows = stmt
                .query_map(
                    rusqlite::params![channel_id, before_id, limit],
                    row_to_record,
                )
                .map_err(|error| format!("查询消息记录失败：{error}"))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| format!("读取消息记录失败：{error}"))?;
            rows
        } else {
            let mut stmt = connection
                .prepare(
                    "SELECT record_id, channel_id, event_key, external_message_id, conversation_key, role, sender_id, content, created_at_ms FROM message_channel_records WHERE channel_id = ?1 ORDER BY record_id DESC LIMIT ?2",
                )
                .map_err(|error| format!("查询消息记录失败：{error}"))?;
            let rows = stmt
                .query_map(rusqlite::params![channel_id, limit], row_to_record)
                .map_err(|error| format!("查询消息记录失败：{error}"))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| format!("读取消息记录失败：{error}"))?;
            rows
        };
        records.reverse();
        Ok(MessageChannelRecordList { records })
    })
}

/// 把 sidecar 发出的渠道消息事件持久化。失败只写日志，不阻断事件继续送往前端。
pub fn persist_message_event(app: &AppHandle, event: &Value) -> Result<(), String> {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    let channel_id = match event_type {
        "wechat_message" => "wechat".to_string(),
        "telegram_message" => "telegram".to_string(),
        "feishu_message" => event
            .get("channelId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        _ => return Ok(()),
    };
    if channel_id.is_empty() {
        return Err("消息事件缺少 channelId".to_string());
    }
    let role = event.get("role").and_then(Value::as_str).unwrap_or("");
    let content = event.get("text").and_then(Value::as_str).unwrap_or("");
    if !matches!(role, "incoming" | "assistant") || content.trim().is_empty() {
        return Ok(());
    }
    let external_message_id = event.get("reqId").and_then(Value::as_str);
    let created_at_ms = event
        .get("timestamp")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    let event_key = event
        .get("eventKey")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            external_message_id
                .map(|message_id| format!("{role}:{message_id}"))
                .unwrap_or_else(|| format!("{event_type}:{role}:no-id:{created_at_ms}"))
        });
    let conversation_key = event.get("conversationKey").and_then(Value::as_str);
    let sender_id = event.get("fromUser").and_then(Value::as_str);

    app_database::with_database_mut(app, initialize_message_channels_db, |connection, _| {
        connection
            .execute(
                r#"INSERT OR IGNORE INTO message_channel_records
                   (channel_id, event_key, external_message_id, conversation_key, role, sender_id, content, created_at_ms)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
                rusqlite::params![
                    channel_id,
                    event_key,
                    external_message_id,
                    conversation_key,
                    role,
                    sender_id,
                    content,
                    created_at_ms,
                ],
            )
            .map_err(|error| format!("保存消息记录失败：{error}"))?;
        // 每个实例只保留最近 5000 条，避免长期运行导致本地记录无限增长。
        connection
            .execute(
                "DELETE FROM message_channel_records WHERE channel_id = ?1 AND record_id NOT IN (SELECT record_id FROM message_channel_records WHERE channel_id = ?1 ORDER BY record_id DESC LIMIT 5000)",
                rusqlite::params![channel_id],
            )
            .map_err(|error| format!("清理过期消息记录失败：{error}"))?;
        Ok(())
    })
}

/// 删除一个消息通道。
///
/// 所有渠道统一走 DELETE：删了就彻底移除。需要时可通过「新建渠道」重新添加。
/// （不再有任何默认 seed，删除后不会自动复活。）
#[tauri::command]
pub fn delete_message_channel(app: AppHandle, channel_id: String) -> Result<(), String> {
    app_database::with_database_mut(&app, initialize_message_channels_db, |connection, _| {
        connection
            .execute(
                "DELETE FROM message_channels WHERE channel_id = ?1",
                rusqlite::params![channel_id],
            )
            .map_err(|error| format!("删除消息通道失败：{error}"))?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_multiple_feishu_instances_but_keeps_other_types_singleton() {
        assert!(validate_channel_id("feishu-a1_b2", "feishu").is_ok());
        assert!(validate_channel_id("feishu-another", "feishu").is_ok());
        assert!(validate_channel_id("telegram-copy", "telegram").is_err());
    }

    /// 全新数据库初始化：只建表，不 seed 任何默认渠道。
    /// 所有渠道都应由用户在面板手动新建，init 后 message_channels 必须为空。
    #[test]
    fn initializes_schema_without_seeding_default_channel() {
        let connection = Connection::open_in_memory().expect("open db");
        initialize_message_channels_db(&connection).expect("initialize");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM message_channels", [], |row| row.get(0))
            .expect("query");
        assert_eq!(count, 0, "全新库 init 后不应有任何默认渠道");
        // 反复 init 也不应插入（防止 with_database 每次调用都 seed 的回归）
        initialize_message_channels_db(&connection).expect("re-init");
        let count_again: i64 = connection
            .query_row("SELECT COUNT(*) FROM message_channels", [], |row| row.get(0))
            .expect("query");
        assert_eq!(count_again, 0, "再次 init 仍不应 seed 任何渠道");
    }

    #[test]
    fn migrates_legacy_channel_table_without_losing_rows() {
        let connection = Connection::open_in_memory().expect("open db");
        connection
            .execute_batch(
                r#"
                CREATE TABLE message_channels (
                    channel_id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL DEFAULT '',
                    enabled INTEGER NOT NULL DEFAULT 0,
                    auto_start INTEGER NOT NULL DEFAULT 1,
                    human_id TEXT NOT NULL DEFAULT 'general-chat',
                    show_messages INTEGER NOT NULL DEFAULT 0,
                    config_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL
                );
                INSERT INTO message_channels VALUES
                  ('telegram', 'Telegram', 1, 1, 'general-chat', 0, '{}', '2026-01-01');
                "#,
            )
            .expect("legacy schema");
        initialize_message_channels_db(&connection).expect("migrate");
        let channel_type: String = connection
            .query_row(
                "SELECT channel_type FROM message_channels WHERE channel_id = 'telegram'",
                [],
                |row| row.get(0),
            )
            .expect("legacy row remains");
        assert_eq!(channel_type, "telegram");
        // 迁移不应新增任何渠道（不 seed wechat 等）
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM message_channels", [], |row| row.get(0))
            .expect("query");
        assert_eq!(count, 1, "迁移不应新增渠道，只保留老库已有的行");
    }
}
