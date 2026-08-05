/**
 * Skills 加载：用 pi 的 DefaultResourceLoader 从三源（user/project/resource）发现 SKILL.md。
 *
 * - 指令型（runtime: instruction）：pi 自动把 SKILL.md 内容注入 system prompt，LLM 按指令回答。
 * - 脚本型（runtime: script）：作为 customTool 暴露（execute_gongwen），由前端确认后调 Rust 执行。
 *
 * 与原 Nova 的差异：原 Nova 在 Rust skill_registry.rs 里手写 SKILL.md frontmatter 解析；
 * 新版交给 pi 的 ResourceLoader（pi 自带解析能力）。
 *
 * system prompt：每个数字员工有自己的角色 prompt。createSessionResourceLoader(humanPrompt)
 * 返回一个带 systemPromptOverride 的 loader，把员工 prompt 作为基础 system prompt。
 */

import {
  DefaultResourceLoader,
  type InlineExtension,
  type Skill,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createMcpExtension, type McpServiceScope } from "../mcp/extension.js";
import type { AttachmentRuntime } from "../attachments.js";
import type { DocumentRuntime } from "../document/document-runtime.js";
import { createDocumentExtension } from "../document/document-tool.js";
import type { ImageArtifactStore } from "../mcp/image-artifacts.js";
import {
  filterEnabledSkills,
  formatSkillInventoryForPrompt,
} from "./runtime.js";

let baseLoader: ResourceLoader | null = null;
let configuredAgentDir: string | null = null;
let configuredAdditionalSkillPaths: string[] = [];

/** 初始化基础 ResourceLoader（在 agentDir 下发现 skills/extensions/prompts）。 */
export async function initBaseResourceLoader(
  agentDir: string,
  additionalSkillPaths: string[] = [],
): Promise<ResourceLoader> {
  configuredAgentDir = agentDir;
  configuredAdditionalSkillPaths = additionalSkillPaths;
  baseLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    additionalSkillPaths,
    skillsOverride: (current) => ({
      ...current,
      skills: filterEnabledSkills(current.skills),
    }),
  });
  await baseLoader.reload();
  return baseLoader;
}

export function getBaseResourceLoader(): ResourceLoader | null {
  return baseLoader;
}

/**
 * 为单个会话构造一个带 systemPromptOverride 的 ResourceLoader。
 * 每个会话使用独立 extension runtime，避免 pi 会话之间共享事件状态；skills、用户扩展
 * 仍由同一个 agentDir 发现，同时额外注入该员工允许的 MCP inline extension。
 */
export async function createSessionResourceLoader(
  humanSystemPrompt: string,
  allowedMcpServices: McpServiceScope,
  cwd = process.cwd(),
  allowSkills = false,
  attachments?: AttachmentRuntime,
  documents?: DocumentRuntime,
  imageArtifacts?: ImageArtifactStore,
  channelExtension?: InlineExtension,
  mcpInventory?: string,
): Promise<ResourceLoader> {
  if (!configuredAgentDir) {
    throw new Error("技能加载器尚未初始化。");
  }
  let enabledSkills: Skill[] = [];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: configuredAgentDir,
    additionalSkillPaths: configuredAdditionalSkillPaths,
    systemPromptOverride: () => humanSystemPrompt,
    skillsOverride: (current) => {
      enabledSkills = allowSkills ? filterEnabledSkills(current.skills) : [];
      return { ...current, skills: enabledSkills };
    },
    appendSystemPromptOverride: (current) => {
      const inventory = allowSkills ? formatSkillInventoryForPrompt(enabledSkills) : "";
      const extras = inventory ? [...current, inventory] : [...current];
      // 会话创建时 warm-up 得到的 MCP 工具清单：让 agent 首轮直接用完整
      // serviceId/toolName 调用，绕开 mcp 代理工具的 search 关键词匹配。
      if (mcpInventory) extras.push(mcpInventory);
      // 消息渠道后台会话注入了 send_file_to_channel 工具，补一句引导提升触发率。
      // 仅当有 channelExtension 时追加，不影响前端会话和非渠道后台会话。
      if (channelExtension) {
        extras.push("你可以使用 send_file_to_channel 工具向用户发送本地文件（如评估结果、生成的报表等）。当用户索要文件或任务产出需要交付时，先确认文件路径再调用该工具。");
      }
      return extras;
    },
    extensionFactories: [
      ...(documents ? [createDocumentExtension(documents)] : []),
      ...(allowedMcpServices === "all" || allowedMcpServices.length > 0
        ? [createMcpExtension(allowedMcpServices, attachments, imageArtifacts, documents)]
        : []),
      ...(channelExtension ? [channelExtension] : []),
    ],
  });
  await loader.reload();
  return loader;
}

export async function reloadSkillResources(): Promise<void> {
  await baseLoader?.reload();
}

/** 列出已发现的 skills（供 list_skills RPC 返回给前端的 Skill Center）。 */
export function listDiscoveredSkills(): Array<{ name: string; description: string }> {
  if (!baseLoader) return [];
  try {
    const result = baseLoader.getSkills();
    return (result.skills ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description ?? "",
    }));
  } catch {
    return [];
  }
}
