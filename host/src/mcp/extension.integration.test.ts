import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createMcpExtension, MCP_PROXY_TOOL_NAME } from "./extension.js";
import { mcpRegistry } from "./registry.js";
import type { McpServerConfig } from "../rpc-protocol.js";
import { AttachmentRuntime } from "../attachments.js";
import { DocumentRuntime } from "../document/document-runtime.js";

const repositoryRoot = path.basename(process.cwd()).toLowerCase() === "host"
  ? path.dirname(process.cwd())
  : process.cwd();
const fixturePath = path.join(repositoryRoot, "host", "src", "mcp", "fixtures", "stdio-server.mjs");

test("pi ResourceLoader exposes one lazy MCP proxy instead of every remote tool", { timeout: 60_000 }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "nova-pi-mcp-extension-"));
  const config: McpServerConfig = {
    serviceId: "alert-analysis-mcp",
    transport: "stdio",
    commandPath: process.execPath,
    commandArgs: JSON.stringify(fixturePath),
    url: "",
    enabled: true,
    launchMode: "script",
  };

  try {
    const configured = await mcpRegistry.configure([config]);
    assert.equal(configured[0]?.ok, true, configured[0]?.error ?? "MCP 配置失败");
    assert.equal(mcpRegistry.list().length, 0, "configure should not spawn MCP processes eagerly");

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
    assert.deepEqual([...mcp.tools.keys()], ["mcp"]);

    const proxy = mcp.tools.get("mcp")?.definition;
    assert.ok(proxy);

    const discovered = await proxy.execute(
      "test-discover",
      { search: "attack" },
      undefined,
      undefined,
      {} as never,
    );
    const details = discovered.details as { tools?: Array<{ tool?: string }> };
    assert.deepEqual(
      details.tools?.map((tool) => tool.tool),
      ["alert-analysis-mcp/analyze_attack_ip"],
    );
    assert.equal(mcpRegistry.list().length, 1, "first discovery should connect the bound service");
  } finally {
    await mcpRegistry.dispose();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Nova all scope discovers MCP services enabled after its session is created", { timeout: 60_000 }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "nova-pi-mcp-all-"));
  const config: McpServerConfig = {
    serviceId: "anysearch-mcp",
    transport: "stdio",
    commandPath: process.execPath,
    commandArgs: JSON.stringify(fixturePath),
    url: "",
    enabled: true,
    launchMode: "script",
  };
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    await mcpRegistry.configure([]);
    const loader = new DefaultResourceLoader({
      cwd: repositoryRoot,
      agentDir,
      extensionFactories: [createMcpExtension("all")],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    ({ session } = await createAgentSession({
      cwd: repositoryRoot,
      tools: [MCP_PROXY_TOOL_NAME],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(repositoryRoot),
    }));
    assert.equal(
      session.getActiveToolNames().includes("mcp"),
      true,
      "Nova's explicit native-tool allowlist must not suppress the MCP extension",
    );

    const configured = await mcpRegistry.configure([config]);
    assert.equal(configured[0]?.ok, true);
    assert.equal(mcpRegistry.list().length, 0, "new services remain lazy after config sync");

    const extension = loader.getExtensions().extensions.find((item) => item.path === "<inline:nova-mcp>");
    const proxy = extension?.tools.get("mcp")?.definition;
    assert.ok(proxy);
    const discovered = await proxy.execute(
      "test-all-discover",
      { search: "attack" },
      undefined,
      undefined,
      {} as never,
    );
    const details = discovered.details as { tools?: Array<{ tool?: string }> };
    assert.deepEqual(
      details.tools?.map((tool) => tool.tool),
      ["anysearch-mcp/analyze_attack_ip"],
    );
  } finally {
    session?.dispose();
    await mcpRegistry.dispose();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("qualified MCP calls connect only the requested service", { timeout: 60_000 }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "nova-pi-mcp-targeted-"));
  const configs: McpServerConfig[] = ["target-mcp", "unrelated-mcp"].map((serviceId) => ({
    serviceId,
    transport: "stdio",
    commandPath: process.execPath,
    commandArgs: JSON.stringify(fixturePath),
    url: "",
    enabled: true,
    launchMode: "script",
  }));

  try {
    await mcpRegistry.configure(configs);
    const loader = new DefaultResourceLoader({
      cwd: repositoryRoot,
      agentDir,
      extensionFactories: [createMcpExtension("all")],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const proxy = loader.getExtensions().extensions
      .find((item) => item.path === "<inline:nova-mcp>")
      ?.tools.get("mcp")?.definition;
    assert.ok(proxy);

    await assert.rejects(
      proxy.execute(
        "test-unqualified-call",
        { tool: "analyze_attack_ip", args: {} },
        undefined,
        undefined,
        {} as never,
      ),
      /完整 service\/tool 名称/,
    );
    assert.equal(mcpRegistry.list().length, 0, "an unqualified tool name must not trigger broad discovery");

    const called = await proxy.execute(
      "test-targeted-call",
      { tool: "target-mcp/analyze_attack_ip", args: {} },
      undefined,
      undefined,
      {} as never,
    );
    assert.equal((called.details as { serviceId?: string }).serviceId, "target-mcp");
    assert.deepEqual(
      mcpRegistry.list().map((server) => server.config.serviceId),
      ["target-mcp"],
      "a qualified call must not connect unrelated enabled services",
    );
  } finally {
    await mcpRegistry.dispose();
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("MCP attachments are injected only when explicitly referenced", { timeout: 60_000 }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "nova-pi-mcp-attachment-agent-"));
  const uploadRoot = mkdtempSync(path.join(tmpdir(), "nova-pi-mcp-attachment-root-"));
  const filePath = path.join(uploadRoot, "alert.png");
  writeFileSync(filePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const attachments = new AttachmentRuntime(uploadRoot);
  await attachments.buildPrompt("分析截图", {
    files: [{ name: "alert.png", path: filePath, ext: "png" }],
  });
  const documents = new DocumentRuntime(attachments);
  const config: McpServerConfig = {
    serviceId: "anysearch-mcp",
    transport: "stdio",
    commandPath: process.execPath,
    commandArgs: JSON.stringify(fixturePath),
    url: "",
    enabled: true,
    launchMode: "script",
  };

  try {
    await mcpRegistry.configure([config]);
    const loader = new DefaultResourceLoader({
      cwd: repositoryRoot,
      agentDir,
      extensionFactories: [createMcpExtension(["anysearch-mcp"], attachments, undefined, documents)],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const proxy = loader.getExtensions().extensions
      .find((item) => item.path === "<inline:nova-mcp>")
      ?.tools.get("mcp")?.definition;
    assert.ok(proxy);

    const documentFile = await documents.resolve("alert.png");
    assert.ok(documentFile);
    documents.markNeedsOcr(documentFile);

    const implicit = await proxy.execute(
      "test-no-implicit-attachment",
      {
        tool: "anysearch-mcp/analyze_security_alert",
        args: { alertText: "suspicious traffic" },
      },
      undefined,
      undefined,
      {} as never,
    );
    assert.deepEqual(
      (implicit.details as { result?: { args?: Record<string, unknown> } }).result?.args,
      { alertText: "suspicious traffic" },
    );

    const explicit = await proxy.execute(
      "test-explicit-attachment",
      {
        tool: "anysearch-mcp/analyze_security_alert",
        args: { alertText: "suspicious traffic" },
        attachment: "alert.png",
      },
      undefined,
      undefined,
      {} as never,
    );
    assert.deepEqual(
      (explicit.details as { result?: { args?: Record<string, unknown> } }).result?.args,
      { alertText: "suspicious traffic", pcapFilePath: filePath },
    );
  } finally {
    await mcpRegistry.dispose();
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(uploadRoot, { recursive: true, force: true });
  }
});
