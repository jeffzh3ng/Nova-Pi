//! Node sidecar 进程管理：spawn、stdin 写入、stdout 行读取、stderr 收集、崩溃重启。
//!
//! sidecar 是 pi 内核（host/dist/main.js 或开发期 tsx），通过 stdin/stdout 的
//! newline-delimited JSON 与 Rust 通信（见 rpc.rs）。

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{AppHandle, Emitter, Manager};

/// 全局 sidecar 句柄（整个应用生命周期共享一个 Node 进程）。
///
/// 用 `Mutex<Option<...>>` 而非 `OnceLock`：`start_sidecar` 重复调用时能先 kill
/// 旧进程并替换，避免孤儿 Node 进程占用资源。
struct SidecarHandle {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<std::process::ChildStdin>>,
}

static SIDECAR: OnceLock<SidecarHandle> = OnceLock::new();

fn sidecar() -> &'static SidecarHandle {
    SIDECAR.get_or_init(|| SidecarHandle {
        child: Mutex::new(None),
        stdin: Mutex::new(None),
    })
}

/// 启动 sidecar。重复调用会先 kill 旧进程再 spawn 新进程。
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

    // 先关闭旧实例，避免重复调用产生孤儿进程。
    kill_existing();

    let mut command = Command::new(&program);
    command
        .args(&args)
        .arg(agent_dir.to_string_lossy().as_ref())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NOVA_PI_HOST_MODE", &mode);
    // Tauri 本身是 Windows GUI 程序。Node sidecar 若按默认控制台模式
    // 创建，会在应用启动或 watchdog 重启时短暂弹出黑色 cmd 窗口。
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = command
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

    *sidecar().child.lock().map_err(|_| "child 锁中毒")? = Some(child);
    *sidecar().stdin.lock().map_err(|_| "stdin 锁中毒")? = Some(stdin);

    // stdout 行读取线程：解析 JSON-line，分发响应/事件；stdout EOF 时触发 watchdog 重启。
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    let trimmed = text.trim();
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
                Err(error) => {
                    // IO 错误：管道破裂等。区分正常 EOF 与异常，便于排查。
                    eprintln!("[sidecar] stdout 读取错误：{error}");
                    break;
                }
            }
        }
        // stdout 关闭 = sidecar 退出。区分"主动 stop"与"意外崩溃"：
        // 若 child 仍存在 Some（未在 stop_sidecar 中被置 None），说明是意外退出，触发 watchdog。
        let unexpected = sidecar()
            .child
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false);
        let _ = app_handle.emit("pi-sidecar-exited", ());
        if unexpected {
            eprintln!("[sidecar] 意外退出，尝试 watchdog 重启");
            match start_sidecar(&app_handle) {
                Ok(()) => {
                    let _ = app_handle.emit("pi-sidecar-restarted", ());
                    eprintln!("[sidecar] watchdog 重启成功");
                }
                Err(error) => {
                    eprintln!("[sidecar] watchdog 重启失败：{error}");
                    let _ = app_handle.emit("pi-sidecar-fatal", error);
                }
            }
        }
    });

    // stderr 收集线程：转写到 Rust 的 stderr（便于调试）
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(text) => eprintln!("[sidecar] {text}"),
                Err(error) => {
                    eprintln!("[sidecar] stderr 读取错误：{error}");
                    break;
                }
            }
        }
    });

    Ok(())
}

/// 关闭当前已注册的 sidecar 子进程（若有），等待其退出。仅 kill，不重启。
fn kill_existing() {
    if let Ok(mut guard) = sidecar().child.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
    if let Ok(mut guard) = sidecar().stdin.lock() {
        *guard = None;
    }
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
        Ok(("node".to_string(), vec![format!("{host_dir}/dist/main.js")]))
    }
}

/// 定位 host 目录（相对于 src-tauri）。
fn find_host_dir() -> Result<String, String> {
    // 编译期已知的相对路径：app/src-tauri → 上溯两级到 Nova-PI，再进 host。
    // 不硬编码开发者本机绝对路径（移植性差且会随目录调整失效）。
    let candidates = [
        "../host".to_string(),    // 标准：从 src-tauri 工作目录相对
        "../../host".to_string(), // 某些构建布局
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
    let line = format!(
        "{}\n",
        serde_json::to_string(command).map_err(|e| format!("序列化命令失败：{e}"))?
    );
    let mut guard = sidecar()
        .stdin
        .lock()
        .map_err(|_| "stdin 锁中毒".to_string())?;
    let stdin = guard
        .as_mut()
        .ok_or_else(|| "sidecar 尚未启动或已退出".to_string())?;
    stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("写入 sidecar stdin 失败：{e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("刷新 sidecar stdin 失败：{e}"))?;
    Ok(())
}

/// 关闭 sidecar（应用退出时调用）。标记为"主动关闭"，watchdog 不会重启。
pub fn stop_sidecar() {
    // 先把 child 置 None（在 kill 之前），让 watchdog 线程退出时判定为"主动关闭"不重启。
    // 注意：watchdog 线程在 stdout EOF 时检查 child.is_some()，所以这里必须先取走 child。
    let mut killed_child: Option<Child> = None;
    if let Ok(mut guard) = sidecar().child.lock() {
        killed_child = guard.take();
    }
    if let Ok(mut guard) = sidecar().stdin.lock() {
        *guard = None;
    }
    if let Some(mut child) = killed_child {
        let _ = child.kill();
        let _ = child.wait();
    }
}
