/**
 * 消息通道面板（卡片网格版，多渠道）。
 *
 * 布局参照模型配置（SettingsPanel）：mcp-square-page + mcp-card-grid + 居中 modal。
 * 每个渠道一张卡片，含状态徽章 + 账号/员工 + 操作按钮。
 * 详情（二维码/消息记录/编辑配置）全部走 modal。
 *
 * 已实现渠道：微信（扫码）、Telegram（botToken + /start 配对）、飞书/Lark（多应用长连接）。
 * 占位渠道：钉钉（开发中）。
 *
 * 每个渠道独立的状态/消息流，按 channelId 隔离，互不干扰。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageCircle,
  Send,
  Loader2,
  AlertTriangle,
  QrCode,
  Pencil,
  Trash2,
  CirclePlus,
  X,
  Save,
  Eye,
  Link2Off,
} from "lucide-react";
import { subscribePiEvents } from "../services/hostBridge";
import { syncComputerAgentSettingsToHost } from "../services/computerAgent";
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
  startFeishuBot,
  stopFeishuBot,
  disposeFeishuBot,
  getFeishuBotStatus,
  type FeishuConfig,
} from "../services/feishuBot";
import {
  listMessageChannels,
  listMessageChannelRecords,
  saveMessageChannel,
  deleteMessageChannel,
  CHANNEL_TYPES,
  type MessageChannel,
} from "../services/messageChannels";
import { digitalHumans } from "../config/appContent";
import { showAppError, showAppWarning } from "../services/appDialog";
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
  | "connecting"
  | "awaiting_scan" // 微信等待扫码
  | "awaiting_pair" // telegram 等待 /start 配对
  | "online"
  | "error";
type ConnectionPhase = "stopped" | "started";

type ChatEntry = {
  id: string;
  eventKey?: string;
  role: "incoming" | "assistant";
  text: string;
  fromUser?: string;
  conversationKey?: string;
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
  connecting: "连接中",
  awaiting_scan: "等待扫码",
  awaiting_pair: "等待配对",
  online: "已连接",
  error: "异常",
};

const STATUS_TONE: Record<PanelStatus, string> = {
  offline: "is-offline",
  connecting: "is-pending",
  awaiting_scan: "is-pending",
  awaiting_pair: "is-pending",
  online: "is-online",
  error: "is-error",
};

const CHANNEL_SUBTITLE: Record<string, string> = {
  wechat: "个人微信消息接入",
  telegram: "Telegram Bot 接入",
  feishu: "飞书消息接入",
  dingtalk: "钉钉消息接入",
};

function ChannelGlyph({ channelType, size = 21 }: { channelType: string; size?: number }) {
  return channelType === "telegram" ? <Send size={size} /> : <MessageCircle size={size} />;
}

const channelTypeOf = (channel: MessageChannel): string => channel.channelType || channel.channelId;

/** 通用对话不在 appContent 的数字员工目录中，作为消息渠道的独立默认选项补入。 */
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
  channelType: "",
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
      if (entry.eventKey && cur.chat.some((item) => item.eventKey === entry.eventKey)) return prev;
      return { ...prev, [channelId]: { ...cur, chat: [...cur.chat, entry] } };
    });
  };

  useEffect(() => {
    void loadChannels();
  }, []);

  // 飞书是多实例渠道，逐个查询运行状态并按实例 ID 隔离展示。
  useEffect(() => {
    for (const channel of channels) {
      if (channelTypeOf(channel) !== "feishu") continue;
      void getFeishuBotStatus(channel.channelId)
        .then((status) => {
          patchRuntime(channel.channelId, {
            status: status.kind,
            account: status.appName ?? status.botOpenId,
            detail: status.detail,
            phase: status.kind === "offline" ? "stopped" : "started",
          });
        })
        .catch(() => {});
    }
  }, [channels]);

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
          // 同时缓存到 runtime.qrUrl：用户关掉二维码弹窗后，点「扫码」可重新打开同一张二维码，
          // 而不必再触发一次 login（sidecar 的 loginInProgress 守卫会挡掉重复登录请求）。
          patchRuntime("wechat", { qrUrl: event.qrUrl });
          setQrModal({ url: event.qrUrl });
          break;
        case "wechat_status":
          // H4：收到任何状态回流即取消超时定时器
          if (wechatLoginTimeoutRef.current) {
            clearTimeout(wechatLoginTimeoutRef.current);
            wechatLoginTimeoutRef.current = null;
          }
          // awaiting_scan 之外的终态（online/error/offline）都清掉缓存的二维码：
          // 登录成功或断开后旧二维码已失效，避免点「扫码」再打开过期的二维码。
          if (event.status !== "awaiting_scan") {
            patchRuntime("wechat", { qrUrl: undefined });
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
            eventKey: event.reqId ? `${event.role}:${event.reqId}` : undefined,
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
            eventKey: event.reqId ? `${event.role}:${event.reqId}` : undefined,
            role: event.role,
            text: event.text,
            fromUser: event.fromUser,
            ts: Date.now(),
          });
          break;
        case "feishu_status":
          patchRuntime(event.channelId, {
            status: event.status,
            account: event.appName ?? event.botOpenId,
            detail: event.detail,
            phase: event.status === "offline" ? "stopped" : "started",
          });
          if (event.status === "online" || event.status === "error" || event.status === "offline") {
            setBusyChannel((current) => (current === event.channelId ? null : current));
          }
          break;
        case "feishu_message":
          appendChat(event.channelId, {
            id: nextChatEntryId(event.role, event.reqId),
            eventKey: event.eventKey,
            role: event.role,
            text: event.text,
            fromUser: event.fromUser,
            conversationKey: event.conversationKey,
            ts: event.timestamp,
          });
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, []);

  // 消息记录按时间顺序展示，打开或收到新消息时定位到最新记录。
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
      showAppWarning("请填写显示名称");
      return;
    }
    const restartFeishu = channelTypeOf(draft) === "feishu"
      && runtime[draft.channelId]?.phase === "started";
    setEditor(null);
    setBusyChannel(draft.channelId || null);
    try {
      await saveMessageChannel(draft);
      await loadChannels();
      if (restartFeishu) {
        await syncComputerAgentSettingsToHost();
        await disposeFeishuBot(draft.channelId).catch(() => {});
        patchRuntime(draft.channelId, { phase: "started", status: "connecting", detail: undefined });
        await startFeishuBot(
          draft.channelId,
          draft.humanId,
          parseFeishuConfig(draft.configJson),
        );
      }
    } catch (err) {
      showAppError(err instanceof Error ? err.message : String(err), "消息渠道保存失败");
    } finally {
      setBusyChannel(null);
    }
  };

  // ── 微信操作 ──
  const handleWeixinStart = async (humanId: string): Promise<void> => {
    setBusyChannel("wechat");
    try {
      // syncComputerAgentSettingsToHost 只是顺带同步 Nova 智能员工授权（启动时已同步过），
      // 与微信启用无依赖关系，失败不应阻断启用流程。
      await syncComputerAgentSettingsToHost().catch((error) => {
        console.error("[消息通道] Nova 智能员工授权同步失败（不阻断微信启用）", error);
      });
      await startWeixinBot(humanId);
      // 启用后自动触发 login：service 层会优先用 token 缓存恢复（免扫码），
      // 无缓存才走扫码流程。状态由后续 wechat_status 事件驱动，这里先标 connecting。
      patchRuntime("wechat", { phase: "started", status: "connecting" });
      await loginWeixinBot();
    } catch (error) {
      // 之前只有 finally 静默吞错，导致点启用没反应也看不到原因。
      // 这里把错误暴露成卡片状态 + 控制台，便于排查。
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[消息通道] 微信启用失败", error);
      patchRuntime("wechat", { phase: "started", status: "error", detail });
    } finally {
      setBusyChannel(null);
    }
  };
  const handleWeixinLogin = async (): Promise<void> => {
    // awaiting_scan 状态下 sidecar 已有 loginInProgress 守卫，再调 login 会被 no-op。
    // 此时若已缓存二维码（用户关掉了弹窗想再看），直接打开缓存的二维码即可，不必触发新登录。
    const cachedQrUrl = runtime.wechat?.qrUrl;
    if (cachedQrUrl) {
      setQrModal({ url: cachedQrUrl });
      return;
    }
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
      await syncComputerAgentSettingsToHost();
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

  // ── 飞书操作（每个 channelId 对应独立应用、连接和数字员工） ──
  const handleFeishuStart = async (channel: MessageChannel): Promise<void> => {
    setBusyChannel(channel.channelId);
    patchRuntime(channel.channelId, { phase: "started", status: "connecting", detail: undefined });
    try {
      await syncComputerAgentSettingsToHost();
      const started = await startFeishuBot(
        channel.channelId,
        channel.humanId,
        parseFeishuConfig(channel.configJson),
      );
      if (!started) {
        patchRuntime(channel.channelId, { phase: "started", status: "error" });
      }
    } catch (error) {
      patchRuntime(channel.channelId, {
        phase: "started",
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyChannel((current) => (current === channel.channelId ? null : current));
    }
  };

  const handleFeishuStop = async (channelId: string): Promise<void> => {
    setBusyChannel(channelId);
    try {
      await stopFeishuBot(channelId);
      patchRuntime(channelId, { phase: "stopped", status: "offline", detail: undefined });
    } finally {
      setBusyChannel((current) => (current === channelId ? null : current));
    }
  };

  const openChatRecords = async (channelId: string): Promise<void> => {
    setChatModalFor(channelId);
    try {
      const records = await listMessageChannelRecords(channelId);
      setRuntime((prev) => {
        const current = prev[channelId] ?? emptyRuntime();
        const loaded = records.map((record): ChatEntry => ({
          id: `record-${record.recordId}`,
          eventKey: record.eventKey,
          role: record.role,
          text: record.content,
          fromUser: record.senderId,
          conversationKey: record.conversationKey,
          ts: record.createdAtMs,
        }));
        const merged = new Map<string, ChatEntry>();
        for (const entry of [...loaded, ...current.chat]) {
          merged.set(entry.eventKey ?? entry.id, entry);
        }
        return {
          ...prev,
          [channelId]: {
            ...current,
            chat: [...merged.values()].sort((left, right) => left.ts - right.ts),
          },
        };
      });
    } catch (error) {
      console.error("[消息通道] 读取消息记录失败", error);
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
    } else if (channelTypeOf(target) === "feishu") {
      await disposeFeishuBot(target.channelId).catch(() => {});
      patchRuntime(target.channelId, { phase: "stopped", status: "offline", detail: undefined });
    }
    try {
      await deleteMessageChannel(target.channelId);
      await loadChannels();
    } catch (err) {
      showAppError(err instanceof Error ? err.message : String(err), "消息渠道删除失败");
    }
  };

  const existingIds = new Set(channels.map(channelTypeOf));
  const activeChatChannel = chatModalFor
    ? channels.find((channel) => channel.channelId === chatModalFor)
    : undefined;
  const activeChatEntries = chatModalFor ? (runtime[chatModalFor]?.chat ?? []) : [];

  return (
    <section className="settings-page mcp-square-page channel-page" aria-label="消息通道">
      <header className="settings-header channel-page-header">
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
          const channelType = channelTypeOf(channel);
          const humanName = HUMAN_NAME[channel.humanId] ?? channel.humanId;
          const busy = busyChannel === channel.channelId;
          const isWechat = channelType === "wechat";
          const isTelegram = channelType === "telegram";
          const isFeishu = channelType === "feishu";
          const implemented = isWechat || isTelegram || isFeishu;

          return (
            <article
              key={channel.channelId}
              className={`channel-card ${STATUS_TONE[rt.status]} ${channel.enabled ? "" : "is-disabled"}`}
              data-channel={channelType}
            >
              <div className="channel-card-header">
                <div className="channel-card-identity">
                  <span className="channel-card-icon">
                    <ChannelGlyph channelType={channelType} />
                  </span>
                  <div className="channel-card-title">
                    <h2>{channel.displayName}</h2>
                    <p>{CHANNEL_SUBTITLE[channelType] ?? "外部消息接入"}</p>
                  </div>
                </div>
                <span className={`channel-status ${STATUS_TONE[rt.status]}`}>
                  <span className="channel-status-dot" aria-hidden="true" />
                  <span>
                    {busy && (rt.status === "connecting" || rt.status === "awaiting_scan" || rt.status === "awaiting_pair") ? (
                      <Loader2 size={11} className="spin" />
                    ) : null}
                    {STATUS_LABEL[rt.status]}
                  </span>
                </span>
              </div>

              <div className="channel-card-body">
                <dl className="channel-card-details">
                  <div className="channel-card-row">
                    <dt>{isTelegram ? "Bot 账号" : isFeishu ? "飞书应用" : "连接账号"}</dt>
                    <dd className={rt.account ? "" : "is-muted"} title={rt.account}>
                      {rt.account ?? "尚未连接"}
                    </dd>
                  </div>
                  {isTelegram && rt.allowedUserId ? (
                    <div className="channel-card-row">
                      <dt>配对用户</dt>
                      <dd title={rt.allowedUserId}>{rt.allowedUserId}</dd>
                    </div>
                  ) : null}
                  <div className="channel-card-row">
                    <dt>处理员工</dt>
                    <dd title={humanName}>{humanName}</dd>
                  </div>
                  <div className="channel-card-row">
                    <dt>启动方式</dt>
                    <dd>{channel.autoStart ? "跟随应用" : "手动启动"}</dd>
                  </div>
                </dl>
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

              <footer className="channel-card-footer">
                <div className="channel-card-actions">
                  {implemented ? (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={rt.phase === "started"}
                      className="channel-card-switch"
                      onClick={() => {
                        if (rt.phase === "started") {
                          if (isWechat) void handleWeixinStop();
                          else if (isTelegram) void handleTelegramStop();
                          else if (isFeishu) void handleFeishuStop(channel.channelId);
                        } else {
                          if (isWechat) void handleWeixinStart(channel.humanId);
                          else if (isTelegram) {
                            void handleTelegramStart(channel.humanId, parseTelegramConfig(channel.configJson));
                          }
                          else if (isFeishu) void handleFeishuStart(channel);
                        }
                      }}
                      disabled={busy}
                    >
                      <span className="channel-switch-track" aria-hidden="true">
                        <span />
                      </span>
                      <em>{busy ? "处理中" : rt.phase === "started" ? "已启用" : "未启用"}</em>
                    </button>
                  ) : null}

                  <div className="channel-card-links">
                    {isWechat && rt.phase === "started" && rt.status !== "online" ? (
                      <button
                        type="button"
                        className="channel-action-link is-accent"
                        onClick={handleWeixinLogin}
                        disabled={busy}
                        aria-label="扫码登录"
                      >
                        <QrCode size={14} /> 扫码
                      </button>
                    ) : null}
                    {/* 解除 Telegram 配对（仅在线 + 已配对时显示） */}
                    {isTelegram && rt.status === "online" && rt.allowedUserId ? (
                      <button
                        type="button"
                        className="channel-action-link is-danger"
                        onClick={handleTelegramResetPair}
                        disabled={busy}
                        aria-label="解除配对（清空已配对用户）"
                      >
                        <Link2Off size={14} /> 解绑
                      </button>
                    ) : null}
                    {implemented ? (
                      <button
                        type="button"
                        className="channel-action-link is-accent"
                        onClick={() => void openChatRecords(channel.channelId)}
                        aria-label="消息记录"
                      >
                        <Eye size={14} /> 记录
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="channel-action-link is-accent"
                      onClick={() => setEditor({ mode: "edit", draft: { ...channel } })}
                      aria-label="编辑"
                    >
                      <Pencil size={14} /> 编辑
                    </button>
                    <button
                      type="button"
                      className="channel-action-link is-danger"
                      onClick={() => setPendingDelete(channel)}
                      aria-label="删除"
                    >
                      <Trash2 size={14} /> 删除
                    </button>
                  </div>
                </div>
              </footer>
            </article>
          );
        })}

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
          className="mcp-editor-overlay channel-chat-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setChatModalFor(null);
          }}
        >
          <section
            className="mcp-editor-dialog channel-chat-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="channel-chat-title"
          >
            <header className="channel-chat-header">
              <div className="channel-chat-heading">
                <span
                  className="channel-chat-channel-icon"
                  data-channel={activeChatChannel ? channelTypeOf(activeChatChannel) : chatModalFor}
                >
                  <ChannelGlyph channelType={activeChatChannel ? channelTypeOf(activeChatChannel) : chatModalFor} size={20} />
                </span>
                <div className="channel-chat-header-copy">
                  <span>消息记录</span>
                  <h2 id="channel-chat-title">{activeChatChannel?.displayName ?? "对话"}</h2>
                </div>
              </div>
              <div className="channel-chat-header-actions">
                <span className="channel-chat-live">
                  <span aria-hidden="true" />
                  实时更新
                </span>
                <button type="button" onClick={() => setChatModalFor(null)} aria-label="关闭消息记录">
                  <X size={18} />
                </button>
              </div>
            </header>
            <div
              className="channel-chat-list"
              data-empty={activeChatEntries.length === 0 ? "true" : "false"}
              ref={chatScrollRef}
              aria-live="polite"
            >
              {activeChatEntries.length === 0 ? (
                <div className="channel-chat-empty">
                  <span className="channel-chat-empty-icon">
                    <MessageCircle size={24} />
                  </span>
                  <strong>暂无消息记录</strong>
                  <p>收到的用户消息与数字员工回复会实时显示在这里</p>
                </div>
              ) : (
                activeChatEntries.map((entry) => (
                  <div key={entry.id} className={`channel-chat-item channel-chat-${entry.role}`}>
                    <div className="channel-chat-meta">
                      {entry.role === "incoming" ? (
                          <span>
                            来自 {activeChatChannel ? activeChatChannel.displayName : "外部渠道"}
                            {entry.fromUser ? ` · ${entry.fromUser.slice(0, 10)}` : ""}
                          </span>
                      ) : (
                        <span>
                          <Send size={11} /> 已发回
                        </span>
                      )}
                    </div>
                    <div className="channel-chat-text">{entry.text}</div>
                    <time>{new Date(entry.ts).toLocaleString()}</time>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      ) : null}

      <ConfirmModal
        open={pendingDelete !== null}
        title="删除渠道"
        message={`确定删除「${pendingDelete?.displayName}」？此操作不可撤销，需要时可在新建渠道时重新添加。`}
        confirmLabel="删除"
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
  const draftType = channelTypeOf(draft);
  const isTelegram = draftType === "telegram";
  const isFeishu = draftType === "feishu";
  const tgConfig = parseTelegramConfig(draft.configJson);
  const fsConfig = parseFeishuConfig(draft.configJson);
  const hasStoredToken = Boolean(tgConfig.botToken);
  const hasStoredSecret = Boolean(fsConfig.appSecret);
  /**
   * C1 修复：编辑模式下不回显 token 明文，避免截图/肩窥泄露。
   * - edit 模式 + 已有 token：默认显示占位提示，用户点"修改"才进入输入态。
   * - 输入新 token 时覆盖；不修改则保存时保留原值（host 侧已存，前端保留占位符）。
   */
  const [editingToken, setEditingToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [editingSecret, setEditingSecret] = useState(false);
  const [secretDraft, setSecretDraft] = useState("");
  // 校验 botToken 格式（M4 延伸：数字:35字符 形式）
  const tokenValid = !isTelegram || !editingToken || /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(tokenDraft);

  const onSaveWrapped = () => {
    // C1：编辑模式下若未点"修改 token"，保留原 configJson（含已存 token）直接保存；
    // 若用户输入了新 token，合成最终 draft（含新 token）后保存。
    if (isTelegram && editingToken) {
      if (!tokenDraft.trim()) {
        showAppWarning("请填写 Bot Token");
        return;
      }
      if (!tokenValid) {
        showAppWarning("Bot Token 格式不正确（应为 123456789:AA... 形式）");
        return;
      }
      const merged = { ...tgConfig, botToken: tokenDraft.trim() };
      onSave({ ...draft, configJson: JSON.stringify(merged) });
      return;
    }
    if (isFeishu) {
      if (!fsConfig.appId.trim()) {
        showAppWarning("请填写飞书 App ID");
        return;
      }
      const appSecret = editingSecret ? secretDraft.trim() : fsConfig.appSecret.trim();
      if (!appSecret) {
        showAppWarning("请填写飞书 App Secret");
        return;
      }
      onSave({ ...draft, configJson: JSON.stringify({ ...fsConfig, appSecret }) });
      return;
    }
    onSave();
  };

  const updateFeishuConfig = (patch: Partial<FeishuConfig>) => {
    onDraftChange({ ...draft, configJson: JSON.stringify({ ...fsConfig, ...patch }) });
  };

  return (
    <div className="mcp-editor-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section
        className="mcp-editor-dialog channel-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-editor-title"
      >
        <header className="mcp-editor-header channel-editor-header">
          <h2 id="channel-editor-title">{mode === "add" ? "新建渠道" : "编辑渠道"}</h2>
          <button type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="mcp-editor-body">
          <label>
            <span>渠道类型 {mode === "add" ? "*" : ""}</span>
            <select
              value={draft.channelType}
              onChange={(e) => {
                const typeId = e.target.value;
                const type = CHANNEL_TYPES.find((t) => t.id === typeId);
                const channelId = typeId === "feishu"
                  ? `feishu-${globalThis.crypto.randomUUID()}`
                  : typeId;
                onDraftChange({
                  ...draft,
                  channelId,
                  channelType: typeId,
                  displayName: type?.defaultDisplayName ?? draft.displayName,
                  configJson: typeId === "telegram"
                    ? JSON.stringify({ botToken: "" })
                    : typeId === "feishu"
                      ? JSON.stringify({ appId: "", appSecret: "", domain: "feishu", groupPolicy: "mention" })
                      : "{}",
                });
              }}
              disabled={mode === "edit"}
            >
              <option value="" disabled>请选择渠道</option>
              {CHANNEL_TYPES.map((t) => {
                const exists = existingIds.has(t.id);
                const disabled = !t.available || (!t.multiple && exists && mode === "add");
                const label = !t.available
                  ? `${t.displayName}（即将推出）`
                  : !t.multiple && exists && mode === "add"
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

          {isFeishu ? (
            <>
              <label>
                <span>App ID *</span>
                <input
                  type="text"
                  value={fsConfig.appId}
                  onChange={(event) => updateFeishuConfig({ appId: event.target.value })}
                  placeholder="cli_xxxxxxxxxxxxxxxx"
                  autoComplete="off"
                />
              </label>
              <label>
                <span>App Secret *</span>
                {mode === "edit" && hasStoredSecret && !editingSecret ? (
                  <div className="channel-token-locked">
                    <span className="channel-token-mask">••••••••（已配置）</span>
                    <button
                      type="button"
                      className="channel-token-edit-btn"
                      onClick={() => { setEditingSecret(true); setSecretDraft(""); }}
                    >
                      修改
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      type="password"
                      value={editingSecret ? secretDraft : fsConfig.appSecret}
                      onChange={(event) => {
                        setSecretDraft(event.target.value);
                        if (!editingSecret) setEditingSecret(true);
                      }}
                      placeholder="飞书开放平台应用凭证"
                      autoComplete="off"
                    />
                    {mode === "edit" && editingSecret ? (
                      <button
                        type="button"
                        className="channel-token-cancel-btn"
                        onClick={() => { setEditingSecret(false); setSecretDraft(""); }}
                      >
                        取消修改，保留原 Secret
                      </button>
                    ) : null}
                  </>
                )}
              </label>
              <label>
                <span>平台域名</span>
                <select
                  value={fsConfig.domain}
                  onChange={(event) => updateFeishuConfig({ domain: event.target.value as FeishuConfig["domain"] })}
                >
                  <option value="feishu">飞书（中国）</option>
                  <option value="lark">Lark（国际）</option>
                </select>
              </label>
              <label>
                <span>群聊响应策略</span>
                <select
                  value={fsConfig.groupPolicy}
                  onChange={(event) => updateFeishuConfig({ groupPolicy: event.target.value as FeishuConfig["groupPolicy"] })}
                >
                  <option value="mention">仅被 @ 时回复</option>
                  <option value="open">接收群内全部消息</option>
                </select>
              </label>
              <p className="channel-field-help">
                飞书开放平台需启用机器人能力、选择“使用长连接接收事件”，并订阅消息接收事件。
              </p>
            </>
          ) : null}

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

/** 解析飞书 config_json（容错并补齐安全默认值）。 */
function parseFeishuConfig(json: string): FeishuConfig {
  try {
    const parsed = JSON.parse(json) as Partial<FeishuConfig>;
    return {
      appId: parsed.appId ?? "",
      appSecret: parsed.appSecret ?? "",
      domain: parsed.domain === "lark" ? "lark" : "feishu",
      groupPolicy: parsed.groupPolicy === "open" ? "open" : "mention",
    };
  } catch {
    return { appId: "", appSecret: "", domain: "feishu", groupPolicy: "mention" };
  }
}
