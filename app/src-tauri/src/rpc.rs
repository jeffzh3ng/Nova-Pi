//! RPC 编排：sidecar stdout 消息分发、请求-响应匹配、事件 emit 给前端。
//!
//! sidecar 的 stdout 消息有两类（见 host/src/rpc-protocol.ts）：
//! - response（按 id 匹配 pending 请求）：{ type:"response", id, success, data|error }
//! - event（异步事件流）：{ type:"event", event: {...} }

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/// pending 请求表：id → oneshot sender。
struct PendingTable {
    map: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

static PENDING: OnceLock<PendingTable> = OnceLock::new();

fn pending() -> &'static PendingTable {
    PENDING.get_or_init(|| PendingTable {
        map: Mutex::new(HashMap::new()),
    })
}

/// 处理 sidecar stdout 的一行 JSON 消息。
pub fn handle_sidecar_message(app: &AppHandle, message: Value) {
    let msg_type = message.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match msg_type {
        "response" => {
            let id = message.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let success = message.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut map = pending().map.lock().unwrap();
            if let Some(sender) = map.remove(&id) {
                let result = if success {
                    Ok(message.get("data").cloned().unwrap_or(Value::Null))
                } else {
                    Err(message
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("RPC 调用失败")
                        .to_string())
                };
                let _ = sender.send(result);
            }
        }
        "event" => {
            // 把 event 整体 emit 给前端（前端 hostBridge.subscribePiEvents 监听 "pi-event"）
            if let Some(event) = message.get("event") {
                let _ = app.emit("pi-event", event.clone());
            }
        }
        _ => {
            eprintln!("[rpc] 未知 sidecar 消息类型：{msg_type}");
        }
    }
}

/// 发送一条 RPC 命令到 sidecar，等待响应（带超时）。
pub async fn send_rpc_blocking(_app: &AppHandle, command: Value) -> Result<Value, String> {
    let id = format!("rust-{}", uuid_v7_like());
    let full_command = {
        let mut cmd = command;
        if let Some(obj) = cmd.as_object_mut() {
            obj.insert("id".to_string(), Value::String(id.clone()));
        }
        cmd
    };

    let (tx, rx) = oneshot::channel();
    pending().map.lock().unwrap().insert(id.clone(), tx);

    crate::sidecar::write_command(&full_command)?;

    // 超时等待响应（默认 5 分钟，容纳长任务）
    let timeout = tokio::time::Duration::from_secs(300);
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            pending().map.lock().unwrap().remove(&id);
            Err("sidecar 响应通道已关闭".to_string())
        }
        Err(_) => {
            pending().map.lock().unwrap().remove(&id);
            Err("sidecar 响应超时".to_string())
        }
    }
}

/// 前端调用的 Tauri 命令：把前端命令转发给 sidecar，返回响应数据。
#[tauri::command]
pub async fn send_rpc(app: AppHandle, command: Value) -> Result<Value, String> {
    send_rpc_blocking(&app, command).await
}

/// 简易 ID（时间戳 + 进程内计数器），无需外部依赖。
fn uuid_v7_like() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mixed = counter | ((std::process::id() as u64) << 32);
    format!("{ms:013x}{mixed:019x}")
}

/// 让 lib.rs 在初始化时调用（占位，目前无需额外初始化）。
pub fn init() {
    let _ = pending();
}
