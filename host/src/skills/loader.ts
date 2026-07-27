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
  createExtensionRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

let baseLoader: ResourceLoader | null = null;

/** 初始化基础 ResourceLoader（在 agentDir 下发现 skills/extensions/prompts）。 */
export async function initBaseResourceLoader(agentDir: string): Promise<ResourceLoader> {
  baseLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
  });
  await baseLoader.reload();
  return baseLoader;
}

export function getBaseResourceLoader(): ResourceLoader | null {
  return baseLoader;
}

/**
 * 为单个会话构造一个带 systemPromptOverride 的 ResourceLoader。
 * base 来自已初始化的基础 loader（复用 skills/extensions 发现结果），仅替换 system prompt。
 */
export function createSessionResourceLoader(humanSystemPrompt: string): ResourceLoader {
  const base = baseLoader;
  return {
    getExtensions: () => base?.getExtensions() ?? { extensions: [], errors: [], runtime: createExtensionRuntime() },
    getSkills: () => base?.getSkills() ?? { skills: [], diagnostics: [] },
    getPrompts: () => base?.getPrompts() ?? { prompts: [], diagnostics: [] },
    getThemes: () => base?.getThemes() ?? { themes: [], diagnostics: [] },
    getAgentsFiles: () => base?.getAgentsFiles() ?? { agentsFiles: [] },
    getSystemPrompt: () => humanSystemPrompt,
    getAppendSystemPrompt: () => base?.getAppendSystemPrompt() ?? [],
    extendResources: (paths) => base?.extendResources(paths),
    reload: async (options) => { await base?.reload(options); },
  };
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
