//! 内置电脑智能员工的授权设置。
//!
//! 这些设置是 pi 原生文件/命令工具的安全边界。默认员工存在但未启用，所有高权限
//! 能力均默认关闭；前端设置页保存后再同步给 Node host，host 会在创建每个会话时
//! 重新校验，避免其他数字员工继承这些权限。

use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::app_database;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerAgentSettings {
    pub enabled: bool,
    pub display_name: String,
    pub working_directory: String,
    pub allow_file_read: bool,
    pub allow_file_write: bool,
    pub allow_command_execution: bool,
    pub allow_skills: bool,
    pub allow_computer_info: bool,
    pub allow_nova_management: bool,
}

fn default_working_directory() -> String {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        })
}

pub fn default_computer_agent_settings() -> ComputerAgentSettings {
    ComputerAgentSettings {
        enabled: false,
        display_name: "Nova".to_string(),
        working_directory: default_working_directory(),
        allow_file_read: false,
        allow_file_write: false,
        allow_command_execution: false,
        allow_skills: false,
        allow_computer_info: false,
        allow_nova_management: false,
    }
}

#[tauri::command]
pub fn get_computer_agent_settings(app: AppHandle) -> Result<ComputerAgentSettings, String> {
    app_database::with_database(&app, initialize_db, |connection, _| {
        load_settings(connection)
    })
}

#[tauri::command]
pub fn save_computer_agent_settings(
    app: AppHandle,
    settings: ComputerAgentSettings,
) -> Result<ComputerAgentSettings, String> {
    let normalized = normalize_settings(settings)?;
    app_database::with_database(&app, initialize_db, |connection, _| {
        connection
            .execute(
                r#"
                INSERT INTO computer_agent_settings (
                    id, enabled, display_name, working_directory, allow_file_read,
                    allow_file_write, allow_command_execution, allow_skills,
                    allow_computer_info, allow_nova_management, updated_at
                ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(id) DO UPDATE SET
                    enabled = excluded.enabled,
                    display_name = excluded.display_name,
                    working_directory = excluded.working_directory,
                    allow_file_read = excluded.allow_file_read,
                    allow_file_write = excluded.allow_file_write,
                    allow_command_execution = excluded.allow_command_execution,
                    allow_skills = excluded.allow_skills,
                    allow_computer_info = excluded.allow_computer_info,
                    allow_nova_management = excluded.allow_nova_management,
                    updated_at = excluded.updated_at
                "#,
                params![
                    normalized.enabled as i64,
                    normalized.display_name,
                    normalized.working_directory,
                    normalized.allow_file_read as i64,
                    normalized.allow_file_write as i64,
                    normalized.allow_command_execution as i64,
                    normalized.allow_skills as i64,
                    normalized.allow_computer_info as i64,
                    normalized.allow_nova_management as i64,
                    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                ],
            )
            .map_err(|error| format!("保存智能员工设置失败：{error}"))?;
        load_settings(connection)
    })
}

#[tauri::command]
pub async fn pick_computer_agent_working_directory() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| {
        Ok(rfd::FileDialog::new()
            .set_title("选择 Nova 工作目录")
            .pick_folder()
            .map(|path| path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|error| format!("选择工作目录失败：{error}"))?
}

fn normalize_settings(
    mut settings: ComputerAgentSettings,
) -> Result<ComputerAgentSettings, String> {
    settings.display_name = settings.display_name.trim().to_string();
    settings.working_directory = settings.working_directory.trim().to_string();
    if settings.display_name.is_empty() {
        return Err("智能员工名称不能为空。".to_string());
    }
    if settings.display_name.chars().count() > 40 {
        return Err("智能员工名称不能超过 40 个字符。".to_string());
    }
    if settings.working_directory.is_empty() {
        return Err("工作目录不能为空。".to_string());
    }
    let path = Path::new(&settings.working_directory);
    if !path.is_absolute() {
        return Err("工作目录必须使用绝对路径。".to_string());
    }
    if !path.is_dir() {
        return Err("工作目录不存在或不是文件夹。".to_string());
    }
    Ok(settings)
}

fn initialize_db(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS computer_agent_settings (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                enabled INTEGER NOT NULL DEFAULT 0,
                display_name TEXT NOT NULL DEFAULT 'Nova',
                working_directory TEXT NOT NULL,
                allow_file_read INTEGER NOT NULL DEFAULT 0,
                allow_file_write INTEGER NOT NULL DEFAULT 0,
                allow_command_execution INTEGER NOT NULL DEFAULT 0,
                allow_skills INTEGER NOT NULL DEFAULT 0,
                allow_computer_info INTEGER NOT NULL DEFAULT 0,
                allow_nova_management INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );
            "#,
        )
        .map_err(|error| format!("初始化智能员工设置失败：{error}"))?;
    ensure_column(
        connection,
        "computer_agent_settings",
        "allow_skills",
        "INTEGER NOT NULL DEFAULT 0",
    )?;

    let defaults = default_computer_agent_settings();
    connection
        .execute(
            r#"
            INSERT OR IGNORE INTO computer_agent_settings (
                id, enabled, display_name, working_directory, allow_file_read,
                allow_file_write, allow_command_execution, allow_skills,
                allow_computer_info, allow_nova_management, updated_at
            ) VALUES (1, 0, ?1, ?2, 0, 0, 0, 0, 0, 0, ?3)
            "#,
            params![
                defaults.display_name,
                defaults.working_directory,
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            ],
        )
        .map_err(|error| format!("写入智能员工默认设置失败：{error}"))?;
    connection
        .execute(
            "UPDATE computer_agent_settings SET display_name = 'Nova' WHERE id = 1 AND display_name = 'Nova 智能员工'",
            [],
        )
        .map_err(|error| format!("更新智能员工默认名称失败：{error}"))?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("读取智能员工设置结构失败：{error}"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("读取智能员工设置字段失败：{error}"))?;
    for name in names {
        if name.map_err(|error| format!("读取智能员工设置字段失败：{error}"))? == column
        {
            return Ok(());
        }
    }
    connection
        .execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )
        .map_err(|error| format!("升级智能员工设置失败：{error}"))?;
    Ok(())
}

fn load_settings(connection: &Connection) -> Result<ComputerAgentSettings, String> {
    connection
        .query_row(
            r#"
            SELECT enabled, display_name, working_directory, allow_file_read,
                   allow_file_write, allow_command_execution, allow_skills,
                   allow_computer_info, allow_nova_management
              FROM computer_agent_settings
             WHERE id = 1
            "#,
            [],
            |row| {
                Ok(ComputerAgentSettings {
                    enabled: row.get::<_, i64>(0)? != 0,
                    display_name: row.get(1)?,
                    working_directory: row.get(2)?,
                    allow_file_read: row.get::<_, i64>(3)? != 0,
                    allow_file_write: row.get::<_, i64>(4)? != 0,
                    allow_command_execution: row.get::<_, i64>(5)? != 0,
                    allow_skills: row.get::<_, i64>(6)? != 0,
                    allow_computer_info: row.get::<_, i64>(7)? != 0,
                    allow_nova_management: row.get::<_, i64>(8)? != 0,
                })
            },
        )
        .map_err(|error| format!("读取智能员工设置失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_disabled_and_unprivileged() {
        let settings = default_computer_agent_settings();
        assert_eq!(settings.display_name, "Nova");
        assert!(!settings.enabled);
        assert!(!settings.allow_file_read);
        assert!(!settings.allow_file_write);
        assert!(!settings.allow_command_execution);
        assert!(!settings.allow_skills);
        assert!(!settings.allow_computer_info);
        assert!(!settings.allow_nova_management);
    }

    #[test]
    fn legacy_default_display_name_is_migrated() {
        let connection = Connection::open_in_memory().expect("open db");
        initialize_db(&connection).expect("initialize");
        connection
            .execute(
                "UPDATE computer_agent_settings SET display_name = 'Nova 智能员工' WHERE id = 1",
                [],
            )
            .expect("set legacy default");
        initialize_db(&connection).expect("migrate");

        let loaded = load_settings(&connection).expect("load migrated settings");
        assert_eq!(loaded.display_name, "Nova");
    }

    #[test]
    fn sqlite_roundtrip_preserves_authorizations() {
        let connection = Connection::open_in_memory().expect("open db");
        initialize_db(&connection).expect("initialize");
        let mut settings = load_settings(&connection).expect("load defaults");
        settings.enabled = true;
        settings.allow_file_read = true;
        settings.allow_nova_management = true;
        connection
            .execute(
                "UPDATE computer_agent_settings SET enabled = 1, allow_file_read = 1, allow_nova_management = 1 WHERE id = 1",
                [],
            )
            .expect("update");
        let loaded = load_settings(&connection).expect("reload");
        assert!(loaded.enabled);
        assert!(loaded.allow_file_read);
        assert!(loaded.allow_nova_management);
        assert!(!loaded.allow_command_execution);
        assert!(!loaded.allow_skills);
    }
}
