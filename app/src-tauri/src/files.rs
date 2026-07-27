//! 文件操作命令：打开、定位、另存、临时文件、PCAP/OCR 解析（经 sidecar）。
//!
//! 与原 Nova 的差异：PCAP/OCR 解析不再走 Rust 内置的 alert_analysis_mcp shim，
//! 而是通过 send_rpc 把解析请求转发给 Node sidecar（pi 内核），由 host 的 MCP 客户端
//! 调用 alert-analysis-mcp 服务的 parse_pcap_file / extract_alert_image 工具。

use std::path::{Path, PathBuf};

use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::mcp_settings::load_mcp_connection_settings;
use crate::rpc::send_rpc_blocking_with_timeout;

const MAX_UPLOADED_PCAP_BYTES: usize = 25 * 1024 * 1024;
const MAX_UPLOADED_ALERT_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_UPLOADED_RISK_ZIP_BYTES: usize = 200 * 1024 * 1024;
const MAX_UPLOADED_DOC_BYTES: usize = 25 * 1024 * 1024;
const ALLOWED_RISK_ZIP_EXTENSIONS: &[&str] = &["zip"];
const ALLOWED_PCAP_EXTENSIONS: &[&str] = &["pcap", "pcapng", "cap"];
const ALLOWED_ALERT_IMAGE_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "bmp", "webp", "tif", "tiff"];
const ALLOWED_TEXT_EXPORT_EXTENSIONS: &[&str] = &["md", "txt", "csv", "json", "log", "html"];
/// write_uploaded_blob 接受的普通文档/文本扩展名（与前端 PromptComposer accept 对齐）。
/// 这些文件走通用附件通道：存临时文件 → 作为 attachment → host 读取内容注入。
const ALLOWED_UPLOADED_DOC_EXTENSIONS: &[&str] =
    &["txt", "log", "md", "csv", "tsv", "json", "xml", "yaml", "yml"];

const ALERT_ANALYSIS_MCP_SERVICE: &str = "alert-analysis-mcp";

/// 使用系统默认程序打开文件（跨平台）
#[tauri::command]
pub fn open_file_path(app: AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.starts_with(r"\\") || trimmed.starts_with(r"\\?\") {
        return Err("不允许打开网络路径。".to_string());
    }
    let requested = Path::new(trimmed);
    if !requested.exists() {
        return Err(format!("文件不存在：{}", requested.display()));
    }
    let canonical = requested
        .canonicalize()
        .map_err(|e| format!("无法解析文件路径：{e}"))?;
    let allowed_roots = allowed_open_roots(&app);
    let is_allowed = allowed_roots.iter().any(|root| canonical.starts_with(root));
    if !is_allowed {
        return Err("只能打开本应用生成的导出文件。".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("无法打开文件：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("无法打开文件：{e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("无法打开文件：{e}"))?;
    }
    Ok(())
}

/// 在系统文件管理器中定位文件（仅允许应用临时目录和导出目录中的文件）
#[tauri::command]
pub fn show_file_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.starts_with(r"\\") || trimmed.starts_with(r"\\?\") {
        return Err("不允许定位网络路径。".to_string());
    }
    let requested = Path::new(trimmed);
    let file_exists = requested.is_file();
    let target = if file_exists {
        requested.to_path_buf()
    } else {
        requested
            .parent()
            .filter(|parent| parent.is_dir())
            .map(Path::to_path_buf)
            .ok_or_else(|| "文件已被清理，原目录也不存在。".to_string())?
    };
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("无法解析文件所在目录：{e}"))?;
    let allowed_roots = allowed_open_roots(&app);
    let is_allowed = allowed_roots.iter().any(|root| canonical.starts_with(root));
    if !is_allowed {
        return Err("只能定位本应用处理或生成的文件。".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("explorer");
        if file_exists {
            command.arg("/select,");
        }
        command
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("无法打开文件所在目录：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if file_exists {
            command.arg("-R");
        }
        command
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("无法打开文件所在目录：{e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let directory = if file_exists {
            canonical
                .parent()
                .ok_or_else(|| "无法获取文件所在目录。".to_string())?
        } else {
            canonical.as_path()
        };
        std::process::Command::new("xdg-open")
            .arg(directory)
            .spawn()
            .map_err(|e| format!("无法打开文件所在目录：{e}"))?;
    }
    Ok(())
}

/// Directories whose files `open_file_path` is allowed to launch.
///
/// 安全：不把整个系统 temp 目录列为可信根（否则任何能写 /tmp 的进程都能让本应用
/// 帮它打开恶意 .app/.exe/.desktop）。仅信任本应用专属临时子目录，以及
/// app_data_dir/uploads、app_data_dir/exports。
fn allowed_open_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let temp = std::env::temp_dir();
    // 保留旧临时目录作为历史兼容；新的上传文件写入 app_data_dir/uploads。
    for sub in ["nova-uploads", "nova-exports"] {
        let dir = temp.join(sub);
        if let Ok(canonical) = dir.canonicalize() {
            roots.push(canonical);
        } else {
            roots.push(dir);
        }
    }
    if let Ok(data_dir) = app.path().app_data_dir() {
        // Uploaded source files are persisted under app data because message
        // attachments remain actionable after parsing and across restarts.
        for sub in ["uploads", "exports"] {
            let dir = data_dir.join(sub);
            if let Ok(canonical) = dir.canonicalize() {
                roots.push(canonical);
            } else {
                roots.push(dir);
            }
        }
    }
    roots
}

/// 弹出保存对话框，将源文件另存为用户指定位置
#[tauri::command]
pub async fn save_file_as(app: AppHandle, source_path: String) -> Result<String, String> {
    // rfd::FileDialog 在 macOS 上必须在主线程调度，文件拷贝也是阻塞 IO。
    // 用 spawn_blocking 移出 Tauri 同步命令线程，避免对话框延迟/UI 卡死。
    let app_for_blocking = app.clone();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let trimmed = source_path.trim();
        if trimmed.starts_with(r"\\") || trimmed.starts_with(r"\\?\") {
            return Err("不允许保存网络路径的文件。".to_string());
        }
        let source = Path::new(trimmed);
        if !source.exists() {
            return Err(format!("文件不存在：{}", source.display()));
        }
        let canonical = source
            .canonicalize()
            .map_err(|e| format!("无法解析文件路径：{e}"))?;
        let allowed_roots = allowed_open_roots(&app_for_blocking);
        let is_allowed = allowed_roots.iter().any(|root| canonical.starts_with(root));
        if !is_allowed {
            return Err("只能另存本应用生成的导出文件。".to_string());
        }
        let file_name = canonical
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("result.xlsx");
        let ext = canonical
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("xlsx")
            .to_ascii_lowercase();
        let (filter_label, filter_ext): (&str, &str) = match ext.as_str() {
            "md" => ("Markdown 文件", "md"),
            "txt" => ("文本文件", "txt"),
            "xlsx" => ("Excel 文件", "xlsx"),
            "docx" => ("Word 文件", "docx"),
            "pdf" => ("PDF 文件", "pdf"),
            "zip" => ("压缩包", "zip"),
            _ => ("所有文件", "*"),
        };
        let dest = rfd::FileDialog::new()
            .set_title("另存为")
            .set_file_name(file_name)
            .add_filter(filter_label, &[filter_ext])
            .add_filter("所有文件", &["*"])
            .save_file()
            .ok_or_else(|| "已取消".to_string())?;
        std::fs::copy(&canonical, &dest).map_err(|e| format!("保存失败：{e}"))?;
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("另存任务失败：{e}"))?
}

/// 将文本内容写入临时文件，返回文件路径（供 save_file_as 使用）
#[tauri::command]
pub fn write_temp_text_file(content: String, extension: String) -> Result<String, String> {
    let extension = sanitize_text_export_extension(&extension)?;
    // 写到 nova-exports 子目录而非 temp 根，配合 allowed_open_roots 收紧可信根
    // （整个 temp_dir 不再可信，只有本应用专属子目录可信）。
    let dir = std::env::temp_dir().join("nova-exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let file_name = format!("nova-export-{ts}.{extension}");
    let path = dir.join(&file_name);
    std::fs::write(&path, &content).map_err(|e| format!("写入临时文件失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn sanitize_text_export_extension(extension: &str) -> Result<&'static str, String> {
    let normalized = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    if normalized
        .chars()
        .any(|ch| ch == '/' || ch == '\\' || ch == '\0' || ch == '.')
    {
        return Err("不支持的文件扩展名。".to_string());
    }
    ALLOWED_TEXT_EXPORT_EXTENSIONS
        .iter()
        .copied()
        .find(|candidate| *candidate == normalized)
        .ok_or_else(|| "不支持的文件扩展名。".to_string())
}

pub fn upload_storage_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join("uploads");
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建上传文件目录失败：{error}"))?;
    Ok(dir)
}

fn sanitize_pcap_extension(extension: &str) -> Result<&'static str, String> {
    let normalized = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    ALLOWED_PCAP_EXTENSIONS
        .iter()
        .copied()
        .find(|candidate| *candidate == normalized)
        .ok_or_else(|| "仅支持 pcap、pcapng、cap 文件".to_string())
}

fn sanitize_alert_image_extension(extension: &str) -> Result<&'static str, String> {
    let normalized = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    ALLOWED_ALERT_IMAGE_EXTENSIONS
        .iter()
        .copied()
        .find(|candidate| *candidate == normalized)
        .ok_or_else(|| "仅支持 png、jpg、jpeg、bmp、webp、tif、tiff 告警截图".to_string())
}

fn sanitize_risk_zip_extension(extension: &str) -> Result<&'static str, String> {
    let normalized = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    ALLOWED_RISK_ZIP_EXTENSIONS
        .iter()
        .copied()
        .find(|candidate| *candidate == normalized)
        .ok_or_else(|| "仅支持 zip 压缩包".to_string())
}

fn sanitize_uploaded_doc_extension(extension: &str) -> Result<&'static str, String> {
    let normalized = extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    ALLOWED_UPLOADED_DOC_EXTENSIONS
        .iter()
        .copied()
        .find(|candidate| *candidate == normalized)
        .ok_or_else(|| "仅支持 txt/log/md/csv/tsv/json/xml/yaml/yml 文档".to_string())
}

fn sanitize_uploaded_blob_extension(extension: &str) -> Result<(&'static str, usize), String> {
    match sanitize_pcap_extension(extension) {
        Ok(extension) => Ok((extension, MAX_UPLOADED_PCAP_BYTES)),
        Err(_) => match sanitize_alert_image_extension(extension) {
            Ok(extension) => Ok((extension, MAX_UPLOADED_ALERT_IMAGE_BYTES)),
            Err(_) => match sanitize_uploaded_doc_extension(extension) {
                Ok(extension) => Ok((extension, MAX_UPLOADED_DOC_BYTES)),
                Err(_) => sanitize_risk_zip_extension(extension)
                    .map(|extension| (extension, MAX_UPLOADED_RISK_ZIP_BYTES)),
            },
        },
    }
}

fn sanitize_uploaded_file_name(file_name: Option<&str>, extension: &str) -> String {
    let raw_name = file_name
        .unwrap_or_default()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default();
    let raw_stem = raw_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(raw_name);
    let stem: String = raw_stem
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                character
            }
        })
        .take(120)
        .collect();
    let stem = stem.trim_matches(|character: char| character == '.' || character.is_whitespace());
    let stem = if stem.is_empty() { "upload" } else { stem };
    format!("{stem}.{extension}")
}

fn validate_uploaded_pcap_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    let upload_dir = upload_storage_dir(app)?;
    let upload_dir = upload_dir
        .canonicalize()
        .map_err(|e| format!("读取上传文件目录失败：{e}"))?;
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("读取上传文件失败：{e}"))?;
    if !canonical.starts_with(&upload_dir) {
        return Err("只能解析本应用接收的 PCAP 文件".to_string());
    }
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    sanitize_pcap_extension(extension)?;
    Ok(canonical)
}

fn validate_uploaded_alert_image_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    let upload_dir = upload_storage_dir(app)?;
    let upload_dir = upload_dir
        .canonicalize()
        .map_err(|e| format!("读取上传文件目录失败：{e}"))?;
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("读取上传图片失败：{e}"))?;
    if !canonical.starts_with(&upload_dir) {
        return Err("只能识别本应用接收的告警截图".to_string());
    }
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    sanitize_alert_image_extension(extension)?;
    Ok(canonical)
}

/// 将 base64 编码的文件数据写入应用持久化上传目录，返回文件路径。
#[tauri::command]
pub fn write_uploaded_blob(
    app: AppHandle,
    base64_data: String,
    extension: String,
    file_name: Option<String>,
) -> Result<String, String> {
    use base64::Engine as _;
    let (extension, max_bytes) = sanitize_uploaded_blob_extension(&extension)?;
    if base64_data.len() > max_bytes * 2 {
        return Err(format!(
            "上传文件过大，当前限制为 {} MB",
            max_bytes / 1024 / 1024
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("base64 解码失败：{e}"))?;
    if bytes.len() > max_bytes {
        return Err(format!(
            "上传文件过大，当前限制为 {} MB",
            max_bytes / 1024 / 1024
        ));
    }
    let upload_root = upload_storage_dir(&app)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dir = upload_root.join(format!("upload-{ts}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建上传批次目录失败：{e}"))?;
    let file_name = sanitize_uploaded_file_name(file_name.as_deref(), extension);
    let path = dir.join(&file_name);
    std::fs::write(&path, &bytes).map_err(|e| format!("写入临时文件失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 解析 PCAP/PCAPNG 文件：经 sidecar 调用 alert-analysis-mcp 的 parse_pcap_file 工具。
#[tauri::command]
pub async fn parse_pcap_file_cmd(app: AppHandle, path: String) -> Result<String, String> {
    let canonical = validate_uploaded_pcap_path(&app, &path)?;
    let normalized = strip_extended_path_prefix(canonical.to_string_lossy().as_ref());
    let result =
        call_alert_mcp_tool(&app, "parse_pcap_file", &json!({ "path": normalized }), 600).await;
    result.and_then(|value| extract_text_result(value, "PCAP 解析"))
}

/// 识别告警截图：经 sidecar 调用 alert-analysis-mcp 的 extract_alert_image 工具。
#[tauri::command]
pub async fn extract_alert_image_text_cmd(app: AppHandle, path: String) -> Result<String, String> {
    let canonical = validate_uploaded_alert_image_path(&app, &path)?;
    let normalized = strip_extended_path_prefix(canonical.to_string_lossy().as_ref());
    let result = call_alert_mcp_tool(
        &app,
        "extract_alert_image",
        &json!({ "path": normalized }),
        600,
    )
    .await;
    result.and_then(|value| extract_text_result(value, "告警截图识别"))
}

/// 通过 sidecar 调用一个 alert-analysis MCP 工具（host 内的 MCP 客户端转发）。
async fn call_alert_mcp_tool(
    app: &AppHandle,
    tool_name: &str,
    args: &serde_json::Value,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    // 确保 sidecar 已收到带 env（含 NOVA_PI_UPLOADS_DIR）的最新 MCP 配置。
    // 配置未变时 host 的 configEquals 走快速路径不重连，开销仅一次 RPC 往返；
    // 配置变化（如首次解析、刚启用服务）时 host 自动重连 Python 子进程以使新 env 生效。
    crate::sync_mcp_config_to_sidecar(app).await?;
    let settings = load_mcp_connection_settings(app, ALERT_ANALYSIS_MCP_SERVICE)?;
    if !settings.enabled {
        return Err("威胁研判 MCP 服务尚未启用。请在数字员工管理中配置并启用。".to_string());
    }
    let command = json!({
        "type": "mcp_call",
        "serviceId": ALERT_ANALYSIS_MCP_SERVICE,
        "toolName": tool_name,
        "args": args,
        "timeoutSecs": timeout_secs,
    });
    // Rust 侧超时 = sidecar 任务超时 + 30s 缓冲，避免 Rust 先超时导致 sidecar 响应被丢弃。
    let rpc_timeout = std::time::Duration::from_secs(timeout_secs.saturating_add(30));
    let response = send_rpc_blocking_with_timeout(app, command, rpc_timeout).await?;
    // response 是 host 返回的 MCP callTool 原始结果（可能含 content/structuredContent）
    Ok(response)
}

fn strip_extended_path_prefix(path: &str) -> String {
    path.trim_start_matches(r"\\?\").to_string()
}

fn extract_text_result(value: serde_json::Value, operation: &str) -> Result<String, String> {
    // 兼容 MCP 的 text-content 数组和 structuredContent.text 两种形态。
    // 注意：MCP 协议的「软错误」会把工具内部抛出的异常（如路径越界）包装成
    // { content:[{type:"text", text:"<错误信息>"}], isError:true } 返回。
    // 若不检查 isError，会把 Python 的报错文本当成成功结果回传给前端，
    // 导致「路径越界」之类错误被伪装成 PCAP 解析成功。这里显式检查并转 Err。
    let is_error = value.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
    let collected = collect_mcp_text(&value);
    if is_error {
        return Err(match collected {
            Some(text) if !text.trim().is_empty() => text,
            _ => format!("威胁研判 MCP 执行{operation}失败。"),
        });
    }
    if let Some(text) = collected {
        return Ok(text);
    }
    Err(format!("威胁研判 MCP 返回的{operation}结果中没有文本内容。"))
}

/// 从 MCP callTool 响应中提取首个文本块（兼容 text / content[] / structuredContent）。
fn collect_mcp_text(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
        return Some(text.to_string());
    }
    if let Some(content) = value.get("content").and_then(|v| v.as_array()) {
        for block in content {
            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    return Some(text.to_string());
                }
            }
        }
    }
    if let Some(text) = value
        .get("structuredContent")
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())
    {
        return Some(text.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{collect_mcp_text, extract_text_result, sanitize_uploaded_file_name};
    use serde_json::json;

    #[test]
    fn uploaded_file_name_preserves_user_visible_name() {
        assert_eq!(
            sanitize_uploaded_file_name(Some("test5.pcap"), "pcap"),
            "test5.pcap"
        );
        assert_eq!(
            sanitize_uploaded_file_name(Some("告警截图.png"), "png"),
            "告警截图.png"
        );
    }

    #[test]
    fn uploaded_file_name_removes_path_and_unsafe_characters() {
        assert_eq!(
            sanitize_uploaded_file_name(Some("..\\evil:name.exe"), "pcap"),
            "evil_name.pcap"
        );
        assert_eq!(sanitize_uploaded_file_name(None, "zip"), "upload.zip");
    }

    #[test]
    fn extract_text_result_unwraps_text_content_block() {
        let value = json!({
            "content": [{ "type": "text", "text": "包统计：10 条" }]
        });
        assert_eq!(
            extract_text_result(value, "PCAP 解析").unwrap(),
            "包统计：10 条"
        );
    }

    #[test]
    fn extract_text_result_treats_soft_error_as_err() {
        // Python safe_resolve 抛 ValueError 时，FastMCP 包成 isError:true 的软错误。
        // 必须转成 Err，否则前端会把「路径越界」当成解析成功的正文显示。
        let value = json!({
            "content": [{ "type": "text", "text": "路径越界，只能访问允许目录内的文件" }],
            "isError": true,
        });
        let result = extract_text_result(value, "PCAP 解析");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("路径越界"));
    }

    #[test]
    fn extract_text_result_soft_error_without_text_uses_fallback_message() {
        let value = json!({ "isError": true });
        let result = extract_text_result(value, "告警截图识别");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("告警截图识别"));
    }

    #[test]
    fn collect_mcp_text_reads_structured_content() {
        let value = json!({ "structuredContent": { "text": "hello" } });
        assert_eq!(collect_mcp_text(&value).as_deref(), Some("hello"));
    }
}
