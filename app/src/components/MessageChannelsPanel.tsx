/**
 * 消息通道面板（卡片网格版，多渠道）。
 *
 * 布局参照模型配置（SettingsPanel）：mcp-square-page + mcp-card-grid + 居中 modal。
 * 每个渠道一张卡片，含状态徽章 + 账号/员工 + 操作按钮。
 * 详情（二维码/消息记录/编辑配置）全部走 modal。
 *
 * 已实现渠道：微信（扫码）、Telegram（botToken + /start 配对）。
 * 占位渠道：飞书、钉钉（开发中）。
 *
 * 每个渠道独立的状态/消息流，按 channelId 隔离，互不干扰。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageCircle,
  Send,
  Power,
  LogOut,
  Loader2,
  AlertTriangle,
  QrCode,
  Pencil,
  Trash2,
  CirclePlus,
  X,
  Save,
  Eye,
  Settings2,
  Link2Off,
} from "lucide-react";
import { subscribePiEvents } from "../services/hostBridge";
import {
  startWeixinBot,
  stopWeixinBot,
  loginWeixinBot,
  getWeixinBotStatus,
} from "../services/wechatBot";
import {
  startTelegramBot,
  stopTelegramBot,
  disposeTelegramBot,
  getTelegramBotStatus,
  resetTelegramPair,
  type TelegramConfig,
} from "../services/telegramBot";
import {
  listMessageChannels,
  saveMessageChannel,
  deleteMessageChannel,
  CHANNEL_TYPES,
  type MessageChannel,
} from "../services/messageChannels";
import { digitalHumans } from "../config/appContent";
import { ConfirmModal } from "./ConfirmModal";

/**
 * 单调递增的消息 id 计数器（C2 修复）。
 * 之前用 `Date.now()+Math.random()` 在同毫秒并发场景下可能碰撞，导致 React duplicate key。
 * 用模块级计数器保证唯一性（组件卸载不重置也无妨，数字单调递增即可）。
 */
let chatEntrySeq = 0;
const nextChatEntryId = (role: string, reqId?: string): string => {
  chatEntrySeq += 1;
  return `${role}-${reqId ?? "n"}-${chatEntrySeq}`;
};

/** 统一状态枚举（覆盖微信/telegram 两套状态的并集）。 */
type PanelStatus =
  | "offline"
  | "awaiting_scan" // 微信等待扫码
  | "awaiting_pair" // telegram 等待 /start 配对
  | "online"
  | "error";
type ConnectionPhase = "stopped" | "started";

type ChatEntry = {
  id: string;
  role: "incoming" | "assistant";
  text: string;
  fromUser?: string;
  ts: number;
};

/** 单个渠道的运行时状态（按 channelId 索引）。 */
type ChannelRuntime = {
  phase: ConnectionPhase;
  status: PanelStatus;
  /** 微信：账号名；telegram：bot 用户名。 */
  account?: string;
  /** telegram：配对用户 id。 */
  allowedUserId?: string;
  detail?: string;
  /** 是否有未读二维码（微信扫码中）。 */
  qrUrl?: string;
  /** 该渠道的消息流（独立）。 */
  chat: ChatEntry[];
};

const STATUS_LABEL: Record<PanelStatus, string> = {
  offline: "未连接",
  awaiting_scan: "等待扫码",
  awaiting_pair: "等待配对",
  online: "已连接",
  error: "异常",
};

const STATUS_TONE: Record<PanelStatus, string> = {
  offline: "is-offline",
  awaiting_scan: "is-pending",
  awaiting_pair: "is-pending",
  online: "is-online",
  error: "is-error",
};

/** 通用对话员工选项（host 的 general-chat，前端 appContent 不含它）。 */
const GENERAL_CHAT_OPTION = { id: "general-chat", name: "通用对话" };
const humanOptions = [GENERAL_CHAT_OPTION, ...digitalHumans];

const HUMAN_NAME: Record<string, string> = Object.fromEntries(
  humanOptions.map((h) => [h.id, h.name]),
);

type EditorState = {
  mode: "add" | "edit";
  draft: MessageChannel;
};

const EMPTY_DRAFT: MessageChannel = {
  channelId: "",
  displayName: "",
  enabled: true,
  autoStart: true,
  humanId: GENERAL_CHAT_OPTION.id,
  showMessages: false,
  configJson: "{}",
  updatedAt: "",
};

/** 默认 runtime 状态。 */
const emptyRuntime = (): ChannelRuntime => ({
  phase: "stopped",
  status: "offline",
  chat: [],
});

export function MessageChannelsPanel() {
  const [channels, setChannels] = useState<MessageChannel[]>([]);
  const [runtime, setRuntime] = useState<Record<string, ChannelRuntime>>({});
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MessageChannel | null>(null);
  const [qrModal, setQrModal] = useState<{ url: string } | null>(null);
  const [chatModalFor, setChatModalFor] = useState<string | null>(null);
  const [busyChannel, setBusyChannel] = useState<string | null>(null);

  const chatScrollRef = useRef<HTMLDivElement>(null);

  // H2 修复：channels 的 ref 镜像，让事件回调读到最新值（避免闭包捕获陈旧 channels）。
  // persistTelegramAllowedUserId 等异步流程据此读最新渠道，防止 lost-update。
  const channelsRef = useRef<MessageChannel[]>([]);
  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  const loadChannels = useCallback(async () => {
    try {
      const list = await listMessageChannels();
      setChannels(list);
      channelsRef.current = list;
    } catch (err) {
      // L2：DB 未就绪时记录告警，便于排查（用户无感知，进面板可手动重试）
      console.warn("[消息通道] 加载渠道列表失败", err);
    }
  }, []);

  /** 更新单个渠道的 runtime（局部 patch）。 */
  const patchRuntime = (channelId: string, patch: Partial<ChannelRuntime>) => {
    setRuntime((prev) => ({
      ...prev,
      [channelId]: { ...emptyRuntime(), ...prev[channelId], ...patch },
    }));
  };

  /** 追加消息到指定渠道。 */
  const appendChat = (channelId: string, entry: ChatEntry) => {
    setRuntime((prev) => {
      const cur = prev[channelId] ?? emptyRuntime();
      return { ...prev, [channelId]: { ...cur, chat: [...cur.chat, entry] } };
    });
  };

  useEffect(() => {
    void loadChannels();
  }, []);

  // 拉一次当前状态（微信 + telegram）
  useEffect(() => {
    void getWeixinBotStatus()
      .then((s) => {
        patchRuntime("wechat", {
          status: s.kind,
          account: s.account,
          phase: s.kind === "offline" ? "stopped" : "started",
        });
      })
      .catch(() => {});
    void getTelegramBotStatus()
      .then((s) => {
        if (s.kind !== "offline") {
          patchRuntime("telegram", { status: s.kind, phase: "started" });
        }
      })
      .catch(() => {});
  }, []);

  // 扫码登录超时句柄（H4 修复）：微信登录触发后若 30s 内无状态回流，自动清 busy。
  const wechatLoginTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 订阅事件流（微信 + telegram）
  useEffect(() => {
    const unsubscribe = subscribePiEvents((event) => {
      switch (event.type) {
        case "wechat_qrcode":
          setQrModal({ url: event.qrUrl });
          break;
        case "wechat_status":
          // H4：收到任何状态回流即取消超时定时器
          if (wechatLoginTimeoutRef.current) {
            clearTimeout(wechatLoginTimeoutRef.current);
            wechatLoginTimeoutRef.current = null;
          }
          patchRuntime("wechat", {
            status: event.status,
            account: event.account ?? event.accountName,
            detail: event.detail,
            phase: event.status === "offline" ? "stopped" : "started",
          });
          if (event.status === "online") {
            setQrModal(null);
            setBusyChannel((b) => (b === "wechat" ? null : b));
          } else if (event.status === "error" || event.status === "offline") {
            setBusyChannel((b) => (b === "wechat" ? null : b));
          }
          break;
        case "wechat_message":
          appendChat("wechat", {
            id: nextChatEntryId(event.role, event.reqId),
            role: event.role,
            text: event.text,
            fromUser: event.fromUser,
            ts: Date.now(),
          });
          break;
        case "telegram_status":
          patchRuntime("telegram", {
            status: event.status,
            account: event.botUsername,
            allowedUserId: event.allowedUserId,
            detail: event.detail,
            phase: event.status === "offline" ? "stopped" : "started",
          });
          // /start 配对后 allowedUserId 变化 → 持久化到 config_json
          if (event.status === "online" && event.allowedUserId) {
            void persistTelegramAllowedUserId(event.allowedUserId);
          }
          if (event.status === "online" || event.status === "error" || event.status === "offline") {
            setBusyChannel((b) => (b === "telegram" ? null : b));
          }
          break;
        case "telegram_message":
          appendChat("telegram", {
            id: nextChatEntryId(event.role, event.reqId),
            role: event.role,
            text: event.text,
            fromUser: event.fromUser,
            ts: Date.now(),
          });
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, []);

  // 消息记录 modal 打开时滚到底
  useEffect(() => {
    if (chatModalFor) {
      chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [chatModalFor, runtime]);

  /**
   * telegram 配对后把 allowedUserId 写回 SQLite config_json（M7 修复）。
   * 之前读 channels state（闭包初值 []），首次配对必然 miss，allowedUserId 写不回。
   * 现在用 channelsRef 读最新值；并在 setChannels 后同步刷新 ref。
   */
  const persistTelegramAllowedUserId = useCallback(async (allowedUserId: string) => {
    const tg = channelsRef.current.find((c) => c.channelId === "telegram");
    if (!tg) return;
    const cfg = parseTelegramConfig(tg.configJson);
    if (cfg.allowedUserId === allowedUserId) return; // 已是最新
    const next = { ...tg, configJson: JSON.stringify({ ...cfg, allowedUserId }) };
    try {
      await saveMessageChannel(next);
      setChannels((prev) => {
        const updated = prev.map((c) => (c.channelId === "telegram" ? next : c));
        channelsRef.current = updated; // 同步 ref，避免下次读旧值
        return updated;
      });
    } catch (err) {
      console.error("[telegram] 持久化 allowedUserId 失败", err);
    }
  }, []);

  // ── 编辑器保存 ──
  // finalDraft 由编辑器在内部合成 token 后传入（C1：不回显明文）。
  const saveEditor = async (finalDraft?: MessageChannel): Promise<void> => {
    if (!editor) return;
    const draft = finalDraft ?? editor.draft;
    if (!draft.displayName.trim()) {
      alert("请填写显示名称");
      return;
    }
    setEditor(null);
    setBusyChannel(draft.channelId || null);
    try {
      await saveMessageChannel(draft);
      await loadChannels();
    } catch (err) {
      alert(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyChannel(null);
    }
  };

  // ── 微信操作 ──
  const handleWeixinStart = async (humanId: string): Promise<void> => {
    setBusyChannel("wechat");
    try {
      await startWeixinBot(humanId);
      patchRuntime("wechat", { phase: "started", status: "offline" });
    } finally {
      setBusyChannel(null);
    }
  };
  const handleWeixinLogin = async (): Promise<void> => {
    setBusyChannel("wechat");
    // H4：扫码登录触发后，若 30s 内无 wechat_status 事件回流，自动清 busy，
    // 避免按钮一直 disabled 用户无法操作（收到事件时 wechat_status 分支会清这个 timer）。
    if (wechatLoginTimeoutRef.current) clearTimeout(wechatLoginTimeoutRef.current);
    wechatLoginTimeoutRef.current = setTimeout(() => {
      wechatLoginTimeoutRef.current = null;
      setBusyChannel((b) => (b === "wechat" ? null : b));
    }, 30_000);
    try {
      await loginWeixinBot();
    } catch {
      if (wechatLoginTimeoutRef.current) {
        clearTimeout(wechatLoginTimeoutRef.current);
        wechatLoginTimeoutRef.current = null;
      }
      setBusyChannel((b) => (b === "wechat" ? null : b));
    }
  };
  const handleWeixinStop = async (): Promise<void> => {
    setBusyChannel("wechat");
    try {
      await stopWeixinBot();
      patchRuntime("wechat", { phase: "stopped", status: "offline", qrUrl: undefined, detail: undefined });
      setQrModal(null);
    } finally {
      setBusyChannel(null);
    }
  };

  // ── telegram 操作 ──
  const handleTelegramStart = async (humanId: string, config: TelegramConfig): Promise<void> => {
    setBusyChannel("telegram");
    try {
      const ok = await startTelegramBot(humanId, config);
      if (ok) {
        patchRuntime("telegram", { phase: "started", status: "awaiting_pair" });
      }
    } finally {
      setBusyChannel(null);
    }
  };
  const handleTelegramStop = async (): Promise<void> => {
    setBusyChannel("telegram");
    try {
      await stopTelegramBot();
      patchRuntime("telegram", { phase: "stopped", status: "offline", detail: undefined });
    } finally {
      setBusyChannel(null);
    }
  };

  /**
   * 解除 Telegram 配对（H1）：清空 allowedUserId，回到 awaiting_pair。
   * 成功后刷新本地 config_json 缓存 + 状态卡片。
   */
  const handleTelegramResetPair = async (): Promise<void> => {
    setBusyChannel("telegram");
    try {
      const ok = await resetTelegramPair();
      if (ok) {
        // 同步清掉本地 channels 里的 allowedUserId
        setChannels((prev) => {
          const updated = prev.map((c) => {
            if (c.channelId !== "telegram") return c;
            const cfg = parseTelegramConfig(c.configJson);
            return { ...c, configJson: JSON.stringify({ ...cfg, allowedUserId: undefined }) };
          });
          channelsRef.current = updated;
          return updated;
        });
        patchRuntime("telegram", {
          status: "awaiting_pair",
          allowedUserId: undefined,
          detail: "已解除配对，请重新 /start",
        });
      }
    } finally {
      setBusyChannel(null);
    }
  };

  // ── 删除 ──
  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    if (target.channelId === "wechat") {
      const rt = runtime["wechat"];
      if (rt?.phase === "started") await handleWeixinStop().catch(() => {});
    } else if (target.channelId === "telegram") {
      // C3：删除 Telegram 渠道必须释放 host 单例，否则长轮询继续跑 + 下次新建会复用旧实例
      const rt = runtime["telegram"];
      if (rt?.phase === "started") await handleTelegramStop().catch(() => {});
      await disposeTelegramBot().catch(() => {});
      patchRuntime("telegram", { phase: "stopped", status: "offline", allowedUserId: undefined, detail: undefined });
    }
    try {
      await deleteMessageChannel(target.channelId);
      await loadChannels();
    } catch (err) {
      alert(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const existingIds = new Set(channels.map((c) => c.channelId));
  const placeholderCards = CHANNEL_TYPES.filter(
    (t) => !t.available && !existingIds.has(t.id),
  );

  return (
    <section className="settings-page mcp-square-page channel-page" aria-label="消息通道">
      <header className="settings-header">
        <div>
          <span>外部对接</span>
          <h1>消息通道</h1>
          <p className="mcp-status-line">
            接入外部消息渠道后，收到的消息会自动转给指定数字员工处理，AI 回复发回原渠道
          </p>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            onClick={() => setEditor({ mode: "add", draft: { ...EMPTY_DRAFT } })}
            disabled={busyChannel !== null}
          >
            <CirclePlus size={17} />
            新建渠道
          </button>
        </div>
      </header>

      <div className="mcp-card-grid">
        {channels.map((channel) => {
          const rt = runtime[channel.channelId] ?? emptyRuntime();
          const humanName = HUMAN_NAME[channel.humanId] ?? channel.humanId;
          const busy = busyChannel === channel.channelId;
          const isWechat = channel.channelId === "wechat";
          const isTelegram = channel.channelId === "telegram";
          const implemented = isWechat || isTelegram;

          return (
            <article
              key={channel.channelId}
              className={`mcp-service-card channel-card ${channel.enabled ? "" : "is-disabled"}`}
            >
              <div className="channel-card-header">
                <span className="mcp-card-icon">
                  <MessageCircle size={24} />
                </span>
                <h2>{channel.displayName}</h2>
                <span className="pi-provider-badges">
                  <span className={`mcp-connection-badge ${STATUS_TONE[rt.status]}`}>
                    {busy && (rt.status === "awaiting_scan" || rt.status === "awaiting_pair") ? (
                      <Loader2 size={11} className="spin" />
                    ) : null}
                    {STATUS_LABEL[rt.status]}
                  </span>
                </span>
              </div>

              <div className="channel-card-body">
                {rt.status === "online" && rt.account ? (
                  <div className="channel-card-row">
                    <span className="channel-card-label">{isTelegram ? "Bot" : "账号"}</span>
                    <span className="channel-card-value">{rt.account}</span>
                  </div>
                ) : null}
                {isTelegram && rt.status === "online" && rt.allowedUserId ? (
                  <div className="channel-card-row">
                    <span className="channel-card-label">已配对用户</span>
                    <span className="channel-card-value">{rt.allowedUserId}</span>
                  </div>
                ) : null}
                <div className="channel-card-row">
                  <span className="channel-card-label">员工</span>
                  <span className="channel-card-value">{humanName}</span>
                </div>
                <div className="channel-card-row">
                  <span className="channel-card-label">自动启动</span>
                  <span className="channel-card-value">{channel.autoStart ? "是" : "否"}</span>
                </div>
                {rt.detail && implemented ? (
                  <p className="channel-card-error">
                    <AlertTriangle size={12} /> {rt.detail}
                  </p>
                ) : null}
                {isTelegram && rt.status === "awaiting_pair" ? (
                  <p className="channel-card-hint">
                    <Send size={12} /> 在 Telegram 给 bot 发 /start 完成配对
                  </p>
                ) : null}
              </div>

              <footer className="mcp-card-footer">
                <div className="mcp-card-actions">
                  {/* 主操作：启动 / 停止（带文字，视觉重心） */}
                  {implemented && rt.phase === "stopped" ? (
                    <button
                      className="mcp-edit-button channel-btn-primary"
                      onClick={() => {
                        if (isWechat) void handleWeixinStart(channel.humanId);
                        else if (isTelegram) {
                          void handleTelegramStart(channel.humanId, parseTelegramConfig(channel.configJson));
                        }
                      }}
                      disabled={busy}
                    >
                      <Power size={13} /> 启动
                    </button>
                  ) : null}
                  {implemented && rt.phase === "started" ? (
                    <button
                      className="channel-btn-stop"
                      onClick={() => (isWechat ? handleWeixinStop() : handleTelegramStop())}
                      disabled={busy}
                    >
                      <LogOut size={13} /> 停止
                    </button>
                  ) : null}

                  {/* 图标条：次要操作（hover 显示文字 tooltip） */}
                  <div className="channel-card-icons">
                    {isWechat && rt.phase === "started" && rt.status !== "online" && rt.status !== "awaiting_scan" ? (
                      <button
                        className="channel-btn-icon"
                        onClick={handleWeixinLogin}
                        disabled={busy}
                        data-tip="扫码登录"
                        aria-label="扫码登录"
                      >
                        <QrCode size={14} />
                      </button>
                    ) : null}
                    {/* 解除 Telegram 配对（仅在线 + 已配对时显示） */}
                    {isTelegram && rt.status === "online" && rt.allowedUserId ? (
                      <button
                        className="channel-btn-icon mcp-delete-button"
                        onClick={handleTelegramResetPair}
                        disabled={busy}
                        data-tip="解除配对"
                        aria-label="解除配对（清空已配对用户）"
                      >
                        <Link2Off size={14} />
                      </button>
                    ) : null}
                    {implemented ? (
                      <button
                        className="channel-btn-icon"
                        onClick={() => setChatModalFor(channel.channelId)}
                        data-tip="消息记录"
                        aria-label="消息记录"
                      >
                        <Eye size={14} />
                      </button>
                    ) : null}
                    <button
                      className="channel-btn-icon"
                      onClick={() => setEditor({ mode: "edit", draft: { ...channel } })}
                      data-tip="编辑"
                      aria-label="编辑"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="channel-btn-icon mcp-delete-button"
                      onClick={() => setPendingDelete(channel)}
                      data-tip={isWechat ? "禁用" : "删除"}
                      aria-label={isWechat ? "禁用" : "删除"}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </footer>
            </article>
          );
        })}

        {/* 占位卡片 */}
        {placeholderCards.map((t) => (
          <article key={t.id} className="mcp-service-card channel-card channel-card-placeholder">
            <div className="channel-card-header">
              <span className="mcp-card-icon">
                <MessageCircle size={24} />
              </span>
              <h2>{t.displayName}</h2>
              <span className="pi-provider-badges">
                <span className="mcp-connection-badge is-offline">即将推出</span>
              </span>
            </div>
            <div className="channel-card-body">
              <p className="channel-card-soon">该渠道正在开发中，敬请期待。</p>
            </div>
          </article>
        ))}
      </div>

      {/* 编辑/新建 modal */}
      {editor ? (
        <ChannelEditor
          editor={editor}
          existingIds={existingIds}
          onClose={() => setEditor(null)}
          onSave={saveEditor}
          onDraftChange={(draft) => setEditor({ ...editor, draft })}
        />
      ) : null}

      {/* 二维码 modal（微信） */}
      {qrModal ? (
        <div
          className="mcp-editor-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setQrModal(null);
          }}
        >
          <section className="mcp-editor-dialog mcp-editor-dialog-narrow" role="dialog" aria-modal="true">
            <header className="mcp-editor-header">
              <span className="mcp-card-icon">
                <QrCode size={20} />
              </span>
              <div>
                <span>扫码登录</span>
                <h2>微信扫码</h2>
              </div>
              <button onClick={() => setQrModal(null)} aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <div className="mcp-editor-body channel-qr-body">
              <div className="channel-qr-frame">
                <img src={qrModal.url} alt="微信登录二维码" />
              </div>
              <p className="channel-qr-tip">
                <Loader2 size={13} className="spin" /> 请用手机微信扫码确认登录
              </p>
            </div>
          </section>
        </div>
      ) : null}

      {/* 消息记录 modal */}
      {chatModalFor ? (
        <div
          className="mcp-editor-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setChatModalFor(null);
          }}
        >
          <section className="mcp-editor-dialog" role="dialog" aria-modal="true">
            <header className="mcp-editor-header">
              <span className="mcp-card-icon">
                <MessageCircle size={20} />
              </span>
              <div>
                <span>消息记录</span>
                <h2>{channels.find((c) => c.channelId === chatModalFor)?.displayName ?? "对话"}</h2>
              </div>
              <button onClick={() => setChatModalFor(null)} aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <div className="channel-chat-list" ref={chatScrollRef}>
              {(runtime[chatModalFor]?.chat ?? []).length === 0 ? (
                <div className="channel-chat-empty">
                  <MessageCircle size={32} />
                  <p>等待消息...</p>
                </div>
              ) : (
                (runtime[chatModalFor]?.chat ?? []).map((entry) => (
                  <div key={entry.id} className={`channel-chat-item channel-chat-${entry.role}`}>
                    <div className="channel-chat-meta">
                      {entry.role === "incoming" ? (
                        <span>来自 {chatModalFor === "wechat" ? "微信" : "Telegram"}{entry.fromUser ? ` · ${entry.fromUser.slice(0, 10)}` : ""}</span>
                      ) : (
                        <span>
                          <Send size={11} /> 已发回
                        </span>
                      )}
                    </div>
                    <div className="channel-chat-text">{entry.text}</div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      ) : null}

      <ConfirmModal
        open={pendingDelete !== null}
        title={pendingDelete?.channelId === "wechat" ? "禁用渠道" : "删除渠道"}
        message={
          pendingDelete?.channelId === "wechat"
            ? `禁用「${pendingDelete.displayName}」？禁用后可在新建渠道时重新添加。`
            : `确定删除「${pendingDelete?.displayName}」？此操作不可撤销。`
        }
        confirmLabel={pendingDelete?.channelId === "wechat" ? "禁用" : "删除"}
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}

// ============================================================================
// 编辑器子组件（新建/编辑渠道配置）
// ============================================================================

type ChannelEditorProps = {
  editor: EditorState;
  existingIds: Set<string>;
  onClose: () => void;
  /** 保存。可传 finalDraft 覆盖当前 draft（C1：编辑器内部合成 token 后用）。 */
  onSave: (finalDraft?: MessageChannel) => void;
  onDraftChange: (draft: MessageChannel) => void;
};

function ChannelEditor({ editor, existingIds, onClose, onSave, onDraftChange }: ChannelEditorProps) {
  const { draft, mode } = editor;
  const isTelegram = draft.channelId === "telegram";
  const tgConfig = parseTelegramConfig(draft.configJson);
  const hasStoredToken = Boolean(tgConfig.botToken);
  /**
   * C1 修复：编辑模式下不回显 token 明文，避免截图/肩窥泄露。
   * - edit 模式 + 已有 token：默认显示占位提示，用户点"修改"才进入输入态。
   * - 输入新 token 时覆盖；不修改则保存时保留原值（host 侧已存，前端保留占位符）。
   */
  const [editingToken, setEditingToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  // 校验 botToken 格式（M4 延伸：数字:35字符 形式）
  const tokenValid = !isTelegram || !editingToken || /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(tokenDraft);

  const onSaveWrapped = () => {
    // C1：编辑模式下若未点"修改 token"，保留原 configJson（含已存 token）直接保存；
    // 若用户输入了新 token，合成最终 draft（含新 token）后保存。
    if (isTelegram && editingToken) {
      if (!tokenDraft.trim()) {
        alert("请填写 Bot Token");
        return;
      }
      if (!tokenValid) {
        alert("Bot Token 格式不正确（应为 123456789:AA... 形式）");
        return;
      }
      const merged = { ...tgConfig, botToken: tokenDraft.trim() };
      onSave({ ...draft, configJson: JSON.stringify(merged) });
      return;
    }
    onSave();
  };

  return (
    <div className="mcp-editor-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="mcp-editor-dialog" role="dialog" aria-modal="true">
        <header className="mcp-editor-header">
          <span className="mcp-card-icon">
            <Settings2 size={20} />
          </span>
          <div>
            <span>{mode === "add" ? "新建渠道" : "编辑渠道"}</span>
            <h2>{draft.displayName || "消息通道配置"}</h2>
          </div>
          <button onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="mcp-editor-body">
          <label>
            <span>渠道类型 {mode === "add" ? "*" : ""}</span>
            <select
              value={draft.channelId}
              onChange={(e) => {
                const typeId = e.target.value;
                const type = CHANNEL_TYPES.find((t) => t.id === typeId);
                onDraftChange({
                  ...draft,
                  channelId: typeId,
                  displayName: type?.defaultDisplayName ?? draft.displayName,
                  // telegram 切换时重置 configJson
                  configJson: typeId === "telegram" ? JSON.stringify({ botToken: "" }) : "{}",
                });
              }}
              disabled={mode === "edit"}
            >
              <option value="" disabled>请选择渠道</option>
              {CHANNEL_TYPES.map((t) => {
                const exists = existingIds.has(t.id);
                const disabled = !t.available || (exists && mode === "add");
                const label = !t.available
                  ? `${t.displayName}（即将推出）`
                  : exists && mode === "add"
                    ? `${t.displayName}（已添加）`
                    : t.displayName;
                return (
                  <option key={t.id} value={t.id} disabled={disabled}>
                    {label}
                  </option>
                );
              })}
            </select>
          </label>

          <label>
            <span>显示名称 *</span>
            <input
              type="text"
              value={draft.displayName}
              onChange={(e) => onDraftChange({ ...draft, displayName: e.target.value })}
              placeholder="如：我的微信"
            />
          </label>

          {/* Telegram 专属：botToken（C1：编辑模式不回显明文） */}
          {isTelegram ? (
            <label>
              <span>Bot Token *</span>
              {mode === "edit" && hasStoredToken && !editingToken ? (
                /* 已配置 token 的编辑态：显示占位 + "修改"按钮，避免明文回显 */
                <div className="channel-token-locked">
                  <span className="channel-token-mask">••••••••（已配置）</span>
                  <button
                    type="button"
                    className="channel-token-edit-btn"
                    onClick={() => { setEditingToken(true); setTokenDraft(""); }}
                  >
                    修改
                  </button>
                </div>
              ) : (
                <>
                  <input
                    type="password"
                    value={editingToken ? tokenDraft : tgConfig.botToken}
                    onChange={(e) => {
                      setTokenDraft(e.target.value);
                      if (!editingToken) setEditingToken(true);
                    }}
                    placeholder="从 @BotFather 获取（如 6123456789:AAH-...）"
                    autoComplete="off"
                  />
                  {!tokenValid ? (
                    <em className="channel-field-error">Token 格式应为 数字:35位字符</em>
                  ) : null}
                  {mode === "edit" && editingToken ? (
                    <button
                      type="button"
                      className="channel-token-cancel-btn"
                      onClick={() => { setEditingToken(false); setTokenDraft(""); }}
                    >
                      取消修改，保留原 Token
                    </button>
                  ) : null}
                </>
              )}
            </label>
          ) : null}

          <label>
            <span>消息处理员工</span>
            <select
              value={draft.humanId}
              onChange={(e) => onDraftChange({ ...draft, humanId: e.target.value })}
            >
              {humanOptions.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
          </label>

          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={draft.autoStart}
              onChange={(e) => onDraftChange({ ...draft, autoStart: e.target.checked })}
            />
            <span>应用启动时自动连接</span>
          </label>

          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={draft.showMessages}
              onChange={(e) => onDraftChange({ ...draft, showMessages: e.target.checked })}
            />
            <span>进入面板时默认展开消息记录</span>
          </label>
        </div>
        <footer className="mcp-editor-footer">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={onSaveWrapped} disabled={isTelegram && !tokenValid}>
            <Save size={15} /> 保存配置
          </button>
        </footer>
      </section>
    </div>
  );
}

/** 解析 telegram config_json（容错）。 */
function parseTelegramConfig(json: string): TelegramConfig {
  try {
    const parsed = JSON.parse(json) as Partial<TelegramConfig>;
    return { botToken: parsed.botToken ?? "", allowedUserId: parsed.allowedUserId };
  } catch {
    return { botToken: "" };
  }
}
