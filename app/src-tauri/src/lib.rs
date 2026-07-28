//! Nova-PI Rust 薄壳：Tauri 命令注册 + Node sidecar 管理。
//!
//! 与原 Nova 的差异：LLM/MCP 逻辑全部上移到 Node sidecar（pi 内核），Rust 只负责：
//! - 窗口、文件对话框、路径守卫、临时文件
//! - sidecar 进程管理 + RPC 编排
//! - SQLite 会话索引（list/load/save/archive/...）
//! - ModelSettings CRUD + token 统计
//! - 风评大文件 HTTP 上传/下载
//! - 技能 zip 安装/脚本执行（gongwen_format.py）

mod app_database;
mod computer_agent_settings;
mod conversation_store;
mod files;
mod llm_settings;
mod mcp_settings;
mod message_channels;
mod risk_http;
mod rpc;
mod secrets;
mod sidecar;
mod skill_registry;

use computer_agent_settings::{
    get_computer_agent_settings, pick_computer_agent_working_directory,
    save_computer_agent_settings,
};
use conversation_store::{
    archive_conversation, delete_conversation, generate_conversation_title,
    list_archived_conversations, list_conversations, load_conversation, rename_conversation,
    restore_conversation, save_conversation_snapshot,
};
use files::{
    extract_alert_image_text_cmd, open_file_path, parse_pcap_file_cmd, save_file_as,
    show_file_in_folder, write_temp_text_file, write_uploaded_blob,
};
use llm_settings::{
    get_model_settings, list_token_usage, reset_model_settings, save_model_settings,
    test_model_connection,
};
use mcp_settings::{
    delete_mcp_connection_settings, list_mcp_connection_settings, load_mcp_connection_settings,
    save_mcp_connection_settings,
};
use message_channels::{
    delete_message_channel, get_message_channel, list_message_channel_records,
    list_message_channels, save_message_channel,
};
use risk_http::{download_risk_assessment_result, upload_risk_assessment_material};
use rpc::send_rpc;
use serde_json::json;
use skill_registry::{
    delete_user_skill, execute_skill_plan, get_skill, list_skill_catalog, list_skills,
    open_user_skill_dir, pick_and_install_skill, set_skill_enabled,
};
use tauri::Manager;

/// MCP 连接测试：经 sidecar 的 MCP 客户端做 initialize + tools/list 握手。
#[tauri::command]
async fn test_mcp_connection(app: tauri::AppHandle, service_id: String) -> Result<(), String> {
    let service_id = service_id.trim();
    if service_id.is_empty() {
        return Err("MCP 服务 ID 不能为空。".to_string());
    }
    let settings = load_mcp_connection_settings(&app, service_id)?;
    if !settings.enabled {
        return Err("MCP 服务尚未启用。".to_string());
    }
    // 把 sidecar 的 MCP 连接配置同步过去（确保 host 已连接该服务）
    sync_mcp_config_to_sidecar(&app).await?;
    let command = json!({ "type": "test_mcp", "serviceId": service_id });
    let response = rpc::send_rpc_blocking(&app, command).await?;
    if let Some(obj) = response.as_object() {
        if obj.get("toolCount").is_some() {
            return Ok(());
        }
    }
    Err("MCP 服务连接握手失败。".to_string())
}

/// 强制重连 MCP 服务：先断开 sidecar 缓存的旧连接（kill 旧子进程），再用当前配置重新 spawn。
/// 用于 Python 侧进程内配置（如 config.local.json）变化后，让用户手动重启子进程生效。
#[tauri::command]
async fn reconnect_mcp_connection(
    app: tauri::AppHandle,
    service_id: String,
) -> Result<serde_json::Value, String> {
    let service_id = service_id.trim();
    if service_id.is_empty() {
        return Err("MCP 服务 ID 不能为空。".to_string());
    }
    let settings = load_mcp_connection_settings(&app, service_id)?;
    if !settings.enabled {
        return Err("MCP 服务尚未启用。".to_string());
    }
    // 先同步配置（确保 host 侧有该 serviceId 的 McpServerConfig），再发 reconnect。
    sync_mcp_config_to_sidecar(&app).await?;
    let command = json!({ "type": "reconnect_mcp", "serviceId": service_id });
    let response = rpc::send_rpc_blocking(&app, command).await?;
    if let Some(obj) = response.as_object() {
        if obj.get("toolCount").is_some() {
            return Ok(response);
        }
    }
    Err("MCP 服务重连失败，请检查服务配置与日志。".to_string())
}

/// 列出 MCP 服务声明的工具（调试用）。
#[tauri::command]
async fn list_mcp_tools(
    app: tauri::AppHandle,
    service_id: String,
) -> Result<serde_json::Value, String> {
    let service_id = service_id.trim();
    sync_mcp_config_to_sidecar(&app).await?;
    let command = json!({ "type": "list_mcp_tools", "serviceId": service_id });
    rpc::send_rpc_blocking(&app, command).await
}

/// 把 Rust 存的 MCP 配置全量同步给 sidecar（configure_mcp 命令）。
/// 前端 McpSquarePanel 保存配置后、test/list 调用前都需要 sidecar 已加载最新配置。
pub(crate) async fn sync_mcp_config_to_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    let catalog = list_mcp_connection_settings(app.clone())?;
    // 把上传目录路径通过环境变量传给 MCP 子进程。alert-analysis-mcp 的 safe_resolve
    // 只允许读 $TMPDIR/nova-uploads，但 Rust 把上传文件写到 app_data_dir/uploads，
    // 这里打通两层路径白名单（详见 services/alert-analysis-mcp/server.py 的 _allowed_read_roots）。
    let upload_env = upload_dir_env_entry(app);
    let servers: Vec<serde_json::Value> = catalog
        .settings
        .iter()
        .map(|s| {
            json!({
                "serviceId": s.service_id,
                "transport": s.transport,
                "commandPath": s.command_path,
                "commandArgs": s.command_args,
                "url": s.http_url,
                "enabled": s.enabled,
                "launchMode": s.launch_mode,
                "env": upload_env,
            })
        })
        .collect();
    let command = json!({ "type": "configure_mcp", "servers": servers });
    let _ = rpc::send_rpc_blocking(app, command).await?;
    Ok(())
}

/// 构造注入给 MCP 子进程的环境变量条目（当前只有上传目录）。
///
/// 返回 `serde_json::Map` 以便直接嵌入 `env` 字段；若 app_data_dir 不可解析则返回空 Map，
/// 令服务回退到原有的 $TMPDIR/nova-uploads 行为，避免误判。
fn upload_dir_env_entry(app: &tauri::AppHandle) -> serde_json::Map<String, serde_json::Value> {
    let mut env = serde_json::Map::new();
    if let Ok(data_dir) = app.path().app_data_dir() {
        let uploads = data_dir.join("uploads");
        if let Some(path) = uploads.to_str() {
            env.insert(
                "NOVA_PI_UPLOADS_DIR".to_string(),
                serde_json::Value::String(path.to_string()),
            );
        }
    }
    env
}

/// 启动 sidecar（应用启动时调用一次）。
#[tauri::command]
fn start_sidecar(app: tauri::AppHandle) -> Result<(), String> {
    sidecar::start_sidecar(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    rpc::init();
    tauri::Builder::default()
        .setup(|app| {
            // 应用启动时拉起 Node sidecar
            if let Err(error) = sidecar::start_sidecar(app.handle()) {
                eprintln!("[lib] 启动 sidecar 失败：{error}");
            }
            Ok(())
        })
        .on_window_event(|_window, event| {
            // 窗口关闭时停止 sidecar
            if let tauri::WindowEvent::Destroyed = event {
                sidecar::stop_sidecar();
            }
        })
        .invoke_handler(tauri::generate_handler![
            // sidecar / rpc
            start_sidecar,
            send_rpc,
            test_mcp_connection,
            reconnect_mcp_connection,
            list_mcp_tools,
            // 内置电脑智能员工设置
            get_computer_agent_settings,
            save_computer_agent_settings,
            pick_computer_agent_working_directory,
            // 文件
            open_file_path,
            show_file_in_folder,
            save_file_as,
            write_temp_text_file,
            write_uploaded_blob,
            parse_pcap_file_cmd,
            extract_alert_image_text_cmd,
            // MCP 配置
            list_mcp_connection_settings,
            save_mcp_connection_settings,
            delete_mcp_connection_settings,
            // 消息通道（微信/飞书/...）
            list_message_channels,
            get_message_channel,
            save_message_channel,
            delete_message_channel,
            list_message_channel_records,
            // 会话
            list_conversations,
            load_conversation,
            save_conversation_snapshot,
            archive_conversation,
            delete_conversation,
            rename_conversation,
            generate_conversation_title,
            list_archived_conversations,
            restore_conversation,
            // 模型设置 + token
            get_model_settings,
            save_model_settings,
            reset_model_settings,
            test_model_connection,
            list_token_usage,
            // 技能
            list_skills,
            list_skill_catalog,
            get_skill,
            set_skill_enabled,
            open_user_skill_dir,
            pick_and_install_skill,
            delete_user_skill,
            execute_skill_plan,
            // 风评大文件
            upload_risk_assessment_material,
            download_risk_assessment_result
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
