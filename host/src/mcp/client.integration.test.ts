import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { connectMcpServer, disconnectMcpServer } from "./client.js";
import type { McpServerConfig } from "../rpc-protocol.js";

const repositoryRoot = path.basename(process.cwd()).toLowerCase() === "host"
  ? path.dirname(process.cwd())
  : process.cwd();

test("legacy threat-analysis FastMCP server completes stdio handshake", { timeout: 60_000 }, async () => {
  const config: McpServerConfig = {
    serviceId: "alert-analysis-mcp",
    transport: "stdio",
    commandPath: path.join(repositoryRoot, "services", "alert-analysis-mcp", "server.py"),
    commandArgs: "",
    url: "",
    enabled: true,
    launchMode: "script",
  };
  const server = await connectMcpServer(config);
  try {
    assert.deepEqual(
      server.tools.map((tool) => tool.name).sort(),
      ["analyze_attack_ip", "analyze_security_alert", "extract_alert_image", "parse_pcap_file"],
    );
    const alertTool = server.tools.find((tool) => tool.name === "analyze_security_alert");
    assert.ok(alertTool);
    const inputSchema = alertTool.inputSchema as { required?: string[] };
    assert.deepEqual(inputSchema.required, ["alertText"]);
  } finally {
    await disconnectMcpServer(server);
  }
});
