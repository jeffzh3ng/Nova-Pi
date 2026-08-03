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
mod app_preferences;
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

use app_preferences::{get_app_preferences, save_app_preferences};
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
    open_file_path, pick_and_store_attachments, read_image_preview, save_file_as,
    show_file_in_folder, write_temp_text_file, write_uploaded_blob,
};
use llm_settings::{
    get_model_settings, list_token_usage, reset_model_settings, save_model_settings,
    test_model_connection,
};
use mcp_settings::{
    delete_mcp_connection_settings as delete_mcp_connection_settings_persisted,
    list_mcp_connection_settings, load_mcp_connection_settings,
    save_mcp_connection_settings as save_mcp_connection_settings_persisted, McpConnectionSettings,
    McpConnectionSettingsStatus,
};
use message_channels::{
    delete_message_channel, get_message_channel, list_message_channel_records,
    list_message_channels, save_message_channel,
};
use risk_http::{download_risk_assessment_matrix_template, download_risk_assessment_result};
use rpc::{get_sidecar_health, send_rpc};
use serde_json::json;
use skill_registry::{
    delete_user_skill, execute_skill_plan, get_skill, list_skill_catalog, list_skills,
    open_user_skill_dir, pick_and_install_skill, set_skill_enabled,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent};

static EXITING: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
const MACOS_TRAY_ICON: tauri::image::Image<'static> = tauri::include_image!("icons/tray-icon.png");

/// 主窗口导航白名单：只放行应用自身页面与内部协议。
///
/// 未拦截时，点击对话里的外部链接会把整个 webview 顶层导航到第三方站点，
/// 主界面被外部网页整体替换且没有返回/关闭的浏览器操作。Tauri 的
/// `on_navigation` 是 builder-only API，因此主窗口必须用
/// `WebviewWindowBuilder` 创建（见 `setup`），不能放在 tauri.conf.json 里。
fn is_app_navigation(url: &tauri::Url) -> bool {
    match url.scheme() {
        // 生产环境页面 tauri://localhost、IPC ipc://、打包资源 asset://
        "tauri" | "ipc" | "asset" => true,
        // 开发环境 vite http://127.0.0.1:1420、Windows 生产环境 http://tauri.localhost
        "http" | "https" => matches!(
            url.host_str(),
            Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost")
        ),
        _ => false,
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 Nova", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", "重新加载", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Nova", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &reload, &quit])?;
    let mut tray = TrayIconBuilder::with_id("nova-tray")
        .tooltip("Nova AI")
        .menu(&menu)
        .show_menu_on_left_click(false);

    #[cfg(target_os = "macos")]
    {
        tray = tray.icon(MACOS_TRAY_ICON).icon_as_template(true);
    }

    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

/// Persist and immediately publish MCP changes to the sidecar registry. This
/// makes an already-open Nova session see newly enabled services on its next
/// discovery call instead of waiting for a connection test or app restart.
#[tauri::command]
async fn save_mcp_connection_settings(
    app: tauri::AppHandle,
    settings: McpConnectionSettings,
) -> Result<McpConnectionSettingsStatus, String> {
    let status = save_mcp_connection_settings_persisted(app.clone(), settings)?;
    if let Err(error) = sync_mcp_config_to_sidecar(&app).await {
        // The persisted settings remain authoritative and startup/reconnect
        // will retry synchronization if the sidecar is temporarily offline.
        eprintln!("[mcp] 配置已保存，但暂时无法同步到 sidecar：{error}");
    }
    Ok(status)
}

/// Remove the service from both persistent settings and the live registry so
/// Nova cannot continue using a deleted MCP through an existing session.
#[tauri::command]
async fn delete_mcp_connection_settings(
    app: tauri::AppHandle,
    service_id: String,
) -> Result<(), String> {
    delete_mcp_connection_settings_persisted(app.clone(), service_id)?;
    if let Err(error) = sync_mcp_config_to_sidecar(&app).await {
        eprintln!("[mcp] 配置已删除，但暂时无法同步到 sidecar：{error}");
    }
    Ok(())
}

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
/// 保存/删除配置后会立即调用；test/list 之前也会兜底刷新。
pub(crate) async fn sync_mcp_config_to_sidecar(app: &tauri::AppHandle) -> Result<(), String> {
    let catalog = list_mcp_connection_settings(app.clone())?;
    // 把上传目录路径通过环境变量传给外部 MCP 子进程，供服务按需加入读取白名单。
    // Rust 将上传文件写到 app_data_dir/uploads；具体访问策略由外部服务自行实现。
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
                "httpHeaders": s.http_headers,
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

/// 用系统默认浏览器打开外部链接。
///
/// 只允许 http/https：链接文本来自 LLM/MCP 内容，放行其他协议（file://、
/// vscode:// 等）等于给任意协议调用开了一个口子。前端点击拦截后统一走这里。
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|error| format!("无效链接：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("仅支持 http/https 链接：{url}"));
    }
    opener::open(&url).map_err(|error| format!("打开链接失败：{error}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    rpc::init();
    let app = tauri::Builder::default()
        // 必须最先注册：第二次启动时只唤醒主窗口，不再创建新的 sidecar 或应用实例。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .setup(|app| {
            if let Err(error) = app_preferences::refresh_cache(app.handle()) {
                eprintln!("[lib] 读取应用偏好失败：{error}");
            }
            // 主窗口用 builder 创建（而非 tauri.conf.json），以挂载 on_navigation
            // 拦截外部导航；尺寸/标题与原配置文件保持一致。
            let main_window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Nova AI")
            .inner_size(1260.0, 725.0)
            .min_inner_size(1060.0, 680.0)
            .resizable(true)
            .center()
            .on_navigation(is_app_navigation)
            .build()?;
            // builder 创建的窗口在部分平台不会自动置前/聚焦，启动时主动拉起。
            let _ = main_window.show();
            let _ = main_window.set_focus();
            setup_tray(app)?;
            // 应用启动时拉起 Node sidecar
            if let Err(error) = sidecar::start_sidecar(app.handle()) {
                eprintln!("[lib] 启动 sidecar 失败：{error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if EXITING.load(Ordering::Relaxed) {
                    return;
                }
                api.prevent_close();
                if app_preferences::should_close_to_tray() {
                    let _ = window.hide();
                } else {
                    EXITING.store(true, Ordering::Relaxed);
                    sidecar::stop_sidecar();
                    window.app_handle().exit(0);
                }
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "reload" => {
                // 兜底恢复：正常情况下外部导航已被 on_navigation 拦截，
                // 若页面异常仍可从这里重新加载主界面。
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.location.reload()");
                }
            }
            "quit" => {
                EXITING.store(true, Ordering::Relaxed);
                sidecar::stop_sidecar();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|app, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(app);
            }
        })
        .invoke_handler(tauri::generate_handler![
            // sidecar / rpc
            start_sidecar,
            send_rpc,
            get_sidecar_health,
            get_app_preferences,
            save_app_preferences,
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
            pick_and_store_attachments,
            read_image_preview,
            // 外部链接（系统默认浏览器）
            open_external_url,
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
            download_risk_assessment_matrix_template,
            download_risk_assessment_result
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        if matches!(event, RunEvent::Exit) {
            EXITING.store(true, Ordering::Relaxed);
            sidecar::stop_sidecar();
        }
    });
}
