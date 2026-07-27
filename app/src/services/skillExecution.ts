import { invoke } from "@tauri-apps/api/core";
import type { PendingSkillExecution } from "../types";

export type SkillExecutionResult = {
  path: string;
  fileName: string;
  inputPath: string;
  commandPreview: string[];
  stdout?: string;
  stderr?: string;
};

export async function executeSkillPlan(plan: PendingSkillExecution): Promise<SkillExecutionResult> {
  return await invoke<SkillExecutionResult>("execute_skill_plan", { plan });
}
