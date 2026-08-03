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
  type Skill,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createMcpExtension, type McpServiceScope } from "../mcp/extension.js";
import type { AttachmentRuntime } from "../attachments.js";
import { createAttachmentExtension } from "../attachment-processing.js";
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
  imageArtifacts?: ImageArtifactStore,
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
      return inventory ? [...current, inventory] : current;
    },
    extensionFactories: [
      ...(attachments ? [createAttachmentExtension(attachments)] : []),
      ...(allowedMcpServices === "all" || allowedMcpServices.length > 0
        ? [createMcpExtension(allowedMcpServices, attachments, imageArtifacts)]
        : []),
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
