import { invoke } from "@tauri-apps/api/core";

export type AppPreferences = {
  closeToTray: boolean;
  showToolMessages: boolean;
};

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  closeToTray: true,
  showToolMessages: false,
};

export async function getAppPreferences(): Promise<AppPreferences> {
  return await invoke<AppPreferences>("get_app_preferences");
}

export async function saveAppPreferences(preferences: AppPreferences): Promise<AppPreferences> {
  return await invoke<AppPreferences>("save_app_preferences", { preferences });
}
