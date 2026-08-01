import { fromJsonSchema, McpServer, Server } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const tools = [
  "analyze_attack_ip",
  "analyze_security_alert",
  "extract_alert_image",
  "parse_pcap_file",
].map((name) => ({
  name,
  description: `Test tool: ${name}`,
  inputSchema: {
    type: "object",
    properties: {
      alertText: { type: "string" },
      ...(name === "analyze_security_alert" ? { pcapFilePath: { type: "string" } } : {}),
    },
    required: name === "analyze_security_alert" ? ["alertText"] : [],
  },
}));

const toolResult = (name, args = {}) => {
  const result = {
    tool: name,
    ok: true,
    ...(name === "analyze_security_alert" ? { args } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
};

if (process.argv.includes("--modern")) {
  serveStdio(() => {
    const server = new McpServer(
      { name: "nova-pi-modern-mcp-test-fixture", version: "2.0.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          title: `Fixture ${tool.name}`,
          description: tool.description,
          inputSchema: fromJsonSchema(tool.inputSchema),
        },
        async (args) => toolResult(tool.name, args),
      );
    }

    let dynamicRegistered = false;
    server.registerTool(
      "add_dynamic_tool",
      {
        description: "Register another tool and publish a tools list change",
        inputSchema: fromJsonSchema({ type: "object", properties: {} }),
      },
      async () => {
        if (!dynamicRegistered) {
          dynamicRegistered = true;
          server.registerTool(
            "dynamic_tool",
            {
              description: "Tool added after the MCP connection was established",
              inputSchema: fromJsonSchema({ type: "object", properties: {} }),
            },
            async () => toolResult("dynamic_tool"),
          );
          await server.server.sendToolListChanged();
        }
        return toolResult("add_dynamic_tool");
      },
    );
    return server;
  });
} else {
  // Hand-wired stdio is intentionally the 2025-era shape. It also paginates
  // tools/list so the Nova client verifies v2's automatic aggregation while
  // exercising server/discover -> initialize fallback.
  const server = new Server(
    { name: "nova-pi-legacy-mcp-test-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async (request) => {
    if (request.params?.cursor === "page-2") return { tools: tools.slice(2) };
    return { tools: tools.slice(0, 2), nextCursor: "page-2" };
  });
  server.setRequestHandler(
    "tools/call",
    async (request) => toolResult(request.params.name, request.params.arguments),
  );

  await server.connect(new StdioServerTransport());
}
