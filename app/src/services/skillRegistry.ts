import { invoke } from "@tauri-apps/api/core";
import { sendRpc } from "./hostBridge";

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

// In-memory catalog cache. listSkillCatalog() backs the Skill Center, whose
// "刷新" button re-reads from disk (manifest edits, files dropped into the
// dir, etc.); mutations below invalidate the cache so the Skill Center always
// shows fresh data after install/toggle/delete.
let catalogCache: SkillCatalog | null = null;

const catalogSignature = (catalog: SkillCatalog | null) => JSON.stringify(
  catalog?.skills.map((skill) => [skill.id, skill.enabled, skill.sourcePath]) ?? [],
);

const invalidateCatalogCache = () => {
  catalogCache = null;
};

async function reloadHostSkills(): Promise<void> {
  await sendRpc({ type: "reload_skills" });
  window.dispatchEvent(new CustomEvent("nova-skills-changed"));
}

export async function listSkillCatalog(): Promise<SkillCatalog> {
  // listSkillCatalog backs the Skill Center, whose "刷新" button is meant to
  // re-read from disk (manifest edits, files dropped into the dir, etc.), so
  // it must bypass the cache. It refreshes the cache as a side effect.
  const catalog = await invoke<SkillCatalog>("list_skill_catalog");
  const normalized = normalizeCatalog(catalog);
  const changed = catalogSignature(normalized) !== catalogSignature(catalogCache);
  catalogCache = normalized;
  if (changed) {
    await reloadHostSkills().catch((error) => {
      console.warn("Skill catalog changed but host reload failed", error);
    });
  }
  return catalogCache;
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
  await reloadHostSkills();
  return normalizeManifest(skill);
}

export async function pickAndInstallSkill(): Promise<SkillManifest> {
  const skill = await invoke<SkillManifest>("pick_and_install_skill");
  invalidateCatalogCache();
  await reloadHostSkills();
  return normalizeManifest(skill);
}

export async function deleteUserSkill(skillId: string): Promise<void> {
  await invoke<void>("delete_user_skill", { skillId });
  invalidateCatalogCache();
  await reloadHostSkills();
}

export async function openUserSkillDir(): Promise<string> {
  return await invoke<string>("open_user_skill_dir");
}
