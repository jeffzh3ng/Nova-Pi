//! 消息通道（微信/飞书/...）配置：SQLite 表 + CRUD。
//!
//! 与 mcp_settings.rs 同风格：通过 app_database::with_database 拿连接，
//! initialize 函数里建表 + 懒 seed 默认渠道。
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

/// 默认渠道：微信。首次 list 时 seed。
pub const WECHAT_CHANNEL_ID: &str = "wechat";

/// 内置渠道白名单（save 时校验 channel_id，防止前端任意构造 id 覆盖内置行）。
/// 未来新增渠道（飞书等）在此登记。
const BUILTIN_CHANNEL_IDS: &[&str] = &["wechat", "telegram", "feishu", "dingtalk"];

/// config_json 中需要混淆存储的字段路径（按渠道类型）。
/// telegram.botToken 是核心敏感数据；其他渠道目前无敏感字段。
fn sensitive_keys_for(channel_id: &str) -> &'static [&'static str] {
    match channel_id {
        "telegram" => &["botToken"],
        _ => &[],
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageChannel {
    pub channel_id: String,
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

// ── 数据库初始化（建表 + 懒 seed） ──

fn initialize_message_channels_db(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS message_channels (
                channel_id   TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                enabled      INTEGER NOT NULL DEFAULT 0,
                auto_start   INTEGER NOT NULL DEFAULT 1,
                human_id     TEXT NOT NULL DEFAULT 'general-chat',
                show_messages INTEGER NOT NULL DEFAULT 0,
                config_json  TEXT NOT NULL DEFAULT '{}',
                updated_at   TEXT NOT NULL
            );
            "#,
        )
        .map_err(|error| format!("初始化消息通道表失败：{error}"))?;

    // 懒 seed：首次初始化时插入默认微信渠道（已存在则跳过）。
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    connection
        .execute(
            r#"INSERT OR IGNORE INTO message_channels
               (channel_id, display_name, enabled, auto_start, human_id, show_messages, config_json, updated_at)
               VALUES (?1, ?2, 1, 1, 'general-chat', 0, '{}', ?3)"#,
            rusqlite::params![WECHAT_CHANNEL_ID, "微信", now],
        )
        .map_err(|error| format!("seed 默认消息通道失败：{error}"))?;

    Ok(())
}

// ── 行映射 ──

fn row_to_channel(row: &rusqlite::Row) -> rusqlite::Result<MessageChannel> {
    Ok(MessageChannel {
        channel_id: row.get::<_, String>(0)?,
        display_name: row.get::<_, String>(1)?,
        enabled: row.get::<_, i64>(2)? != 0,
        auto_start: row.get::<_, i64>(3)? != 0,
        human_id: row.get::<_, String>(4)?,
        show_messages: row.get::<_, i64>(5)? != 0,
        config_json: row.get::<_, String>(6)?,
        updated_at: row.get::<_, String>(7)?,
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

/// 校验 channel_id 合法性（白名单）。新增/编辑都需校验，防止前端任意构造 id。
fn validate_channel_id(channel_id: &str) -> Result<(), String> {
    if channel_id.trim().is_empty() {
        return Err("渠道 ID 不能为空".to_string());
    }
    if !BUILTIN_CHANNEL_IDS.iter().any(|id| *id == channel_id) {
        return Err(format!("不支持的渠道类型：{channel_id}"));
    }
    Ok(())
}

// ── Tauri commands ──

#[tauri::command]
pub fn list_message_channels(app: AppHandle) -> Result<MessageChannelList, String> {
    app_database::with_database(&app, initialize_message_channels_db, |connection, db_path| {
        // key_seed 用数据库文件路径（机器 + 用户 + 安装位置绑定）
        let key_seed = db_path.to_string_lossy().to_string();
        let mut stmt = connection
            .prepare("SELECT channel_id, display_name, enabled, auto_start, human_id, show_messages, config_json, updated_at FROM message_channels ORDER BY channel_id")
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
                c.config_json = decrypt_config_sensitive(&c.config_json, &c.channel_id, &key_seed);
                c
            })
            .collect();
        Ok(MessageChannelList { channels })
    })
}

#[tauri::command]
pub fn get_message_channel(app: AppHandle, channel_id: String) -> Result<MessageChannel, String> {
    app_database::with_database(&app, initialize_message_channels_db, |connection, db_path| {
        let key_seed = db_path.to_string_lossy().to_string();
        let mut channel = connection
            .query_row(
                "SELECT channel_id, display_name, enabled, auto_start, human_id, show_messages, config_json, updated_at FROM message_channels WHERE channel_id = ?1",
                rusqlite::params![channel_id],
                row_to_channel,
            )
            .map_err(|error| format!("查询消息通道失败：{error}"))?;
        channel.config_json =
            decrypt_config_sensitive(&channel.config_json, &channel.channel_id, &key_seed);
        Ok(channel)
    })
}

/// 保存（upsert）一个消息通道配置。
/// 校验 channel_id 白名单；敏感字段（telegram.botToken 等）落库前混淆。
#[tauri::command]
pub fn save_message_channel(app: AppHandle, channel: MessageChannel) -> Result<(), String> {
    validate_channel_id(&channel.channel_id)?;
    app_database::with_database_mut(&app, initialize_message_channels_db, |connection, db_path| {
        let key_seed = db_path.to_string_lossy().to_string();
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let raw_config = if channel.config_json.is_empty() {
            "{}".to_string()
        } else {
            channel.config_json
        };
        // 入库前加密敏感字段
        let config_json = encrypt_config_sensitive(&raw_config, &channel.channel_id, &key_seed);
        connection
            .execute(
                r#"INSERT INTO message_channels
                   (channel_id, display_name, enabled, auto_start, human_id, show_messages, config_json, updated_at)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                   ON CONFLICT(channel_id) DO UPDATE SET
                     display_name = excluded.display_name,
                     enabled = excluded.enabled,
                     auto_start = excluded.auto_start,
                     human_id = excluded.human_id,
                     show_messages = excluded.show_messages,
                     config_json = excluded.config_json,
                     updated_at = excluded.updated_at"#,
                rusqlite::params![
                    channel.channel_id,
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
    })
}

/// 删除（或禁用）一个消息通道。
/// 内置渠道（wechat）不真删，改为 enabled=0（避免 seed 逻辑反复重建）；
/// 自定义渠道（未来扩展）直接 DELETE。
#[tauri::command]
pub fn delete_message_channel(app: AppHandle, channel_id: String) -> Result<(), String> {
    app_database::with_database_mut(&app, initialize_message_channels_db, |connection, _| {
        if channel_id == WECHAT_CHANNEL_ID {
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            connection
                .execute(
                    "UPDATE message_channels SET enabled = 0, updated_at = ?2 WHERE channel_id = ?1",
                    rusqlite::params![channel_id, now],
                )
                .map_err(|error| format!("禁用消息通道失败：{error}"))?;
        } else {
            connection
                .execute(
                    "DELETE FROM message_channels WHERE channel_id = ?1",
                    rusqlite::params![channel_id],
                )
                .map_err(|error| format!("删除消息通道失败：{error}"))?;
        }
        Ok(())
    })
}
