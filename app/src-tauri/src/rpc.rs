//! RPC 编排：sidecar stdout 消息分发、请求-响应匹配、事件 emit 给前端。
//!
//! sidecar 的 stdout 消息有两类（见 host/src/rpc-protocol.ts）：
//! - response（按 id 匹配 pending 请求）：{ type:"response", id, success, data|error }
//! - event（异步事件流）：{ type:"event", event: {...} }

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

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
            let id = message
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let success = message
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            // 锁中毒时仍取出内部数据继续：单次 panic 不应让整个 RPC 子系统永久瘫痪。
            let mut map = pending().map.lock().unwrap_or_else(|e| e.into_inner());
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
                // 拦截 usage 事件写入 SQLite：pi 的真实 token 用量只有 host 知道，
                // Rust 的 call_llm 路径在新架构下几乎不被触达，必须在此记录。
                if event.get("type").and_then(|v| v.as_str()) == Some("usage") {
                    persist_usage_event(app, event);
                }
                if matches!(
                    event.get("type").and_then(|v| v.as_str()),
                    Some("wechat_message" | "telegram_message" | "feishu_message")
                ) {
                    if let Err(error) = crate::message_channels::persist_message_event(app, event) {
                        eprintln!("[rpc] 保存消息通道记录失败：{error}");
                    }
                }
                let _ = app.emit("pi-event", event.clone());
            }
        }
        _ => {
            eprintln!("[rpc] 未知 sidecar 消息类型：{msg_type}");
        }
    }
}

/// 发送一条 RPC 命令到 sidecar，等待响应（默认 5 分钟超时，容纳长任务）。
pub async fn send_rpc_blocking(app: &AppHandle, command: Value) -> Result<Value, String> {
    send_rpc_blocking_with_timeout(app, command, Duration::from_secs(300)).await
}

/// 发送一条 RPC 命令到 sidecar，等待响应（自定义超时）。
///
/// 调用方应保证 Rust 侧超时 **大于** 传给 sidecar 的 `timeoutSecs`，否则 Rust 先超时后，
/// sidecar 仍会跑完任务但响应因 pending 表无对应 id 而被静默丢弃，浪费 CPU/Token。
pub async fn send_rpc_blocking_with_timeout(
    _app: &AppHandle,
    command: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = format!("rust-{}", uuid_v7_like());
    let full_command = {
        let mut cmd = command;
        if let Some(obj) = cmd.as_object_mut() {
            obj.insert("id".to_string(), Value::String(id.clone()));
        }
        cmd
    };

    let (tx, rx) = oneshot::channel();
    pending()
        .map
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), tx);

    crate::sidecar::write_command(&full_command)?;

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            pending()
                .map
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            Err("sidecar 响应通道已关闭".to_string())
        }
        Err(_) => {
            pending()
                .map
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
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

/// 把 host 发来的 usage 事件写入 token_usage 表。
///
/// 新架构下 LLM 调用上移到 pi（host 内部），Rust 自身的 `call_llm` 几乎不被触达，
/// 因此 `save_token_usage` 不能依赖 call_llm 路径。host 在 agent_end 时聚合 usage 并 emit，
/// Rust 在此拦截并落库，让 TokenUsagePanel 能展示真实用量。
fn persist_usage_event(app: &AppHandle, event: &Value) {
    let model = event
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let agent_name = event
        .get("agentName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let prompt_tokens = event
        .get("promptTokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let completion_tokens = event
        .get("completionTokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let total_tokens = event
        .get("totalTokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    // 跳过全 0 的无效 usage（host 的 emitUsageFromAgentEnd 已过滤，这里二次防御）。
    if prompt_tokens == 0 && completion_tokens == 0 && total_tokens == 0 {
        return;
    }
    // callId 幂等键：host 为每个 usage 事件生成（sessionId#序号）。
    // 同一事件重放时 SQLite UNIQUE 约束会拒绝重复插入，避免 token 统计虚高。
    let call_id = event
        .get("callId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let usage = crate::llm_settings::Usage {
        prompt_tokens,
        completion_tokens,
        total_tokens,
    };
    // 写库失败不应影响事件流，仅记录日志。
    crate::llm_settings::save_token_usage(app, &model, &agent_name, &usage, call_id.as_deref());
}

/// 让 lib.rs 在初始化时调用（占位，目前无需额外初始化）。
pub fn init() {
    let _ = pending();
}
