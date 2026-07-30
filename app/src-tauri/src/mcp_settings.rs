use std::path::Path;

use chrono::Local;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::app_database;

pub const ALERT_ANALYSIS_SERVICE_ID: &str = "alert-analysis-mcp";
pub const DATA_CLASSIFICATION_SERVICE_ID: &str = "data-classification-mcp";
pub const DATA_RISK_ASSESSMENT_SERVICE_ID: &str = "data-security-risk-assessment-mcp";
pub const BUILTIN_MCP_SERVICE_IDS: &[&str] = &[
    DATA_RISK_ASSESSMENT_SERVICE_ID,
    ALERT_ANALYSIS_SERVICE_ID,
    DATA_CLASSIFICATION_SERVICE_ID,
];

const REMOVED_BUILTIN_MCP_SERVICE_IDS: &[&str] = &[
    "network-risk-assessment-mcp",
    "go-live-security-assessment-mcp",
    "dual-new-assessment-mcp",
    "incident-response-mcp",
    "incident-drill-mcp",
    "security-training-mcp",
    "security-bulletin-mcp",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionSettings {
    pub service_id: String,
    #[serde(default)]
    pub employee_name: String,
    #[serde(default)]
    pub employee_role: String,
    #[serde(default)]
    pub welcome_title: String,
    #[serde(default)]
    pub welcome_message: String,
    #[serde(default = "default_show_in_employee_list")]
    pub show_in_employee_list: bool,
    pub enabled: bool,
    pub transport: String,
    pub command_path: String,
    pub command_args: String,
    pub http_url: String,
    #[serde(default = "default_launch_mode")]
    pub launch_mode: String,
}

/// Default stdio launch mode. `script` = run a `.py` file directly;
/// `module` = run via `python -m <module>` (for packages using relative
/// imports, e.g. `python -m data_sec_risk_mcp.server`).
fn default_launch_mode() -> String {
    "script".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionSettingsStatus {
    pub settings: McpConnectionSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionSettingsCatalog {
    pub settings: Vec<McpConnectionSettings>,
}

pub fn default_mcp_connection_settings(service_id: &str) -> McpConnectionSettings {
    let service_id = normalize_service_id(service_id);
    McpConnectionSettings {
        http_url: String::new(),
        employee_name: default_employee_name(&service_id),
        employee_role: default_employee_role(&service_id),
        welcome_title: default_welcome_title(&service_id),
        welcome_message: default_welcome_message(&service_id),
        show_in_employee_list: service_id != DATA_CLASSIFICATION_SERVICE_ID,
        service_id,
        enabled: false,
        transport: "stdio".to_string(),
        command_path: String::new(),
        command_args: "--transport stdio".to_string(),
        launch_mode: default_launch_mode(),
    }
}

#[tauri::command]
pub fn list_mcp_connection_settings(
    app: AppHandle,
) -> Result<McpConnectionSettingsCatalog, String> {
    app_database::with_database(&app, initialize_mcp_db, |connection, _| {
        ensure_builtin_mcp_connection_settings(connection)?;
        let settings = list_mcp_connection_settings_from_db(connection)?;
        Ok(McpConnectionSettingsCatalog { settings })
    })
}

#[tauri::command]
pub fn save_mcp_connection_settings(
    app: AppHandle,
    settings: McpConnectionSettings,
) -> Result<McpConnectionSettingsStatus, String> {
    if settings.service_id.trim().is_empty() {
        return Err("MCP 服务 ID 不能为空。".to_string());
    }
    let settings = normalize_mcp_connection_settings(settings);
    if settings.transport == "stdio"
        && !settings.command_path.is_empty()
        && is_blocked_mcp_program(&settings.command_path)
    {
        return Err(format!(
            "不允许将 shell 或脚本解释程序「{}」配置为 MCP 启动命令，请指定 MCP 服务脚本或可执行文件。",
            settings.command_path
        ));
    }
    // 校验 command_args：黑名单只挡 command_path，攻击者可用 "python.exe -c '恶意代码'" 绕过。
    // 这里拒绝明显的 shell 元字符注入（; | & 反引号 $()），script 模式下正常脚本参数不会用到这些。
    if settings.transport == "stdio" && contains_shell_metacharacters(&settings.command_args) {
        return Err(
            "MCP 启动参数包含不允许的 shell 元字符（; | & ` $ 等），请确认参数是直接传给程序的，而非 shell 命令。".to_string(),
        );
    }
    app_database::with_database(&app, initialize_mcp_db, |connection, _| {
        let service_id = settings.service_id.clone();
        save_mcp_connection_settings_to_db(connection, &settings)?;
        let settings = load_mcp_connection_settings_from_db(connection, &service_id)?;
        Ok(McpConnectionSettingsStatus { settings })
    })
}

#[tauri::command]
pub fn delete_mcp_connection_settings(app: AppHandle, service_id: String) -> Result<(), String> {
    if service_id.trim().is_empty() {
        return Err("MCP 服务 ID 不能为空。".to_string());
    }
    let service_id = normalize_service_id(&service_id);
    app_database::with_database(&app, initialize_mcp_db, |connection, _| {
        soft_delete_mcp_connection_settings_from_db(connection, &service_id)
    })
}

/// Blocklist of shell / script interpreters that must never be spawned directly
/// as an MCP stdio command — doing so enables arbitrary command execution.
const BLOCKED_INTERPRETER_STEMS: &[&str] = &[
    "cmd",
    "powershell",
    "pwsh",
    "sh",
    "bash",
    "dash",
    "zsh",
    "csh",
    "ksh",
    "wscript",
    "cscript",
    "mshta",
    "rundll32",
    "regsvr32",
    "certutil",
    "bitsadmin",
];

/// Returns true if `program` is a shell/script interpreter or a UNC path that
/// must not be used as an MCP stdio launch command.
pub fn is_blocked_mcp_program(program: &str) -> bool {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with(r"\\") || trimmed.starts_with(r"\\?\") {
        return true;
    }
    let stem = Path::new(trimmed)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    BLOCKED_INTERPRETER_STEMS
        .iter()
        .any(|blocked| *blocked == stem)
}

/// 检测 command_args 是否含 shell 元字符，防御 "python.exe -c 'os.system(...)'"
/// 这类通过参数注入的命令执行（黑名单只挡 command_path，参数侧需要额外守门）。
///
/// 注意：这只是加固层，正常 MCP 参数（模块名、配置路径）不会包含这些字符。
/// 真正的命令构造在 host 端用 `Command::arg`（不走 shell），这里挡的是用户误配/恶意配置。
fn contains_shell_metacharacters(args: &str) -> bool {
    // 顺序无关；匹配裸的 shell 控制字符。引号是合法的（参数含空格时需要），不在拦截范围。
    const METACHARS: &[char] = &[';', '|', '&', '`', '\n', '\r'];
    args.chars().any(|c| METACHARS.contains(&c)) || args.contains("$(")
}

pub fn load_mcp_connection_settings(
    app: &AppHandle,
    service_id: &str,
) -> Result<McpConnectionSettings, String> {
    app_database::with_database(app, initialize_mcp_db, |connection, _| {
        load_mcp_connection_settings_from_db(connection, service_id)
    })
}

fn initialize_mcp_db(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS mcp_connection_settings (
                service_id TEXT PRIMARY KEY,
                employee_name TEXT NOT NULL DEFAULT '',
                employee_role TEXT NOT NULL DEFAULT '',
                welcome_title TEXT NOT NULL DEFAULT '',
                welcome_message TEXT NOT NULL DEFAULT '',
                show_in_employee_list INTEGER NOT NULL DEFAULT 1,
                deleted INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL,
                transport TEXT NOT NULL,
                command_path TEXT NOT NULL,
                command_args TEXT NOT NULL,
                http_url TEXT NOT NULL,
                launch_mode TEXT NOT NULL DEFAULT 'script',
                updated_at TEXT NOT NULL
            );
            "#,
        )
        .map_err(|error| format!("初始化 MCP 连接配置表失败：{error}"))?;
    let _ = connection.execute_batch(
        "ALTER TABLE mcp_connection_settings ADD COLUMN employee_name TEXT NOT NULL DEFAULT '';",
    );
    let _ = connection.execute_batch(
        "ALTER TABLE mcp_connection_settings ADD COLUMN employee_role TEXT NOT NULL DEFAULT '';",
    );
    let _ = connection.execute_batch(
        "ALTER TABLE mcp_connection_settings ADD COLUMN welcome_title TEXT NOT NULL DEFAULT '';",
    );
    let _ = connection.execute_batch(
        "ALTER TABLE mcp_connection_settings ADD COLUMN welcome_message TEXT NOT NULL DEFAULT '';",
    );
    if connection
        .execute_batch(
            "ALTER TABLE mcp_connection_settings ADD COLUMN show_in_employee_list INTEGER NOT NULL DEFAULT 1;",
        )
        .is_ok()
    {
        connection
            .execute(
                "UPDATE mcp_connection_settings SET show_in_employee_list = 0 WHERE service_id = ?1",
                params![DATA_CLASSIFICATION_SERVICE_ID],
            )
            .map_err(|error| format!("迁移 MCP 数字员工展示配置失败：{error}"))?;
    }
    let _ = connection.execute_batch(
        "ALTER TABLE mcp_connection_settings ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;",
    );
    let _ = connection.execute_batch(
        "ALTER TABLE mcp_connection_settings ADD COLUMN launch_mode TEXT NOT NULL DEFAULT 'script';",
    );
    // Rename the data risk-assessment service id to match the deployed MCP server.
    // service_id is the primary key, so UPDATE renames in place and preserves the
    // already-configured command_path/args/transport. Idempotent: once renamed the
    // WHERE clause no longer matches on subsequent runs.
    let _ = connection.execute_batch(
        "UPDATE mcp_connection_settings \
         SET service_id = 'data-security-risk-assessment-mcp' \
         WHERE service_id = 'data-risk-assessment-mcp';",
    );
    clear_legacy_builtin_connection_defaults(connection)?;
    retire_removed_builtin_mcp_connection_settings(connection)?;
    Ok(())
}

fn clear_legacy_builtin_connection_defaults(connection: &Connection) -> Result<(), String> {
    for (service_id, legacy_url) in [
        (ALERT_ANALYSIS_SERVICE_ID, "http://127.0.0.1:8765/mcp"),
        (DATA_CLASSIFICATION_SERVICE_ID, "http://127.0.0.1:8766/mcp"),
        (DATA_RISK_ASSESSMENT_SERVICE_ID, "http://127.0.0.1:8767/mcp"),
    ] {
        connection
            .execute(
                "UPDATE mcp_connection_settings \
                 SET http_url = '' \
                 WHERE service_id = ?1 AND enabled = 0 AND command_path = '' AND http_url = ?2",
                params![service_id, legacy_url],
            )
            .map_err(|error| format!("清理数字员工默认连接地址失败：{error}"))?;
    }
    Ok(())
}

fn retire_removed_builtin_mcp_connection_settings(connection: &Connection) -> Result<(), String> {
    for service_id in REMOVED_BUILTIN_MCP_SERVICE_IDS {
        connection
            .execute(
                "UPDATE mcp_connection_settings SET deleted = 1, enabled = 0 WHERE service_id = ?1",
                params![service_id],
            )
            .map_err(|error| format!("清理已移除的数字员工配置失败：{error}"))?;
    }
    Ok(())
}

fn load_mcp_connection_settings_from_db(
    connection: &Connection,
    service_id: &str,
) -> Result<McpConnectionSettings, String> {
    let service_id = normalize_service_id(service_id);
    let mut statement = connection
        .prepare(
            r#"
            SELECT service_id, employee_name, employee_role, welcome_title, welcome_message,
                   show_in_employee_list,
                   enabled, transport, command_path, command_args, http_url, launch_mode
              FROM mcp_connection_settings
             WHERE service_id = ?1 AND deleted = 0
            "#,
        )
        .map_err(|error| format!("读取 MCP 连接配置失败：{error}"))?;
    let loaded = statement.query_row(params![service_id], |row| {
        Ok(McpConnectionSettings {
            service_id: row.get(0)?,
            employee_name: row.get(1)?,
            employee_role: row.get(2)?,
            welcome_title: row.get(3)?,
            welcome_message: row.get(4)?,
            show_in_employee_list: row.get::<_, i64>(5)? != 0,
            enabled: row.get::<_, i64>(6)? != 0,
            transport: row.get(7)?,
            command_path: row.get(8)?,
            command_args: row.get(9)?,
            http_url: row.get(10)?,
            launch_mode: row.get(11)?,
        })
    });

    match loaded {
        Ok(settings) => Ok(normalize_mcp_connection_settings(settings)),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            let settings = default_mcp_connection_settings(&service_id);
            save_mcp_connection_settings_to_db(connection, &settings)?;
            Ok(settings)
        }
        Err(error) => Err(format!("读取 MCP 连接配置失败：{error}")),
    }
}

fn ensure_builtin_mcp_connection_settings(connection: &Connection) -> Result<(), String> {
    for service_id in BUILTIN_MCP_SERVICE_IDS {
        load_mcp_connection_settings_from_db(connection, service_id)?;
    }
    Ok(())
}

fn list_mcp_connection_settings_from_db(
    connection: &Connection,
) -> Result<Vec<McpConnectionSettings>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT service_id, employee_name, employee_role, welcome_title, welcome_message,
                   show_in_employee_list,
                   enabled, transport, command_path, command_args, http_url, launch_mode
              FROM mcp_connection_settings
             WHERE deleted = 0
             ORDER BY
                CASE service_id
                    WHEN 'data-security-risk-assessment-mcp' THEN 0
                    WHEN 'alert-analysis-mcp' THEN 1
                    WHEN 'data-classification-mcp' THEN 2
                    ELSE 3
                END,
                service_id COLLATE NOCASE
            "#,
        )
        .map_err(|error| format!("读取 MCP 配置列表失败：{error}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(McpConnectionSettings {
                service_id: row.get(0)?,
                employee_name: row.get(1)?,
                employee_role: row.get(2)?,
                welcome_title: row.get(3)?,
                welcome_message: row.get(4)?,
                show_in_employee_list: row.get::<_, i64>(5)? != 0,
                enabled: row.get::<_, i64>(6)? != 0,
                transport: row.get(7)?,
                command_path: row.get(8)?,
                command_args: row.get(9)?,
                http_url: row.get(10)?,
                launch_mode: row.get(11)?,
            })
        })
        .map_err(|error| format!("读取 MCP 配置列表失败：{error}"))?;

    let mut settings = Vec::new();
    for row in rows {
        settings.push(normalize_mcp_connection_settings(
            row.map_err(|error| format!("读取 MCP 配置列表失败：{error}"))?,
        ));
    }
    Ok(settings)
}

fn save_mcp_connection_settings_to_db(
    connection: &Connection,
    settings: &McpConnectionSettings,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            INSERT INTO mcp_connection_settings (
                service_id, employee_name, employee_role, welcome_title, welcome_message,
                show_in_employee_list,
                deleted, enabled, transport, command_path, command_args, http_url, launch_mode, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(service_id) DO UPDATE SET
                employee_name = excluded.employee_name,
                employee_role = excluded.employee_role,
                welcome_title = excluded.welcome_title,
                welcome_message = excluded.welcome_message,
                show_in_employee_list = excluded.show_in_employee_list,
                deleted = 0,
                enabled = excluded.enabled,
                transport = excluded.transport,
                command_path = excluded.command_path,
                command_args = excluded.command_args,
                http_url = excluded.http_url,
                launch_mode = excluded.launch_mode,
                updated_at = excluded.updated_at
            "#,
            params![
                settings.service_id,
                settings.employee_name,
                settings.employee_role,
                settings.welcome_title,
                settings.welcome_message,
                bool_to_i64(settings.show_in_employee_list),
                bool_to_i64(settings.enabled),
                settings.transport,
                settings.command_path,
                settings.command_args,
                settings.http_url,
                settings.launch_mode,
                now_text(),
            ],
        )
        .map(|_| ())
        .map_err(|error| format!("保存 MCP 连接配置失败：{error}"))
}

fn soft_delete_mcp_connection_settings_from_db(
    connection: &Connection,
    service_id: &str,
) -> Result<(), String> {
    let changed = connection
        .execute(
            r#"
            UPDATE mcp_connection_settings
               SET deleted = 1,
                   enabled = 0,
                   updated_at = ?2
             WHERE service_id = ?1
            "#,
            params![service_id, now_text()],
        )
        .map_err(|error| format!("删除数字员工失败：{error}"))?;
    if changed == 0 {
        return Err(format!("数字员工服务 {service_id} 不存在。"));
    }
    Ok(())
}

fn normalize_mcp_connection_settings(mut settings: McpConnectionSettings) -> McpConnectionSettings {
    settings.service_id = normalize_service_id(&settings.service_id);
    settings.employee_name = normalize_employee_name(&settings.employee_name, &settings.service_id);
    settings.employee_role = settings.employee_role.trim().to_string();
    if settings.employee_role.is_empty() {
        settings.employee_role = default_employee_role(&settings.service_id);
    }
    settings.welcome_title = settings.welcome_title.trim().to_string();
    if settings.welcome_title.is_empty() {
        settings.welcome_title = welcome_title_for(&settings.service_id, &settings.employee_name);
    }
    settings.welcome_message = settings.welcome_message.trim().to_string();
    if settings.welcome_message.is_empty() {
        settings.welcome_message =
            welcome_message_for(&settings.service_id, &settings.employee_role);
    }
    settings.transport = match settings.transport.trim().to_ascii_lowercase().as_str() {
        "http" | "streamable-http" => "http".to_string(),
        _ => "stdio".to_string(),
    };
    settings.launch_mode = match settings.launch_mode.trim().to_ascii_lowercase().as_str() {
        "module" => "module".to_string(),
        _ => "script".to_string(),
    };
    settings.command_path = settings.command_path.trim().to_string();
    settings.command_args = settings.command_args.trim().to_string();
    if settings.command_args.is_empty() {
        settings.command_args = "--transport stdio".to_string();
    }
    settings.http_url = normalize_http_url(&settings.http_url);
    settings
}

fn normalize_service_id(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        ALERT_ANALYSIS_SERVICE_ID.to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_employee_name(value: &str, service_id: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return default_employee_name(service_id);
    }
    if service_id == DATA_CLASSIFICATION_SERVICE_ID || trimmed.ends_with("数字员工") {
        trimmed.to_string()
    } else {
        format!("{trimmed}数字员工")
    }
}

fn default_employee_name(service_id: &str) -> String {
    match service_id {
        "data-security-risk-assessment-mcp" => "数安风评数字员工".to_string(),
        ALERT_ANALYSIS_SERVICE_ID => "威胁研判数字员工".to_string(),
        DATA_CLASSIFICATION_SERVICE_ID => "分类分级工具".to_string(),
        _ => format!(
            "{}数字员工",
            service_id.strip_suffix("-mcp").unwrap_or(service_id)
        ),
    }
}

fn default_employee_role(service_id: &str) -> String {
    match service_id {
        "data-security-risk-assessment-mcp" => "数据安全风险评估".to_string(),
        ALERT_ANALYSIS_SERVICE_ID => "安全告警威胁研判".to_string(),
        DATA_CLASSIFICATION_SERVICE_ID => "数据资产分类分级".to_string(),
        _ => "自定义 MCP 服务".to_string(),
    }
}

fn default_welcome_title(service_id: &str) -> String {
    welcome_title_for(service_id, &default_employee_name(service_id))
}

fn welcome_title_for(service_id: &str, employee_name: &str) -> String {
    match service_id {
        ALERT_ANALYSIS_SERVICE_ID => "欢迎使用告警分析".to_string(),
        DATA_CLASSIFICATION_SERVICE_ID => "欢迎使用数据分类分级".to_string(),
        _ => format!(
            "欢迎使用{}",
            employee_name.trim_end_matches("数字员工").trim()
        ),
    }
}

fn default_welcome_message(service_id: &str) -> String {
    welcome_message_for(service_id, &default_employee_role(service_id))
}

fn welcome_message_for(service_id: &str, employee_role: &str) -> String {
    match service_id {
        ALERT_ANALYSIS_SERVICE_ID => "我可以对安全告警进行研判，分析影响范围并生成处置建议。你可以直接描述告警情况，也可以粘贴告警原文，或上传告警截图、数据包。".to_string(),
        DATA_CLASSIFICATION_SERVICE_ID => {
            "我可以协助梳理数据资产，并依据分类分级规则生成结构化结果。".to_string()
        }
        _ => format!(
            "我可以协助开展{}相关工作。请描述任务目标，或上传需要处理的材料。",
            employee_role
        ),
    }
}

fn default_show_in_employee_list() -> bool {
    true
}

fn normalize_http_url(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    // Normalize scheme to lowercase for matching; store the original trimmed value.
    let lower = trimmed.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "http://127.0.0.1:8765"
            | "http://localhost:8765"
            | "http://127.0.0.1:8766"
            | "http://localhost:8766"
            | "http://127.0.0.1:8767"
            | "http://localhost:8767"
    ) {
        return format!("{lower}/mcp");
    }
    trimmed.to_string()
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
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
    fn mcp_settings_roundtrip() {
        let db_path = std::env::temp_dir().join(format!(
            "nova-mcp-settings-{}.sqlite3",
            Local::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let connection =
            app_database::open_database_at(&db_path, initialize_mcp_db).expect("db should open");
        let mut settings = default_mcp_connection_settings(ALERT_ANALYSIS_SERVICE_ID);
        settings.enabled = true;
        settings.command_path = r"D:\mcp\server.py".to_string();
        settings.http_url = "http://127.0.0.1:8765".to_string();

        save_mcp_connection_settings_to_db(&connection, &settings).expect("settings should save");
        let loaded = load_mcp_connection_settings_from_db(&connection, ALERT_ANALYSIS_SERVICE_ID)
            .expect("settings should load");

        assert!(loaded.enabled);
        assert_eq!(loaded.employee_name, "威胁研判数字员工");
        assert_eq!(loaded.employee_role, "安全告警威胁研判");
        assert_eq!(loaded.welcome_title, "欢迎使用告警分析");
        assert!(loaded
            .welcome_message
            .starts_with("我可以对安全告警进行研判"));
        assert!(loaded.show_in_employee_list);
        assert_eq!(loaded.command_path, r"D:\mcp\server.py");
        assert_eq!(loaded.http_url, "http://127.0.0.1:8765/mcp");

        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn data_classification_default_has_no_connection_location() {
        let settings = default_mcp_connection_settings(DATA_CLASSIFICATION_SERVICE_ID);

        assert_eq!(settings.service_id, DATA_CLASSIFICATION_SERVICE_ID);
        assert!(!settings.show_in_employee_list);
        assert!(settings.command_path.is_empty());
        assert!(settings.http_url.is_empty());
    }

    #[test]
    fn data_risk_assessment_default_has_no_connection_location() {
        let settings = default_mcp_connection_settings(DATA_RISK_ASSESSMENT_SERVICE_ID);
        assert!(settings.command_path.is_empty());
        assert!(settings.http_url.is_empty());
    }

    #[test]
    fn inactive_legacy_default_url_is_cleared_without_overwriting_enabled_connections() {
        let connection = Connection::open_in_memory().expect("open db");
        initialize_mcp_db(&connection).expect("initialize");

        let mut inactive = default_mcp_connection_settings(ALERT_ANALYSIS_SERVICE_ID);
        inactive.http_url = "http://127.0.0.1:8765/mcp".to_string();
        save_mcp_connection_settings_to_db(&connection, &inactive).expect("save inactive default");

        let mut enabled = default_mcp_connection_settings(DATA_CLASSIFICATION_SERVICE_ID);
        enabled.enabled = true;
        enabled.http_url = "http://127.0.0.1:8766/mcp".to_string();
        save_mcp_connection_settings_to_db(&connection, &enabled).expect("save enabled connection");

        initialize_mcp_db(&connection).expect("migrate defaults");

        let inactive = load_mcp_connection_settings_from_db(&connection, ALERT_ANALYSIS_SERVICE_ID)
            .expect("load inactive default");
        let enabled =
            load_mcp_connection_settings_from_db(&connection, DATA_CLASSIFICATION_SERVICE_ID)
                .expect("load enabled connection");
        assert!(inactive.http_url.is_empty());
        assert_eq!(enabled.http_url, "http://127.0.0.1:8766/mcp");
    }

    #[test]
    fn removed_builtin_mcp_services_are_retired() {
        let db_path = std::env::temp_dir().join(format!(
            "nova-mcp-settings-retired-{}.sqlite3",
            Local::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let connection =
            app_database::open_database_at(&db_path, initialize_mcp_db).expect("db should open");
        let removed_service_id = REMOVED_BUILTIN_MCP_SERVICE_IDS[0];
        let mut settings = default_mcp_connection_settings(removed_service_id);
        settings.enabled = true;
        settings.show_in_employee_list = true;
        save_mcp_connection_settings_to_db(&connection, &settings)
            .expect("removed service should save before migration");

        initialize_mcp_db(&connection).expect("cleanup migration should run");
        let listed =
            list_mcp_connection_settings_from_db(&connection).expect("settings list should load");
        assert!(!listed
            .iter()
            .any(|settings| settings.service_id == removed_service_id));

        let flags: (i64, i64) = connection
            .query_row(
                "SELECT deleted, enabled FROM mcp_connection_settings WHERE service_id = ?1",
                params![removed_service_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("retired service row should remain recoverable");
        assert_eq!(flags, (1, 0));

        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn mcp_settings_list_includes_builtins_and_custom_services() {
        let db_path = std::env::temp_dir().join(format!(
            "nova-mcp-settings-list-{}.sqlite3",
            Local::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let connection =
            app_database::open_database_at(&db_path, initialize_mcp_db).expect("db should open");
        let custom_settings = McpConnectionSettings {
            service_id: "custom-threat-mcp".to_string(),
            employee_name: "自定义研判数字员工".to_string(),
            employee_role: "自定义威胁分析".to_string(),
            welcome_title: "欢迎使用自定义研判".to_string(),
            welcome_message: "请提交需要研判的材料。".to_string(),
            show_in_employee_list: true,
            enabled: true,
            transport: "http".to_string(),
            command_path: String::new(),
            command_args: "--transport stdio".to_string(),
            http_url: "http://127.0.0.1:8899".to_string(),
            launch_mode: "script".to_string(),
        };
        save_mcp_connection_settings_to_db(&connection, &custom_settings)
            .expect("custom settings should save");

        ensure_builtin_mcp_connection_settings(&connection).expect("builtins should exist");
        let settings =
            list_mcp_connection_settings_from_db(&connection).expect("settings list should load");
        let ids: Vec<_> = settings
            .iter()
            .map(|settings| settings.service_id.as_str())
            .collect();

        assert!(ids.starts_with(BUILTIN_MCP_SERVICE_IDS));
        assert!(ids.contains(&"custom-threat-mcp"));
        let custom = settings
            .iter()
            .find(|settings| settings.service_id == "custom-threat-mcp")
            .expect("custom settings should be listed");
        assert_eq!(custom.employee_name, "自定义研判数字员工");
        assert_eq!(custom.employee_role, "自定义威胁分析");
        assert_eq!(custom.welcome_title, "欢迎使用自定义研判");
        assert_eq!(custom.welcome_message, "请提交需要研判的材料。");
        assert!(custom.show_in_employee_list);

        soft_delete_mcp_connection_settings_from_db(&connection, "custom-threat-mcp")
            .expect("custom settings should be deleted");
        let settings =
            list_mcp_connection_settings_from_db(&connection).expect("settings list should reload");
        assert!(!settings
            .iter()
            .any(|settings| settings.service_id == "custom-threat-mcp"));

        let _ = fs::remove_file(db_path);
    }
}
