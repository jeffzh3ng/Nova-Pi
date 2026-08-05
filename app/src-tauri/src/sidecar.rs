//! Node sidecar 进程管理：spawn、stdin 写入、stdout 行读取、stderr 收集、崩溃重启。
//!
//! sidecar 是 pi 内核（host/dist/main.js 或开发期 tsx），通过 stdin/stdout 的
//! newline-delimited JSON 与 Rust 通信（见 rpc.rs）。

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use chrono::Local;
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
static SIDECAR_LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
#[cfg(windows)]
static SIDECAR_JOB: OnceLock<usize> = OnceLock::new();

/// watchdog 连续失败计数器：用于指数退避与熔断。
///
/// - start_sidecar 主动调用且成功时清零（用户操作触发，认为外部状态可能已修复）。
/// - watchdog 自动重启每次失败 +1，达到 MAX_WATCHDOG_FAILURES 后停止重启，
///   emit `pi-sidecar-fatal` 让前端进入「sidecar 不可用，请重启应用」的明确错误态，
///   避免对已损坏的 host 文件无限重启导致 CPU 自循环 + 事件风暴。
static WATCHDOG_FAILURES: AtomicU32 = AtomicU32::new(0);
/// 连续失败达到此阈值后熔断（不再自动重启）。
const MAX_WATCHDOG_FAILURES: u32 = 5;
/// 每次失败后的基础退避秒数；实际 sleep = BASE_BACKOFF_SECS * 2^min(failures, cap)，
/// 上限约 60s。防止「立即崩→立即重启→立即崩」的 tight loop。
const BASE_BACKOFF_SECS: u64 = 2;

fn sidecar() -> &'static SidecarHandle {
    SIDECAR.get_or_init(|| SidecarHandle {
        child: Mutex::new(None),
        stdin: Mutex::new(None),
    })
}

fn prepare_sidecar_log(app_data_dir: &Path) -> Option<PathBuf> {
    let log_dir = app_data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).ok()?;
    let log_path = log_dir.join("sidecar.log");
    if log_path.metadata().map(|meta| meta.len()).unwrap_or(0) > 4 * 1024 * 1024 {
        let _ = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&log_path);
    }
    Some(log_path)
}

fn write_sidecar_log(log_path: Option<&Path>, message: &str) {
    let Some(log_path) = log_path else {
        return;
    };
    let Ok(_guard) = SIDECAR_LOG_LOCK.get_or_init(|| Mutex::new(())).lock() else {
        return;
    };
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) else {
        return;
    };
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let _ = writeln!(file, "[{timestamp}] {message}");
}

/// Build the stable command prefix used to identify this exact Nova sidecar.
/// Requiring the runtime, host entry and app-data agent directory together keeps
/// startup recovery from matching unrelated Node processes or another build.
#[cfg(any(target_os = "macos", test))]
fn sidecar_process_prefix(program: &str, args: &[String], agent_dir: &Path) -> String {
    let mut parts = Vec::with_capacity(args.len() + 2);
    parts.push(program.to_string());
    parts.extend(args.iter().cloned());
    parts.push(process_compatible_path(agent_dir));
    parts.join(" ")
}

#[cfg(any(target_os = "macos", test))]
fn command_matches_sidecar_prefix(command: &str, expected_prefix: &str) -> bool {
    command
        .strip_prefix(expected_prefix)
        .is_some_and(|rest| rest.is_empty() || rest.chars().next().is_some_and(char::is_whitespace))
}

#[cfg(any(target_os = "macos", test))]
fn stale_sidecar_pids(process_list: &str, expected_prefix: &str) -> Vec<u32> {
    process_list
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let pid_end = trimmed.find(char::is_whitespace)?;
            let pid = trimmed[..pid_end].parse::<u32>().ok()?;
            let after_pid = trimmed[pid_end..].trim_start();
            let ppid_end = after_pid.find(char::is_whitespace)?;
            let ppid = after_pid[..ppid_end].parse::<u32>().ok()?;
            let command = after_pid[ppid_end..].trim_start();
            (pid != std::process::id()
                && ppid == 1
                && command_matches_sidecar_prefix(command, expected_prefix))
            .then_some(pid)
        })
        .collect()
}

/// macOS has no Windows Job Object equivalent. If Nova was force-quit, reclaim
/// sidecars from the same installation before starting a replacement. Matching
/// uses the complete known prefix rather than a broad process-name search.
#[cfg(target_os = "macos")]
fn reclaim_stale_sidecars(
    program: &str,
    args: &[String],
    agent_dir: &Path,
    log_path: Option<&Path>,
) {
    let expected_prefix = sidecar_process_prefix(program, args, agent_dir);
    let list_matching = || -> Vec<u32> {
        let Ok(output) = Command::new("/bin/ps")
            .args(["-axww", "-o", "pid=", "-o", "ppid=", "-o", "command="])
            .output()
        else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }
        stale_sidecar_pids(&String::from_utf8_lossy(&output.stdout), &expected_prefix)
    };

    let stale = list_matching();
    if stale.is_empty() {
        return;
    }
    write_sidecar_log(
        log_path,
        &format!("startup recovery found stale sidecar pids={stale:?}"),
    );

    for pid in &stale {
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }

    // Give the host enough time to finish its own graceful shutdown: disposing
    // sessions and closing MCP stdio transports (which kills their child
    // processes) can take up to ~2s. SIGKILLing earlier would orphan the MCP
    // children a second time. Re-scan with the exact command prefix before
    // SIGKILL so a reused PID is never targeted.
    for _ in 0..20 {
        thread::sleep(Duration::from_millis(100));
        if list_matching().is_empty() {
            write_sidecar_log(log_path, "startup recovery terminated stale sidecar");
            return;
        }
    }

    let remaining = list_matching();
    for pid in &remaining {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &pid.to_string()])
            .status();
    }
    write_sidecar_log(
        log_path,
        &format!("startup recovery force-terminated stale sidecar pids={remaining:?}"),
    );
}

/// Keep the complete Node/MCP process tree in a Windows Job Object. The
/// KILL_ON_JOB_CLOSE limit is the last-resort cleanup path when Nova itself is
/// terminated and therefore cannot run its normal shutdown handler.
#[cfg(windows)]
fn assign_sidecar_to_job(child: &Child) -> Result<(), String> {
    use std::mem::{size_of, zeroed};
    use std::ptr::null;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let job = if let Some(raw) = SIDECAR_JOB.get() {
        *raw as HANDLE
    } else {
        // SAFETY: null security/name pointers request a private unnamed job.
        let created = unsafe { CreateJobObjectW(null(), null()) };
        if created.is_null() {
            return Err(format!(
                "CreateJobObjectW failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        // SAFETY: the structure is initialized before passing its exact size to
        // SetInformationJobObject, and the handle is valid from the call above.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                created,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            // SAFETY: `created` is a live handle owned by this function.
            unsafe { CloseHandle(created) };
            return Err(format!("SetInformationJobObject failed: {error}"));
        }

        if SIDECAR_JOB.set(created as usize).is_err() {
            // Another starter won the race; close our duplicate and use the
            // process-wide handle retained in SIDECAR_JOB.
            unsafe { CloseHandle(created) };
        }
        *SIDECAR_JOB.get().expect("sidecar job must be initialized") as HANDLE
    };

    // SAFETY: the job handle is retained for the entire Nova process lifetime;
    // Child owns a valid process handle until it is reaped.
    let assigned = unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) };
    if assigned == 0 {
        return Err(format!(
            "AssignProcessToJobObject failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// 启动 sidecar。已有健康进程时保持幂等，避免重复命令制造短时双进程。
pub fn start_sidecar(app: &AppHandle) -> Result<(), String> {
    if let Ok(mut guard) = sidecar().child.lock() {
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return Ok(());
            }
        }
    }
    start_sidecar_internal(app, true)
}

fn start_sidecar_internal(app: &AppHandle, reset_watchdog_failures: bool) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    let log_path = prepare_sidecar_log(&app_data_dir);
    let agent_dir = app_data_dir.join(".pi").join("agent");
    std::fs::create_dir_all(&agent_dir).map_err(|e| format!("无法创建 agent 目录：{e}"))?;
    let bundled_skill_dir = app
        .path()
        .resource_dir()
        .map(|dir| dir.join("skills"))
        .ok()
        .filter(|dir| dir.is_dir());
    let skill_state_path = app_data_dir.join("skill-state.json");

    // 开发期：直接 tsx 跑 host/src/main.ts；生产期：跑打包后的 host/dist/main.js。
    // 通过环境变量 NOVA_PI_HOST_MODE 控制（dev=tsx，prod=node）。
    let mode = std::env::var("NOVA_PI_HOST_MODE").unwrap_or_else(|_| "node".to_string());
    write_sidecar_log(
        log_path.as_deref(),
        &format!(
            "starting sidecar mode={mode} cwd={} resource_dir={}",
            std::env::current_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|error| format!("<unavailable: {error}>")),
            app.path()
                .resource_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|error| format!("<unavailable: {error}>"))
        ),
    );
    let (program, args) = resolve_sidecar_command(app, &mode).map_err(|error| {
        write_sidecar_log(log_path.as_deref(), &format!("resolve failed: {error}"));
        error
    })?;
    write_sidecar_log(
        log_path.as_deref(),
        &format!("resolved program={program} args={args:?}"),
    );

    // 先关闭旧实例，避免重复调用产生孤儿进程。
    kill_existing();
    #[cfg(target_os = "macos")]
    reclaim_stale_sidecars(&program, &args, &agent_dir, log_path.as_deref());

    let mut command = Command::new(&program);
    command
        .args(&args)
        .arg(process_compatible_path(&agent_dir))
        .arg(
            bundled_skill_dir
                .as_deref()
                .map(process_compatible_path)
                .unwrap_or_default(),
        )
        .arg(process_compatible_path(&skill_state_path))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NOVA_PI_HOST_MODE", &mode)
        .env("NOVA_PI_PARENT_PID", std::process::id().to_string());
    // Tauri 本身是 Windows GUI 程序。Node sidecar 若按默认控制台模式
    // 创建，会在应用启动或 watchdog 重启时短暂弹出黑色 cmd 窗口。
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = command.spawn().map_err(|error| {
        let message = format!("启动 Node sidecar 失败：{error}。请重新安装完整安装包。");
        write_sidecar_log(log_path.as_deref(), &format!("spawn failed: {message}"));
        message
    })?;
    #[cfg(windows)]
    if let Err(error) = assign_sidecar_to_job(&child) {
        let _ = child.kill();
        let _ = child.wait();
        write_sidecar_log(
            log_path.as_deref(),
            &format!("failed to guard sidecar process tree: {error}"),
        );
        return Err(format!("无法保护 Node sidecar 进程生命周期：{error}"));
    }
    write_sidecar_log(
        log_path.as_deref(),
        &format!("spawned sidecar pid={}", child.id()),
    );

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
    let stdout_log_path = log_path.clone();
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
                            write_sidecar_log(
                                stdout_log_path.as_deref(),
                                &format!("invalid stdout JSON: {error}"),
                            );
                        }
                    }
                }
                Err(error) => {
                    // IO 错误：管道破裂等。区分正常 EOF 与异常，便于排查。
                    eprintln!("[sidecar] stdout 读取错误：{error}");
                    write_sidecar_log(
                        stdout_log_path.as_deref(),
                        &format!("stdout read failed: {error}"),
                    );
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
        write_sidecar_log(
            stdout_log_path.as_deref(),
            &format!("sidecar stdout closed unexpected={unexpected}"),
        );
        if unexpected {
            // 指数退避：连续失败越多，下次重启前等得越久（上限 ~60s）。
            // 防止 host 文件损坏时陷入「立即崩→立即重启→立即崩」的 tight loop，
            // 既浪费 CPU 又会向前端 emit 事件风暴。
            let failures = WATCHDOG_FAILURES.fetch_add(1, Ordering::Relaxed) + 1;
            if failures > MAX_WATCHDOG_FAILURES {
                // 熔断：累计失败超阈值，停止自动重启，等待用户手动介入。
                // emit fatal 让前端进入明确的错误态，而不是无声地反复卡死。
                let msg = format!(
                    "sidecar 连续崩溃 {failures} 次，已停止自动重启。请检查日志或重启应用。"
                );
                eprintln!("[sidecar] {msg}");
                write_sidecar_log(stdout_log_path.as_deref(), &msg);
                let _ = app_handle.emit("pi-sidecar-fatal", msg);
                return;
            }
            // 指数退避：2, 4, 8, 16, 32s（failures=1..5），封顶 60s。
            // failures 从 1 开始（fetch_add 返回旧值，+1 后是新计数）。
            let exp = failures.min(5);
            let backoff_secs = BASE_BACKOFF_SECS.saturating_mul(1u64 << exp).min(60);
            eprintln!(
                "[sidecar] 意外退出（第 {failures}/{MAX_WATCHDOG_FAILURES} 次），{backoff_secs}s 后尝试 watchdog 重启"
            );
            write_sidecar_log(
                stdout_log_path.as_deref(),
                &format!(
                    "watchdog scheduled failure={failures}/{MAX_WATCHDOG_FAILURES} backoff={backoff_secs}s"
                ),
            );
            thread::sleep(Duration::from_secs(backoff_secs));
            // 退避期间若应用已退出（stop_sidecar 把 child 置 None），放弃重启避免无谓 spawn。
            let still_unexpected = sidecar()
                .child
                .lock()
                .map(|guard| guard.is_some())
                .unwrap_or(false);
            if !still_unexpected {
                eprintln!("[sidecar] 退避期间应用已关闭，放弃重启");
                write_sidecar_log(
                    stdout_log_path.as_deref(),
                    "watchdog cancelled because application is closing",
                );
                return;
            }
            match start_sidecar_internal(&app_handle, false) {
                Ok(()) => {
                    let _ = app_handle.emit("pi-sidecar-restarted", ());
                    eprintln!("[sidecar] watchdog 重启成功");
                    write_sidecar_log(stdout_log_path.as_deref(), "watchdog restart succeeded");
                }
                Err(error) => {
                    eprintln!("[sidecar] watchdog 重启失败：{error}");
                    write_sidecar_log(
                        stdout_log_path.as_deref(),
                        &format!("watchdog restart failed: {error}"),
                    );
                    let _ = app_handle.emit("pi-sidecar-fatal", error);
                }
            }
        }
    });

    // stderr 收集线程：转写到 Rust 的 stderr（便于调试）
    let stderr_log_path = log_path.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    eprintln!("[sidecar] {text}");
                    write_sidecar_log(stderr_log_path.as_deref(), &format!("host: {text}"));
                }
                Err(error) => {
                    eprintln!("[sidecar] stderr 读取错误：{error}");
                    write_sidecar_log(
                        stderr_log_path.as_deref(),
                        &format!("stderr read failed: {error}"),
                    );
                    break;
                }
            }
        }
    });

    // sidecar 就绪后，主动把 MCP 配置（含 NOVA_PI_UPLOADS_DIR 等注入 env）同步给新进程。
    // 必要性：
    // - pi agent 自主调用 MCP 工具（extension.ts → mcpRegistry.callTool）的路径不会经过
    //   sync_mcp_config_to_sidecar，若不在此预热，首次自主调用会因 configs 为空而失败，
    //   或 spawn 出不带 env 的 Python 子进程（导致路径守卫误报「路径越界」）。
    // - watchdog 重启时 Node 进程被整个替换，mcpRegistry.configs 清空，必须重新同步。
    // 异步执行不阻塞 start_sidecar 返回；失败仅记日志（设置页测试或首次 Agent 调用会再次同步）。
    let app_for_sync = app.clone();
    let sync_log_path = log_path;
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::sync_mcp_config_to_sidecar(&app_for_sync).await {
            eprintln!("[sidecar] 启动后同步 MCP 配置失败：{error}");
            write_sidecar_log(
                sync_log_path.as_deref(),
                &format!("initial MCP sync failed: {error}"),
            );
        }
        // 同步智谱 OCR API Key 给新进程（watchdog 重启时 Node 内存清空，需重推）。
        if let Err(error) = crate::sync_ocr_settings_to_sidecar(&app_for_sync).await {
            eprintln!("[sidecar] 启动后同步 OCR 配置失败：{error}");
        }
    });

    // spawn 成功：清零 watchdog 失败计数（无论本次是首次启动还是重启）。
    if reset_watchdog_failures {
        WATCHDOG_FAILURES.store(0, Ordering::Relaxed);
    }

    Ok(())
}

/// 关闭当前已注册的 sidecar 子进程（若有）。先请求 host 清理 MCP 子进程，再超时强杀。
fn kill_existing() {
    shutdown_registered_sidecar();
}

fn shutdown_registered_sidecar() {
    // 先从全局状态中取走句柄，让 stdout watchdog 将随后到来的 EOF 识别为主动退出。
    let mut child = sidecar()
        .child
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    let mut stdin = sidecar()
        .stdin
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());

    if let Some(mut pipe) = stdin.take() {
        let _ = pipe.write_all(b"{\"type\":\"shutdown\"}\n");
        let _ = pipe.flush();
        drop(pipe);
    }

    if let Some(mut process) = child.take() {
        for _ in 0..30 {
            match process.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }
        let _ = process.kill();
        let _ = process.wait();
    }
}

/// 解析 sidecar 启动命令。
fn resolve_sidecar_command(app: &AppHandle, mode: &str) -> Result<(String, Vec<String>), String> {
    let host_dir = find_host_dir(app, mode)?;
    if mode == "dev" {
        // 开发期：npx tsx host/src/main.ts
        Ok((
            "npx".to_string(),
            vec![
                "tsx".to_string(),
                process_compatible_path(&host_dir.join("src/main.ts")),
            ],
        ))
    } else {
        // 仓库构建布局为 host/dist/main.js；Tauri resources 把 dist 的内容
        // 映射到安装目录的 host/，因此安装布局为 host/main.js。
        let entry = resolve_production_entry(&host_dir).ok_or_else(|| {
            format!(
                "host 目录缺少生产入口 main.js：{}",
                host_dir.to_string_lossy()
            )
        })?;
        Ok((
            resolve_node_program(app),
            vec![process_compatible_path(&entry)],
        ))
    }
}

/// 生产安装包优先使用随应用分发的 Node，避免从 Explorer/开始菜单启动时 PATH 与
/// 开发终端不同。环境变量仅作为诊断覆盖；开发仓库仍可回退到系统 `node`。
fn resolve_node_program(app: &AppHandle) -> String {
    if let Ok(value) = std::env::var("NOVA_PI_NODE_PATH") {
        let path = PathBuf::from(value.trim());
        if path.is_file() {
            return process_compatible_path(&path);
        }
    }
    // 开发态必须使用 PATH 中的系统 Node。Tauri 热重载会重新同步 target/debug
    // 下的资源文件；若 sidecar 正在执行该目录里的 bundled node，覆盖可执行文件会
    // 让 macOS 进程卡在不可中断状态，继而导致全部 RPC 超时。
    #[cfg(debug_assertions)]
    {
        let _ = app;
        "node".to_string()
    }

    #[cfg(not(debug_assertions))]
    {
        if let Ok(resource_dir) = app.path().resource_dir() {
            if let Some(path) = find_bundled_node(&resource_dir.join("runtime")) {
                return process_compatible_path(&path);
            }
        }
        "node".to_string()
    }
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn find_bundled_node(runtime_dir: &Path) -> Option<PathBuf> {
    [runtime_dir.join("node.exe"), runtime_dir.join("node")]
        .into_iter()
        .find(|path| path.is_file())
}

/// Node 在 Windows 上不能可靠地把 `\\?\C:\...` 当作入口脚本参数解析；它会把路径
/// 截断为 `C:` 并以 EISDIR 退出。启动外部进程前转换回 Win32 常规绝对路径。
fn process_compatible_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(regular) = raw.strip_prefix(r"\\?\") {
            return regular.to_string();
        }
    }
    raw.into_owned()
}

/// 定位 host 目录。
///
/// 安装版必须优先从 Tauri resource_dir 读取，不能依赖进程当前工作目录；从开始菜单
/// 启动时 cwd 并不指向仓库或安装目录。相对路径仅作为开发态兼容回退。
fn find_host_dir(app: &AppHandle, mode: &str) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(value) = std::env::var("NOVA_PI_HOST_DIR") {
        if !value.trim().is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("host"));
    }
    candidates.push(PathBuf::from("../host"));
    candidates.push(PathBuf::from("../../host"));

    for candidate in &candidates {
        let has_entry = if mode == "dev" {
            candidate.join("src/main.ts").is_file()
        } else {
            resolve_production_entry(candidate).is_some()
        };
        if has_entry {
            return Ok(std::path::absolute(candidate).unwrap_or_else(|_| candidate.clone()));
        }
    }

    let searched = candidates
        .iter()
        .map(|path| path.to_string_lossy())
        .collect::<Vec<_>>()
        .join("、");
    Err(format!(
        "无法定位 Node sidecar 入口（已检查：{searched}）。请重新安装完整安装包，或设置 NOVA_PI_HOST_DIR。"
    ))
}

fn resolve_production_entry(host_dir: &std::path::Path) -> Option<PathBuf> {
    [host_dir.join("main.js"), host_dir.join("dist/main.js")]
        .into_iter()
        .find(|path| path.is_file())
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
    shutdown_registered_sidecar();
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::process_compatible_path;
    use super::{
        find_bundled_node, resolve_production_entry, sidecar_process_prefix, stale_sidecar_pids,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_host_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("nova-pi-sidecar-{name}-{nonce}"))
    }

    #[test]
    fn resolves_tauri_bundled_host_layout() {
        let host_dir = temp_host_dir("bundled");
        fs::create_dir_all(&host_dir).expect("temp host dir should be created");
        let bundled_entry = host_dir.join("main.js");
        fs::write(&bundled_entry, "").expect("bundled entry should be created");

        assert_eq!(resolve_production_entry(&host_dir), Some(bundled_entry));
        fs::remove_dir_all(host_dir).expect("temp host dir should be removed");
    }

    #[test]
    fn resolves_repository_host_layout() {
        let host_dir = temp_host_dir("repository");
        let dist_dir = host_dir.join("dist");
        fs::create_dir_all(&dist_dir).expect("temp dist dir should be created");
        let repository_entry = dist_dir.join("main.js");
        fs::write(&repository_entry, "").expect("repository entry should be created");

        assert_eq!(resolve_production_entry(&host_dir), Some(repository_entry));
        fs::remove_dir_all(host_dir).expect("temp host dir should be removed");
    }

    #[test]
    fn resolves_bundled_node_runtime() {
        let runtime_dir = temp_host_dir("runtime");
        fs::create_dir_all(&runtime_dir).expect("temp runtime dir should be created");
        let executable = runtime_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        fs::write(&executable, "").expect("runtime executable should be created");

        assert_eq!(find_bundled_node(&runtime_dir), Some(executable));
        fs::remove_dir_all(runtime_dir).expect("temp runtime dir should be removed");
    }

    #[test]
    fn identifies_only_the_exact_nova_sidecar_command() {
        let program = "/Applications/Nova.app/Contents/Resources/runtime/node";
        let entry = "/Applications/Nova.app/Contents/Resources/host/main.js".to_string();
        let agent_dir =
            PathBuf::from("/Users/test/Library/Application Support/com.nova.app/.pi/agent");
        let prefix = sidecar_process_prefix(program, &[entry], &agent_dir);
        let processes = format!(
            "  101     1 {prefix} /Applications/Nova.app/Contents/Resources/skills state.json\n\
               102     1 /usr/local/bin/node /Applications/Nova.app/Contents/Resources/host/main.js {}\n\
               103     1 /bin/zsh -c {prefix}\n\
               104     1 {prefix}-other\n\
               105   999 {prefix}\n",
            agent_dir.to_string_lossy()
        );

        assert_eq!(stale_sidecar_pids(&processes, &prefix), vec![101]);
    }

    #[cfg(windows)]
    #[test]
    fn strips_windows_verbatim_prefix_for_node_arguments() {
        assert_eq!(
            process_compatible_path(std::path::Path::new(
                r"\\?\C:\Users\DP\AppData\Local\Nova\host\main.js"
            )),
            r"C:\Users\DP\AppData\Local\Nova\host\main.js"
        );
        assert_eq!(
            process_compatible_path(std::path::Path::new(r"\\?\UNC\server\share\host\main.js")),
            r"\\server\share\host\main.js"
        );
    }
}
