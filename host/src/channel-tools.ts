/**
 * 消息渠道「发送文件」工具：作为 pi InlineExtension 注入到消息渠道的后台会话。
 *
 * 仿 mcp/extension.ts 的模式：factory(pi) 内 pi.registerTool，execute 闭包捕获
 * ChannelFileSink 和 resolveTarget。工具被调用时 host 进程内直接执行发送，
 * 无需走事件回路。ChannelReplyCollector 会忽略 tool_execution_* 事件，agent 调完工具
 * 可继续输出"已发送"文本，不打断回复收集。
 *
 * 工具参数只收 file_path（任意本地路径）+ 可选 caption。安全边界：
 *   - 文件必须存在（fs.stat）
 *   - 拒绝目录
 *   - 大小上限 CHANNEL_FILE_MAX_BYTES（30MB，三渠道最小能力）
 *   - 拒绝读取设备/管道等特殊文件（仅常规文件）
 *
 * "发给谁"由 manager 在入站消息时通过 resolveTarget 注入；若没有当前目标
 * （例如会话刚启动还没收到用户消息），工具返回错误，agent 会告知用户。
 */

import { stat } from "node:fs/promises";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CHANNEL_FILE_MAX_BYTES,
  type ChannelFileSink,
  type ChannelFileTarget,
} from "./channel-file-sink.js";

export const SEND_FILE_TOOL_NAME = "send_file_to_channel";

type SendFileArgs = {
  file_path: string;
  caption?: string;
};

/**
 * 构造消息渠道发文件工具的 InlineExtension。
 *
 * @param sink  各渠道实现的发文件出口
 * @param resolveTarget  返回当前对话的发送目标（由 manager 在入站时维护）
 */
export function createChannelToolsExtension(
  sink: ChannelFileSink,
  resolveTarget: () => ChannelFileTarget | null,
): InlineExtension {
  return {
    name: "nova-channel-tools",
    hidden: true,
    factory(pi) {
      pi.registerTool({
        name: SEND_FILE_TOOL_NAME,
        label: "发送文件到消息渠道",
        description:
          `向当前消息渠道（${sink.channelName}）的用户发送一个本地文件。` +
          "适用于：用户要求发送某个本地文件、任务产生的结果文件（如评估 xlsx）需要交付给用户。" +
          "文件路径必须是本机的绝对路径。可在 caption 里附一句说明文字随文件一起发出。",
        parameters: Type.Object({
          file_path: Type.String({
            description: "本机要发送的文件绝对路径，例如 D:/reports/评估结果.xlsx",
          }),
          caption: Type.Optional(
            Type.String({
              description: "随文件一起发送的说明文字（可选）",
            }),
          ),
        }),
        async execute(_toolCallId, rawArgs) {
          const args = rawArgs as SendFileArgs;
          const filePath = (args.file_path ?? "").trim();
          if (!filePath) {
            return toolError("缺少 file_path 参数。");
          }

          // 路径 + 大小校验
          let info;
          try {
            info = await stat(filePath);
          } catch {
            return toolError(`文件不存在或无法访问：${filePath}`);
          }
          if (!info.isFile()) {
            return toolError(`目标不是常规文件（可能是目录或设备）：${filePath}`);
          }
          if (info.size === 0) {
            return toolError(`文件为空，无法发送：${filePath}`);
          }
          if (info.size > CHANNEL_FILE_MAX_BYTES) {
            const mb = (info.size / 1024 / 1024).toFixed(1);
            const limitMb = (CHANNEL_FILE_MAX_BYTES / 1024 / 1024).toFixed(0);
            return toolError(`文件过大（${mb} MB），上限 ${limitMb} MB：${filePath}`);
          }

          // 解析发送目标
          const target = resolveTarget();
          if (!target) {
            return toolError("当前没有可送达的渠道用户（还未收到用户消息）。");
          }

          // 执行发送
          let result;
          try {
            result = await sink.sendFile({
              target,
              filePath,
              caption: args.caption?.trim() || undefined,
            });
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            return toolError(`发送文件时出错：${detail}`);
          }

          if (!result.ok) {
            return toolError(result.error);
          }
          return {
            content: [{ type: "text", text: `已通过${sink.channelName}发送文件：${filePath}${result.detail ? `\n${result.detail}` : ""}` }],
            details: { ok: true, channel: sink.channelName },
          };
        },
      });
    },
  };
}

function toolError(text: string) {
  return {
    content: [{ type: "text", text }],
    details: { ok: false },
  };
}
