/**
 * 消息渠道「发送文件」统一抽象。
 *
 * 三个渠道（微信 / Telegram / 飞书）的协议差异极大：微信要 AES 加密 + CDN 上传，
 * Telegram 要 multipart，飞书要两步上传。但 agent 视角只关心一件事——把一个本地文件
 * 发给当前对话的用户。这里把这件事抽象成 ChannelFileSink，各渠道实现自己的 sendFile，
 * channel-tools.ts 注入的工具只依赖这个抽象，与具体渠道解耦。
 *
 * "发给谁"由 manager 在入站消息时填充 target（如微信的 {userId, contextToken}、
 * Telegram 的 {chatId, messageId}、飞书的 {messageId}），resolveTarget() 在工具 execute
 * 时返回当前 target。
 */

/** 渠道无关的"发给谁"上下文。各渠道自定义字段。 */
export type ChannelFileTarget = Record<string, unknown>;

/** sendFile 的返回：成功带展示文案，失败带错误信息（都会回灌给 LLM）。 */
export type ChannelFileResult =
  | { ok: true; detail: string }
  | { ok: false; error: string };

/**
 * 各渠道实现的"发文件"出口。filePath 已通过工具层校验（存在 + 大小上限），
 * 实现只需关心协议侧的上传 + 发送。
 */
export interface ChannelFileSink {
  /** 当前渠道名称（微信/Telegram/飞书），用于日志和工具描述。 */
  readonly channelName: string;

  /**
   * 把本地文件发给 target 用户。
   *
   * @param params.target  发送目标上下文（由 resolveTarget 在入站时填充）
   * @param params.filePath  本地文件绝对路径（已校验存在、未超大小上限）
   * @param params.caption  可选的随文件说明文字
   */
  sendFile(params: {
    target: ChannelFileTarget;
    filePath: string;
    caption?: string;
  }): Promise<ChannelFileResult>;
}

/** 统一的文件大小预校验上限（取三渠道最小能力 30MB，避免上传中途失败）。 */
export const CHANNEL_FILE_MAX_BYTES = 30 * 1024 * 1024;
