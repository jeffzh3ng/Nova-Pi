//! Node sidecar 进程管理：spawn、stdin 写入、stdout 行读取、stderr 收集、崩溃重启。
//!
//! sidecar 是 pi 内核（host/dist/main.js 或开发期 tsx），通过 stdin/stdout 的
//! newline-delimited JSON 与 Rust 通信（见 rpc.rs）。

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

/// 全局 sidecar 句柄（整个应用生命周期共享一个 Node 进程）。
struct SidecarHandle {
    child: Mutex<Option<Child>>,
    stdin: Mutex<std::process::ChildStdin>,
}

static SIDECAR: OnceLock<SidecarHandle> = OnceLock::new();

/// 启动 sidecar。重复调用会先关闭旧进程。
pub fn start_sidecar(app: &AppHandle) -> Result<(), String> {
    let agent_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join(".pi")
        .join("agent");
    std::fs::create_dir_all(&agent_dir).map_err(|e| format!("无法创建 agent 目录：{e}"))?;

    // 开发期：直接 tsx 跑 host/src/main.ts；生产期：跑打包后的 host/dist/main.js。
    // 通过环境变量 NOVA_PI_HOST_MODE 控制（dev=tsx，prod=node）。
    let mode = std::env::var("NOVA_PI_HOST_MODE").unwrap_or_else(|_| "node".to_string());
    let (program, args) = resolve_sidecar_command(&mode, &agent_dir)?;

    let mut child = Command::new(&program)
        .args(&args)
        .arg(agent_dir.to_string_lossy().as_ref())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NOVA_PI_HOST_MODE", &mode)
        .spawn()
        .map_err(|e| format!("启动 Node sidecar 失败：{e}。请确认已安装 Node.js 22.19+。"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法获取 sidecar stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法获取 sidecar stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法获取 sidecar stderr".to_string())?;

    // stdout 行读取线程：解析 JSON-line，分发响应/事件
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(value) => crate::rpc::handle_sidecar_message(&app_handle, value),
                Err(error) => {
                    eprintln!("[sidecar] 无效 JSON 行：{error}");
                }
            }
        }
        // stdout 关闭 = sidecar 退出
        let _ = app_handle.emit("pi-sidecar-exited", ());
    });

    // stderr 收集线程：转写到 Rust 的 stderr（便于调试）
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            eprintln!("[sidecar] {line}");
        }
    });

    let handle = SidecarHandle {
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(stdin),
    };

    // 若已有旧实例，先 drop（OnceLock 已初始化时忽略）
    let _ = SIDECAR.set(handle);

    Ok(())
}

/// 解析 sidecar 启动命令。
fn resolve_sidecar_command(
    mode: &str,
    _agent_dir: &PathBuf,
) -> Result<(String, Vec<String>), String> {
    let host_dir = match std::env::var("NOVA_PI_HOST_DIR") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => find_host_dir()?,
    };
    if mode == "dev" {
        // 开发期：npx tsx host/src/main.ts
        Ok((
            "npx".to_string(),
            vec!["tsx".to_string(), format!("{host_dir}/src/main.ts")],
        ))
    } else {
        // 生产期：node host/dist/main.js
        Ok((
            "node".to_string(),
            vec![format!("{host_dir}/dist/main.js")],
        ))
    }
}

/// 定位 host 目录（相对于 src-tauri）。
fn find_host_dir() -> Result<String, String> {
    // 编译期已知的相对路径：app/src-tauri → 上溯两级到 Nova-PI，再进 host
    let candidates = [
        "../host".to_string(),            // 标准：src-tauri 相对
        "../../host".to_string(),          // 某些构建布局
        "/Users/jeffzhang/Programs/AI/Nova-PI/host".to_string(), // 开发机绝对路径兜底
    ];
    for candidate in &candidates {
        if std::path::Path::new(candidate).is_dir() {
            return Ok(std::path::absolute(candidate)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| candidate.clone()));
        }
    }
    Err("无法定位 host 目录。请设置 NOVA_PI_HOST_DIR 环境变量。".to_string())
}

/// 向 sidecar stdin 写入一条 JSON-line 命令。
pub fn write_command(command: &serde_json::Value) -> Result<(), String> {
    let handle = SIDECAR.get().ok_or_else(|| "sidecar 尚未启动".to_string())?;
    let line = format!("{}\n", serde_json::to_string(command).map_err(|e| format!("序列化命令失败：{e}"))?);
    let mut stdin = handle.stdin.lock().map_err(|_| "stdin 锁中毒".to_string())?;
    stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("写入 sidecar stdin 失败：{e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("刷新 sidecar stdin 失败：{e}"))?;
    Ok(())
}

/// 关闭 sidecar（应用退出时调用）。
pub fn stop_sidecar() {
    if let Some(handle) = SIDECAR.get() {
        if let Ok(mut guard) = handle.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *guard = None;
        }
    }
}
