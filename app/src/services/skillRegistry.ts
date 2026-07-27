import { invoke } from "@tauri-apps/api/core";

export type SkillManifest = {
  id: string;
  name: string;
  description: string;
  version?: string | null;
  keywords: string[];
  triggers: string[];
  entry: string;
  runtime: string;
  enabled: boolean;
  permissions?: unknown;
  source?: string;
  sourcePath?: string;
  canDelete: boolean;
  canToggle: boolean;
};

export type SkillDefinition = {
  manifest: SkillManifest;
  entryContent: string;
};

export type SkillLoadError = {
  source: string;
  path: string;
  message: string;
};

export type SkillCatalog = {
  skills: SkillManifest[];
  errors: SkillLoadError[];
};

const normalizeManifest = (skill: SkillManifest): SkillManifest => ({
  ...skill,
  keywords: Array.isArray(skill.keywords) ? skill.keywords : [],
  triggers: Array.isArray(skill.triggers) ? skill.triggers : [],
  entry: skill.entry || "SKILL.md",
  runtime: skill.runtime || "instruction",
  enabled: skill.enabled !== false,
  canDelete: Boolean(skill.canDelete),
  canToggle: skill.canToggle !== false,
});

const normalizeCatalog = (catalog: SkillCatalog): SkillCatalog => ({
  skills: (catalog.skills ?? []).map(normalizeManifest),
  errors: Array.isArray(catalog.errors) ? catalog.errors : [],
});

// In-memory catalog cache. The agent runtime calls listSkills() on every
// user turn; without a cache each message triggers a full disk scan on the
// Rust side. Mutations below invalidate it so the Skill Center always shows
// fresh data after install/toggle/delete.
let catalogCache: SkillCatalog | null = null;
let skillsCache: SkillManifest[] | null = null;

const invalidateCatalogCache = () => {
  catalogCache = null;
  skillsCache = null;
};

export async function listSkillCatalog(): Promise<SkillCatalog> {
  // listSkillCatalog backs the Skill Center, whose "刷新" button is meant to
  // re-read from disk (manifest edits, files dropped into the dir, etc.), so
  // it must bypass the cache. It refreshes the cache as a side effect so the
  // per-turn listSkills() hot path also sees the latest data.
  try {
    const catalog = await invoke<SkillCatalog>("list_skill_catalog");
    catalogCache = normalizeCatalog(catalog);
    skillsCache = catalogCache.skills;
    return catalogCache;
  } catch (error) {
    console.warn("Failed to list skill catalog", error);
    return { skills: [], errors: [] };
  }
}

export async function listSkills(): Promise<SkillManifest[]> {
  if (skillsCache) return skillsCache;
  try {
    const skills = await invoke<SkillManifest[]>("list_skills");
    skillsCache = skills.map(normalizeManifest);
    return skillsCache;
  } catch (error) {
    console.warn("Failed to list skills", error);
    return [];
  }
}

export async function getSkill(skillId: string): Promise<SkillDefinition> {
  const definition = await invoke<SkillDefinition>("get_skill", { skillId });
  return {
    ...definition,
    manifest: normalizeManifest(definition.manifest),
  };
}

export async function setSkillEnabled(skillId: string, enabled: boolean): Promise<SkillManifest> {
  const skill = await invoke<SkillManifest>("set_skill_enabled", { skillId, enabled });
  invalidateCatalogCache();
  return normalizeManifest(skill);
}

export async function pickAndInstallSkill(): Promise<SkillManifest> {
  const skill = await invoke<SkillManifest>("pick_and_install_skill");
  invalidateCatalogCache();
  return normalizeManifest(skill);
}

export async function deleteUserSkill(skillId: string): Promise<void> {
  await invoke<void>("delete_user_skill", { skillId });
  invalidateCatalogCache();
}

export async function openUserSkillDir(): Promise<string> {
  return await invoke<string>("open_user_skill_dir");
}
