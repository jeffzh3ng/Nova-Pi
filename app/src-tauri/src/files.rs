//! 文件操作命令：打开、定位、另存、临时文件、PCAP/OCR 解析（经 sidecar）。
//!
//! 与原 Nova 的差异：PCAP/OCR 解析不再走 Rust 内置的 alert_analysis_mcp shim，
//! 而是通过 send_rpc 把解析请求转发给 Node sidecar（pi 内核），由 host 的 MCP 客户端
//! 调用 alert-analysis-mcp 服务的 parse_pcap_file / extract_alert_image 工具。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

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
const ALLOWED_UPLOADED_DOC_EXTENSIONS: &[&str] = &[
    "txt", "log", "md", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "ini", "cfg", "conf",
    "sql", "har", "html", "htm", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "js", "jsx",
    "ts", "tsx", "py", "rs", "java", "go", "sh", "ps1",
];

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
        .ok_or_else(|| {
            "不支持该附件格式，请选择文档、表格、代码、图片、抓包或 zip 文件".to_string()
        })
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
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAttachment {
    name: String,
    path: String,
    ext: String,
    size: u64,
    kind: String,
}

/// 使用系统文件选择器直接把附件复制进应用上传目录，避免大文件先在 WebView 中转成 Base64。
#[tauri::command]
pub async fn pick_and_store_attachments(app: AppHandle) -> Result<Vec<StoredAttachment>, String> {
    tokio::task::spawn_blocking(move || {
        let sources = rfd::FileDialog::new()
            .set_title("选择要交给数字员工处理的附件")
            .add_filter(
                "支持的附件",
                &[
                    "txt", "log", "md", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "ini",
                    "cfg", "conf", "sql", "har", "html", "htm", "pdf", "doc", "docx", "xls",
                    "xlsx", "ppt", "pptx", "js", "jsx", "ts", "tsx", "py", "rs", "java", "go",
                    "sh", "ps1", "pcap", "pcapng", "cap", "png", "jpg", "jpeg", "bmp", "webp",
                    "tif", "tiff", "zip",
                ],
            )
            .pick_files()
            .unwrap_or_default();
        if sources.is_empty() {
            return Ok(Vec::new());
        }

        // Validate every source before creating a persistent batch. Otherwise
        // a later invalid/oversized file would leave earlier copies orphaned.
        let prepared = sources
            .into_iter()
            .map(|source| {
                let ext = source
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default();
                let (ext, max_bytes) = sanitize_uploaded_blob_extension(ext)?;
                let size = source
                    .metadata()
                    .map_err(|error| format!("读取附件大小失败：{error}"))?
                    .len();
                if size > max_bytes as u64 {
                    return Err(format!(
                        "附件 {} 过大，当前限制为 {} MB",
                        source.display(),
                        max_bytes / 1024 / 1024
                    ));
                }
                let original_name = source.file_name().and_then(|value| value.to_str());
                let safe_name = sanitize_uploaded_file_name(original_name, ext);
                Ok((source, ext, size, safe_name))
            })
            .collect::<Result<Vec<_>, String>>()?;

        let upload_root = upload_storage_dir(&app)?;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let batch = upload_root.join(format!("upload-{ts}"));
        std::fs::create_dir_all(&batch)
            .map_err(|error| format!("创建上传批次目录失败：{error}"))?;

        let result: Result<Vec<StoredAttachment>, String> = (|| {
            let mut stored = Vec::with_capacity(prepared.len());
            for (index, (source, ext, size, safe_name)) in prepared.into_iter().enumerate() {
                let destination = batch.join(format!("{index}-{safe_name}"));
                std::fs::copy(&source, &destination)
                    .map_err(|error| format!("保存附件 {} 失败：{error}", source.display()))?;
                stored.push(StoredAttachment {
                    name: safe_name,
                    path: destination.to_string_lossy().to_string(),
                    ext: ext.to_string(),
                    size,
                    kind: if ALLOWED_ALERT_IMAGE_EXTENSIONS.contains(&ext) {
                        "image".to_string()
                    } else {
                        "file".to_string()
                    },
                });
            }
            Ok(stored)
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&batch);
        }
        result
    })
    .await
    .map_err(|error| format!("选择附件失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::sanitize_uploaded_file_name;

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
}
