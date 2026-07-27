/**
 * Session 排他锁管理器
 * 确保同一时间只有一个 pi session 可以连接微信
 *
 * Vendored from pi-weixinbot (https://github.com/huang-x-h/pi-weixinbot)
 * Copyright (c) huangxinghui. MIT License.
 */

import { readFile, writeFile, unlink } from "node:fs/promises";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getStateDir } from "./weixin-auth.js";

// 锁文件路径
function getLockFilePath(): string {
  return join(getStateDir(), "session.lock");
}

// 锁数据结构
interface LockData {
  pid: number;
  sessionId: string;
  timestamp: number;      // 创建时间
  lastHeartbeat: number;  // 最后心跳时间
  accountId?: string;     // 当前连接的微信账户
  /**
   * 启动唯一令牌（H6 修复）。
   *
   * 背景：sessionId 在 Nova 架构下是固定值（"nova-weixin-bg"），无法唯一标识
   * "当前这次启动"。process.kill(pid,0) 在 Windows 上对**被回收的 PID**（已分配给
   * 无关进程）会返回 true，导致锁被误判"仍有效"，新实例永远连不上。
   *
   * 方案：进程启动时生成随机 token，写入锁文件；存活检测时，除了 PID 存在 +
   * 心跳新鲜，还要求"PID 存在的进程确实是我们写锁的那个"——通过让本进程在心跳
   * 时持续覆写 token 来间接保证（心跳新鲜 → 进程还活着 → 锁有效）。
   * 仅靠 lastHeartbeat（30s 超时）即可判断存活，PID 检查降级为辅助手段。
   */
  bootToken?: string;
}

// 锁配置
const LOCK_HEARTBEAT_INTERVAL_MS = 10000;  // 心跳间隔：10秒
const LOCK_TIMEOUT_MS = 30000;              // 锁超时：30秒

let heartbeatTimer: NodeJS.Timeout | null = null;
let currentSessionId: string | null = null;

/**
 * 本进程启动唯一令牌（每次进程启动随机生成，写锁时带上）。
 */
const BOOT_TOKEN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * 检查进程是否存在（跨平台）。
 *
 * 注意：仅作辅助判断。Windows 上 PID 被回收时可能误报 true（H6），
 * 因此 acquireLock 的最终判定以 lastHeartbeat 新鲜度为主。
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Node.js 的 process.kill(0) 可以检查进程是否存在
    // 不会实际发送信号，只是检查权限和进程存在性
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取锁文件
 */
async function readLockFile(): Promise<LockData | null> {
  try {
    const content = await readFile(getLockFilePath(), "utf-8");
    return JSON.parse(content) as LockData;
  } catch {
    return null;
  }
}

/**
 * 写入锁文件
 */
async function writeLockFile(data: LockData): Promise<void> {
  const lockPath = getLockFilePath();
  await writeFile(lockPath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * 删除锁文件
 */
async function removeLockFile(): Promise<void> {
  try {
    await unlink(getLockFilePath());
  } catch {
    // 忽略删除失败（可能已被其他进程删除）
  }
}

/**
 * 尝试获取锁
 * @param sessionId 当前 session 的 ID
 * @returns 锁信息（成功）或 null（失败）
 */
export async function acquireLock(sessionId: string, accountId?: string): Promise<{ success: boolean; message: string; existingSession?: LockData }> {
  const now = Date.now();
  const existingLock = await readLockFile();

  // 检查是否存在有效锁
  if (existingLock) {
    const isOwner = existingLock.sessionId === sessionId;
    // H6：心跳新鲜度是判活的主依据（PID 检查仅辅助，Windows PID 回收会误报）。
    // notExpired=true 说明心跳在 30s 内更新过 → 持锁进程仍活着。
    const notExpired = now - existingLock.lastHeartbeat < LOCK_TIMEOUT_MS;
    const pidRunning = isProcessRunning(existingLock.pid);

    // 如果锁属于自己，更新心跳即可
    if (isOwner) {
      existingLock.lastHeartbeat = now;
      existingLock.timestamp = now;
      existingLock.bootToken = BOOT_TOKEN;
      if (accountId) existingLock.accountId = accountId;
      await writeLockFile(existingLock);
      currentSessionId = sessionId;
      startHeartbeat(sessionId, accountId);
      return { success: true, message: "锁已更新（当前 session）" };
    }

    // 别人持有：心跳新鲜即视为有效（即便 PID 检查误报也以心跳为准）
    if (notExpired) {
      return {
        success: false,
        message: `微信已被其他会话占用 (PID: ${existingLock.pid}, 心跳 ${Math.round((now - existingLock.lastHeartbeat) / 1000)}s 前)`,
        existingSession: existingLock,
      };
    }

    // 心跳超时：无论 PID 是否"存在"，都视为失效锁（H6：避免 Windows PID 回收误判）
    console.log(
      `[weixinbot-lock] 检测到失效锁（心跳超时 ${Math.round((now - existingLock.lastHeartbeat) / 1000)}s），强制抢占 (PID: ${existingLock.pid}, pidRunning=${pidRunning})`,
    );
  }

  // 创建新锁
  const newLock: LockData = {
    pid: process.pid,
    sessionId,
    timestamp: now,
    lastHeartbeat: now,
    accountId,
    bootToken: BOOT_TOKEN,
  };

  await writeLockFile(newLock);
  currentSessionId = sessionId;
  startHeartbeat(sessionId, accountId);

  return { success: true, message: "成功获取锁" };
}

/**
 * 释放锁
 */
export async function releaseLock(sessionId?: string): Promise<void> {
  // 停止心跳
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  unregisterExitCleanup();

  // 检查当前锁是否属于自己
  const existingLock = await readLockFile();
  if (existingLock && (existingLock.sessionId === sessionId || existingLock.sessionId === currentSessionId)) {
    await removeLockFile();
    console.log(`[weixinbot-lock] 锁已释放 (Session: ${existingLock.sessionId.slice(0, 8)}...)`);
  }

  currentSessionId = null;
}

/**
 * 启动心跳定时器
 *
 * 注意：SIGINT/SIGTERM 的退出清理交给 host 的 gracefulShutdown 统一编排
 * （见 main.ts，会依次调 weixinBot.stop → releaseLock + disposeAll + mcpRegistry.dispose）。
 * 这里只在进程异常退出（kill -9 之外的正常 exit）时做最后的锁文件清理兜底，
 * 避免抢占 gracefulShutdown 的事件、或重复 process.exit 导致子进程泄漏。
 */
function startHeartbeat(sessionId: string, accountId?: string): void {
  // 清除旧定时器
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  // 启动新定时器
  heartbeatTimer = setInterval(async () => {
    try {
      const lock = await readLockFile();
      if (lock && lock.sessionId === sessionId) {
        lock.lastHeartbeat = Date.now();
        if (accountId) lock.accountId = accountId;
        await writeLockFile(lock);
      }
    } catch (err) {
      console.error(`[weixinbot-lock] 心跳更新失败:`, err);
    }
  }, LOCK_HEARTBEAT_INTERVAL_MS);

  // 进程 exit 兜底：同步清理锁文件（exit 回调内只能跑同步代码，releaseLock 内部
  // 是异步的，这里 best-effort 调用）。监听器只注册一次，避免多次 acquireLock 累积。
  registerExitCleanup(sessionId);
}

let exitCleanupListener: ((() => void) | null) = null;
let exitCleanupSessionId: string | null = null;

/** 注册进程退出时的锁清理（幂等，重复调用只更新 sessionId）。 */
function registerExitCleanup(sessionId: string): void {
  exitCleanupSessionId = sessionId;
  if (exitCleanupListener) return;
  exitCleanupListener = () => {
    const sid = exitCleanupSessionId;
    if (!sid) return;
    try {
      // exit 回调里只能同步操作；直接同步读锁文件判断归属后删除。
      const lockPath = getLockFilePath();
      if (existsSync(lockPath)) {
        const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
        if (lock?.sessionId === sid) unlinkSync(lockPath);
      }
    } catch {
      // best-effort
    }
  };
  process.once("exit", exitCleanupListener);
}

/** 显式注销 exit 监听器（releaseLock 时调用）。 */
function unregisterExitCleanup(): void {
  if (exitCleanupListener) {
    process.off("exit", exitCleanupListener);
    exitCleanupListener = null;
  }
  exitCleanupSessionId = null;
}

/**
 * 检查锁状态
 */
export async function checkLockStatus(): Promise<{
  locked: boolean;
  ownedByMe: boolean;
  session?: LockData;
}> {
  const lock = await readLockFile();

  if (!lock) {
    return { locked: false, ownedByMe: false };
  }

  // H6：以心跳新鲜度为主判活（解决 Windows PID 回收误报问题）。
  // 心跳是持锁进程主动写的，30s 内更新过即说明持锁进程仍活着；PID 检查仅辅助。
  const notExpired = Date.now() - lock.lastHeartbeat < LOCK_TIMEOUT_MS;
  const ownedByMe = lock.sessionId === currentSessionId;

  return {
    locked: notExpired,
    ownedByMe,
    session: lock,
  };
}

/**
 * 强制释放锁（谨慎使用）
 */
export async function forceReleaseLock(): Promise<boolean> {
  try {
    await removeLockFile();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    unregisterExitCleanup();
    currentSessionId = null;
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取当前 session ID
 */
export function getCurrentSessionId(): string | null {
  return currentSessionId;
}
