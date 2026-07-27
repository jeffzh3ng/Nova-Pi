use std::path::{Path, PathBuf};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

pub fn app_database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(dir.join("nova.sqlite3"))
}

pub fn open_database_at<I>(path: &Path, initialize: I) -> Result<Connection, String>
where
    I: FnOnce(&Connection) -> Result<(), String>,
{
    let connection =
        Connection::open(path).map_err(|error| format!("无法打开 SQLite 数据库：{error}"))?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("无法启用本地存储外键约束：{error}"))?;
    initialize(&connection)?;
    Ok(connection)
}

pub fn with_database<I, F, T>(app: &AppHandle, initialize: I, operation: F) -> Result<T, String>
where
    I: FnOnce(&Connection) -> Result<(), String>,
    F: FnOnce(&Connection, &Path) -> Result<T, String>,
{
    let path = app_database_path(app)?;
    let connection = open_database_at(&path, initialize)?;
    operation(&connection, &path)
}

pub fn with_database_mut<I, F, T>(app: &AppHandle, initialize: I, operation: F) -> Result<T, String>
where
    I: FnOnce(&Connection) -> Result<(), String>,
    F: FnOnce(&mut Connection, &Path) -> Result<T, String>,
{
    let path = app_database_path(app)?;
    let mut connection = open_database_at(&path, initialize)?;
    operation(&mut connection, &path)
}
