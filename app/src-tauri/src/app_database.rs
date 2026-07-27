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
    // 启用 WAL + busy_timeout：并发写（自动保存 / 标题生成 / token 写入）默认 rollback journal
    // + 0 超时会直接抛 SQLITE_BUSY，用户偶发看到"保存失败"。WAL 允许并发读+单写，busy_timeout
    // 让写方等待 5s 而非立即失败。
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;\
             PRAGMA busy_timeout = 5000;\
             PRAGMA synchronous = NORMAL;\
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|error| format!("无法初始化本地存储参数：{error}"))?;
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
