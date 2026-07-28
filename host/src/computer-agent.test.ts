import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  builtInToolNamesForSettings,
  COMPUTER_AGENT_ID,
  createComputerAgentTools,
  customToolNamesForSettings,
  DEFAULT_COMPUTER_AGENT_SETTINGS,
  normalizeComputerAgentSettings,
} from "./computer-agent.js";

test("computer agent is default-present but disabled and has no privileged tools", () => {
  assert.equal(COMPUTER_AGENT_ID, "nova-computer-agent");
  assert.equal(DEFAULT_COMPUTER_AGENT_SETTINGS.enabled, false);
  assert.deepEqual(builtInToolNamesForSettings(DEFAULT_COMPUTER_AGENT_SETTINGS), []);
  assert.deepEqual(customToolNamesForSettings(DEFAULT_COMPUTER_AGENT_SETTINGS), []);
});

test("computer agent maps each authorization to the intended pi tools", () => {
  const settings = normalizeComputerAgentSettings({
    enabled: true,
    workingDirectory: process.cwd(),
    allowFileRead: true,
    allowFileWrite: true,
    allowCommandExecution: true,
    allowComputerInfo: true,
    allowNovaManagement: true,
  });
  assert.deepEqual(builtInToolNamesForSettings(settings), ["read", "bash", "edit", "write"]);
  assert.deepEqual(customToolNamesForSettings(settings), ["computer_info", "nova_status", "nova_list_tasks", "nova_manage_task"]);
});

test("normalizing settings never grants omitted permissions", () => {
  const settings = normalizeComputerAgentSettings({ enabled: true, workingDirectory: process.cwd() });
  assert.equal(settings.enabled, true);
  assert.equal(settings.allowFileRead, false);
  assert.equal(settings.allowFileWrite, false);
  assert.equal(settings.allowCommandExecution, false);
  assert.equal(settings.allowComputerInfo, false);
  assert.equal(settings.allowNovaManagement, false);
});

test("pi sessions isolate normal employees and authorized native tools perform real local work", { timeout: 30_000 }, async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "nova-computer-agent-"));
  const outsideDirectory = mkdtempSync(path.join(os.tmpdir(), "nova-computer-agent-outside-"));
  try {
    const isolated = await createAgentSession({
      cwd,
      agentDir: path.join(cwd, ".agent-isolated"),
      noTools: "builtin",
      sessionManager: SessionManager.inMemory(cwd),
    });
    for (const tool of ["read", "bash", "edit", "write"]) {
      assert.equal(isolated.session.getActiveToolNames().includes(tool), false, `${tool} must stay isolated`);
    }
    isolated.session.dispose();

    const settings = normalizeComputerAgentSettings({
      enabled: true,
      workingDirectory: cwd,
      allowFileRead: true,
      allowFileWrite: true,
      allowCommandExecution: true,
      allowComputerInfo: true,
      allowNovaManagement: true,
    });
    const customTools = createComputerAgentTools(settings, {
      currentConversationId: "self",
      getNovaStatus: () => ({
        host: { pid: process.pid, uptimeSeconds: 1, nodeVersion: process.version, platform: process.platform },
        totals: { conversations: 1, sessions: 1, running: 0, background: 0 },
        conversations: [],
        sessions: [],
      }),
      manageNovaTask: async () => ({ ok: true, message: "managed" }),
    });
    const authorized = await createAgentSession({
      cwd,
      agentDir: path.join(cwd, ".agent-authorized"),
      tools: [...builtInToolNamesForSettings(settings), ...customTools.map((tool) => tool.name)],
      customTools,
      sessionManager: SessionManager.inMemory(cwd),
    });
    assert.deepEqual(
      authorized.session.getActiveToolNames().sort(),
      ["bash", "computer_info", "edit", "nova_list_tasks", "nova_manage_task", "nova_status", "read", "write"],
    );

    const execute = async (name: string, args: unknown) => {
      const definition = authorized.session.getToolDefinition(name);
      assert.ok(definition, `${name} definition should exist`);
      return definition.execute(`${name}-call`, args as never, undefined, undefined, {} as never);
    };
    await execute("write", { path: "probe.txt", content: "before" });
    await execute("edit", { path: "probe.txt", edits: [{ oldText: "before", newText: "after" }] });
    const readResult = await execute("read", { path: "probe.txt" });
    assert.equal(readFileSync(path.join(cwd, "probe.txt"), "utf8"), "after");
    assert.match(JSON.stringify(readResult.content), /after/);
    const outsidePath = path.join(outsideDirectory, "absolute-path.txt");
    await execute("write", { path: outsidePath, content: "outside-workspace" });
    const outsideRead = await execute("read", { path: outsidePath });
    assert.equal(readFileSync(outsidePath, "utf8"), "outside-workspace");
    assert.match(JSON.stringify(outsideRead.content), /outside-workspace/);

    let commandOutput = "";
    await authorized.session.executeBash(
      "node -e \"process.stdout.write('nova-command-ok')\"",
      (chunk) => { commandOutput += chunk; },
      { excludeFromContext: true },
    );
    assert.match(commandOutput, /nova-command-ok/);
    const infoResult = await execute("computer_info", {});
    assert.match(JSON.stringify(infoResult.content), /hostname/);
    const statusResult = await execute("nova_status", {});
    assert.match(JSON.stringify(statusResult.content), /conversations/);
    authorized.session.dispose();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outsideDirectory, { recursive: true, force: true });
  }
});
