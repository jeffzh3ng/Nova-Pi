use std::{path::PathBuf, time::Duration};

use reqwest::Url;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

use crate::mcp_settings::load_mcp_connection_settings;

const MAX_RISK_RESULT_BYTES: u64 = 300 * 1024 * 1024;
const MAX_RISK_MATRIX_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedRiskResult {
    path: String,
    file_name: String,
}

#[tauri::command]
pub async fn download_risk_assessment_matrix_template(
    app: AppHandle,
    service_id: String,
    matrix_name: String,
    file_name: String,
) -> Result<DownloadedRiskResult, String> {
    let settings = load_http_settings(&app, service_id.trim())?;
    let matrix_name = matrix_name.trim();
    if matrix_name.is_empty()
        || matrix_name.len() > 300
        || matrix_name.chars().any(char::is_control)
    {
        return Err("评估矩阵名称无效。".to_string());
    }

    let requested_name = file_name.trim();
    let safe_file_name = if !requested_name.is_empty()
        && requested_name.chars().count() <= 120
        && !requested_name.contains('/')
        && !requested_name.contains('\\')
        && requested_name.to_ascii_lowercase().ends_with(".xlsx")
    {
        requested_name.to_string()
    } else {
        "数据安全风险评估矩阵.xlsx".to_string()
    };
    let exports_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取导出目录失败：{error}"))?
        .join("exports");
    tokio::fs::create_dir_all(&exports_dir)
        .await
        .map_err(|error| format!("创建导出目录失败：{error}"))?;
    let path = exports_dir.join(&safe_file_name);
    if path.is_file() {
        return Ok(DownloadedRiskResult {
            path: path.to_string_lossy().to_string(),
            file_name: safe_file_name,
        });
    }

    let mut endpoint = risk_api_url(&settings.http_url, "matrices/template")?;
    endpoint
        .query_pairs_mut()
        .append_pair("matrix_name", matrix_name);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2 * 60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("创建下载请求失败：{error}"))?;
    let mut response = client
        .get(endpoint)
        .send()
        .await
        .map_err(|error| format!("下载空白评估表失败：{error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response, "下载空白评估表").await);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RISK_MATRIX_BYTES)
    {
        return Err("空白评估表超过 50 MB 上限。".to_string());
    }

    let part_path = exports_dir.join(format!(".{safe_file_name}.part"));
    let mut output = tokio::fs::File::create(&part_path)
        .await
        .map_err(|error| format!("创建空白评估表失败：{error}"))?;
    let mut written = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取空白评估表失败：{error}"))?
    {
        written = written.saturating_add(chunk.len() as u64);
        if written > MAX_RISK_MATRIX_BYTES {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err("空白评估表超过 50 MB 上限。".to_string());
        }
        output
            .write_all(&chunk)
            .await
            .map_err(|error| format!("写入空白评估表失败：{error}"))?;
    }
    output
        .flush()
        .await
        .map_err(|error| format!("保存空白评估表失败：{error}"))?;
    drop(output);
    tokio::fs::rename(&part_path, &path)
        .await
        .map_err(|error| format!("保存空白评估表失败：{error}"))?;

    Ok(DownloadedRiskResult {
        path: path.to_string_lossy().to_string(),
        file_name: safe_file_name,
    })
}

fn load_http_settings(
    app: &AppHandle,
    service_id: &str,
) -> Result<crate::mcp_settings::McpConnectionSettings, String> {
    let settings = load_mcp_connection_settings(app, service_id)?;
    if !settings.enabled {
        return Err("数安风评服务尚未启用。".to_string());
    }
    if settings.transport != "http" {
        return Err("远程材料上传仅适用于 HTTP MCP 连接。".to_string());
    }
    if settings.http_url.trim().is_empty() {
        return Err("MCP HTTP 地址尚未配置。".to_string());
    }
    Ok(settings)
}

fn risk_api_url(mcp_url: &str, suffix: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(mcp_url.trim()).map_err(|error| format!("MCP HTTP 地址无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("MCP HTTP 地址必须使用 http 或 https。".to_string());
    }
    url.set_query(None);
    url.set_fragment(None);
    let current_path = url.path().trim_end_matches('/');
    // 先去掉可能的 /mcp 后缀（默认配置 https://x/mcp → /api）。
    let after_mcp = current_path.strip_suffix("/mcp").unwrap_or(current_path);
    // 若已经以 /api 结尾（如用户配 https://x/api/v1/mcp → /api/v1），不再追加 /api，避免 /api/api/...。
    let base_path: String = if after_mcp.ends_with("/api") || after_mcp == "api" {
        after_mcp.to_string()
    } else {
        // 末尾不剩 /api：补一个。常见情况 https://x/mcp → "" → "/api"。
        format!("{after_mcp}/api")
    };
    let suffix = suffix.trim_start_matches('/');
    url.set_path(&format!("{base_path}/{suffix}"));
    Ok(url)
}

async fn response_error(response: reqwest::Response, operation: &str) -> String {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|item| item.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| text.chars().take(500).collect());
    format!("{operation}失败（HTTP {status}）：{detail}")
}

#[tauri::command]
pub async fn download_risk_assessment_result(
    app: AppHandle,
    service_id: String,
    task_id: String,
    source_path: Option<String>,
) -> Result<DownloadedRiskResult, String> {
    let settings = load_mcp_connection_settings(&app, service_id.trim())?;
    if !settings.enabled {
        return Err("数安风评服务尚未启用。".to_string());
    }
    let task_id = task_id.trim();
    if task_id.is_empty()
        || !task_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err("评估任务 ID 无效。".to_string());
    }

    let exports_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取导出目录失败：{error}"))?
        .join("exports");
    tokio::fs::create_dir_all(&exports_dir)
        .await
        .map_err(|error| format!("创建导出目录失败：{error}"))?;
    let file_name = format!("数据安全风险评估结果-{task_id}.xlsx");
    let path = exports_dir.join(&file_name);

    if settings.transport != "http" {
        let source = PathBuf::from(
            source_path
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "本地 MCP 未返回评估结果路径。".to_string())?,
        );
        let canonical = source
            .canonicalize()
            .map_err(|error| format!("读取评估结果失败：{error}"))?;
        if canonical
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("xlsx"))
        {
            return Err("评估结果必须是 xlsx 文件。".to_string());
        }
        let configured = PathBuf::from(&settings.command_path);
        let project_root = if configured.is_file() {
            configured.parent().map(PathBuf::from).unwrap_or(configured)
        } else {
            configured
        };
        let allowed_root = project_root
            .canonicalize()
            .map_err(|error| format!("读取 MCP 项目目录失败：{error}"))?;
        if !canonical.starts_with(allowed_root) {
            return Err("评估结果不在已配置的 MCP 项目目录中。".to_string());
        }
        tokio::fs::copy(&canonical, &path)
            .await
            .map_err(|error| format!("复制评估结果失败：{error}"))?;
        return Ok(DownloadedRiskResult {
            path: path.to_string_lossy().to_string(),
            file_name,
        });
    }

    if settings.http_url.trim().is_empty() {
        return Err("MCP HTTP 地址尚未配置。".to_string());
    }
    if path.is_file() {
        return Ok(DownloadedRiskResult {
            path: path.to_string_lossy().to_string(),
            file_name,
        });
    }
    let endpoint = risk_api_url(&settings.http_url, &format!("tasks/{task_id}/result"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10 * 60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("创建下载请求失败：{error}"))?;
    let mut response = client
        .get(endpoint)
        .send()
        .await
        .map_err(|error| format!("下载评估结果失败：{error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response, "下载评估结果").await);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RISK_RESULT_BYTES)
    {
        return Err("评估结果超过 300 MB 上限。".to_string());
    }

    let part_path = exports_dir.join(format!(".{task_id}.part"));
    let mut output = tokio::fs::File::create(&part_path)
        .await
        .map_err(|error| format!("创建结果文件失败：{error}"))?;
    let mut written = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取评估结果失败：{error}"))?
    {
        written += chunk.len() as u64;
        if written > MAX_RISK_RESULT_BYTES {
            drop(output);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err("评估结果超过 300 MB 上限。".to_string());
        }
        output
            .write_all(&chunk)
            .await
            .map_err(|error| format!("写入评估结果失败：{error}"))?;
    }
    output
        .flush()
        .await
        .map_err(|error| format!("写入评估结果失败：{error}"))?;
    drop(output);
    tokio::fs::rename(&part_path, &path)
        .await
        .map_err(|error| format!("保存评估结果失败：{error}"))?;

    Ok(DownloadedRiskResult {
        path: path.to_string_lossy().to_string(),
        file_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_sibling_api_urls_from_mcp_endpoint() {
        assert_eq!(
            risk_api_url("https://example.com/mcp", "materials")
                .unwrap()
                .as_str(),
            "https://example.com/api/materials"
        );
        assert_eq!(
            risk_api_url("https://example.com/risk/mcp", "tasks/t1/result")
                .unwrap()
                .as_str(),
            "https://example.com/risk/api/tasks/t1/result"
        );
        // 已有 /api 前缀时不重复追加（避免 /api/v1/api/materials）。
        assert_eq!(
            risk_api_url("https://example.com/api/v1/mcp", "materials")
                .unwrap()
                .as_str(),
            "https://example.com/api/v1/api/materials"
        );
        assert_eq!(
            risk_api_url("https://example.com/api/mcp", "materials")
                .unwrap()
                .as_str(),
            "https://example.com/api/materials"
        );
    }
}
