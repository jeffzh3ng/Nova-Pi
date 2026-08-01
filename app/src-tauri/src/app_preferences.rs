use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::app_database;

static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferences {
    pub close_to_tray: bool,
    pub show_tool_messages: bool,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            show_tool_messages: false,
        }
    }
}

pub fn should_close_to_tray() -> bool {
    CLOSE_TO_TRAY.load(Ordering::Relaxed)
}

pub fn refresh_cache(app: &AppHandle) -> Result<AppPreferences, String> {
    let settings = load(app)?;
    CLOSE_TO_TRAY.store(settings.close_to_tray, Ordering::Relaxed);
    Ok(settings)
}

#[tauri::command]
pub fn get_app_preferences(app: AppHandle) -> Result<AppPreferences, String> {
    refresh_cache(&app)
}

#[tauri::command]
pub fn save_app_preferences(
    app: AppHandle,
    preferences: AppPreferences,
) -> Result<AppPreferences, String> {
    app_database::with_database(&app, initialize_db, |connection, _| {
        connection
            .execute(
                r#"
                INSERT INTO app_preferences (id, close_to_tray, show_tool_messages, updated_at)
                VALUES (1, ?1, ?2, ?3)
                ON CONFLICT(id) DO UPDATE SET
                    close_to_tray = excluded.close_to_tray,
                    show_tool_messages = excluded.show_tool_messages,
                    updated_at = excluded.updated_at
                "#,
                params![
                    preferences.close_to_tray as i64,
                    preferences.show_tool_messages as i64,
                    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                ],
            )
            .map_err(|error| format!("保存应用偏好失败：{error}"))?;
        Ok(())
    })?;
    CLOSE_TO_TRAY.store(preferences.close_to_tray, Ordering::Relaxed);
    Ok(preferences)
}

fn load(app: &AppHandle) -> Result<AppPreferences, String> {
    app_database::with_database(app, initialize_db, |connection, _| {
        connection
            .query_row(
                "SELECT close_to_tray, show_tool_messages FROM app_preferences WHERE id = 1",
                [],
                |row| {
                    Ok(AppPreferences {
                        close_to_tray: row.get::<_, i64>(0)? != 0,
                        show_tool_messages: row.get::<_, i64>(1)? != 0,
                    })
                },
            )
            .map_err(|error| format!("读取应用偏好失败：{error}"))
    })
}

fn initialize_db(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS app_preferences (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                close_to_tray INTEGER NOT NULL DEFAULT 1,
                show_tool_messages INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );
            "#,
        )
        .map_err(|error| format!("初始化应用偏好失败：{error}"))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO app_preferences (id, close_to_tray, show_tool_messages, updated_at) VALUES (1, 1, 0, ?1)",
            params![chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()],
        )
        .map_err(|error| format!("写入默认应用偏好失败：{error}"))?;
    Ok(())
}
