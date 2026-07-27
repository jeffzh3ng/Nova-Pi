import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createMcpExtension } from "./extension.js";
import { mcpRegistry } from "./registry.js";
import type { McpServerConfig } from "../rpc-protocol.js";

const repositoryRoot = path.basename(process.cwd()).toLowerCase() === "host"
  ? path.dirname(process.cwd())
  : process.cwd();

test("pi ResourceLoader exposes threat-analysis MCP tools as extension capabilities", { timeout: 60_000 }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "nova-pi-mcp-extension-"));
  const config: McpServerConfig = {
    serviceId: "alert-analysis-mcp",
    transport: "stdio",
    commandPath: path.join(repositoryRoot, "services", "alert-analysis-mcp", "server.py"),
    commandArgs: "",
    url: "",
    enabled: true,
    launchMode: "script",
  };

  try {
    const configured = await mcpRegistry.configure([config]);
    assert.equal(configured[0]?.ok, true, configured[0]?.error ?? "MCP 配置失败");

    const loader = new DefaultResourceLoader({
      cwd: repositoryRoot,
      agentDir,
      extensionFactories: [createMcpExtension(["alert-analysis-mcp"])],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);
    const mcp = extensions.extensions.find((extension) => extension.path === "<inline:nova-mcp>");
    assert.ok(mcp);
    assert.deepEqual(
      [...mcp.tools.keys()].sort(),
      ["analyze_attack_ip", "analyze_security_alert", "extract_alert_image", "parse_pcap_file"],
    );

    const parameters = mcp.tools.get("analyze_security_alert")?.definition.parameters as { required?: string[] };
    assert.deepEqual(parameters.required, ["alertText"]);
  } finally {
    await mcpRegistry.dispose();
    rmSync(agentDir, { recursive: true, force: true });
  }
});
