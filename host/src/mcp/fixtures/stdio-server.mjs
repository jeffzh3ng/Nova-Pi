import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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
    properties: { alertText: { type: "string" } },
    required: name === "analyze_security_alert" ? ["alertText"] : [],
  },
}));

const server = new Server(
  { name: "nova-pi-mcp-test-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: JSON.stringify({ tool: request.params.name, ok: true }) }],
}));

await server.connect(new StdioServerTransport());
