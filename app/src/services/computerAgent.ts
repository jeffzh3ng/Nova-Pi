import { invoke } from "@tauri-apps/api/core";
import { sendRpc } from "./hostBridge";

export const COMPUTER_AGENT_ID = "nova-computer-agent";

export type ComputerAgentSettings = {
  enabled: boolean;
  displayName: string;
  workingDirectory: string;
  allowFileRead: boolean;
  allowFileWrite: boolean;
  allowCommandExecution: boolean;
  allowComputerInfo: boolean;
  allowNovaManagement: boolean;
};

export type NovaConversationContext = {
  id: string;
  title: string;
  agentId?: string;
  agentName?: string;
  status: "done" | "running" | "paused" | "canceled";
  updatedAt?: string;
  archived?: boolean;
  messageCount?: number;
};

export async function getComputerAgentSettings(): Promise<ComputerAgentSettings> {
  return invoke<ComputerAgentSettings>("get_computer_agent_settings");
}

export async function saveComputerAgentSettings(
  settings: ComputerAgentSettings,
): Promise<ComputerAgentSettings> {
  const saved = await invoke<ComputerAgentSettings>("save_computer_agent_settings", { settings });
  await configureComputerAgentHost(saved);
  window.dispatchEvent(new CustomEvent("nova-computer-agent-settings-changed", { detail: saved }));
  return saved;
}

export async function pickComputerAgentWorkingDirectory(): Promise<string | null> {
  return invoke<string | null>("pick_computer_agent_working_directory");
}

export async function configureComputerAgentHost(
  settings: ComputerAgentSettings,
): Promise<ComputerAgentSettings> {
  return sendRpc<ComputerAgentSettings>({
    type: "configure_computer_agent",
    settings: settings as unknown as Record<string, unknown>,
  });
}

export async function syncComputerAgentSettingsToHost(): Promise<ComputerAgentSettings> {
  const settings = await getComputerAgentSettings();
  return configureComputerAgentHost(settings);
}

export async function updateNovaContext(conversations: NovaConversationContext[]): Promise<void> {
  await sendRpc({
    type: "update_nova_context",
    conversations: conversations as unknown as Array<Record<string, unknown>>,
  });
}
