import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { callMcpToolWithTimeout, connectMcpServer, disconnectMcpServer } from "./client.js";
import type { McpServerConfig } from "../rpc-protocol.js";

const repositoryRoot = path.basename(process.cwd()).toLowerCase() === "host"
  ? path.dirname(process.cwd())
  : process.cwd();
const fixturePath = path.join(repositoryRoot, "host", "src", "mcp", "fixtures", "stdio-server.mjs");

test("self-contained MCP fixture completes stdio handshake", { timeout: 60_000 }, async () => {
  const config: McpServerConfig = {
    serviceId: "alert-analysis-mcp",
    transport: "stdio",
    commandPath: process.execPath,
    commandArgs: JSON.stringify(fixturePath),
    url: "",
    enabled: true,
    launchMode: "script",
  };
  const server = await connectMcpServer(config);
  try {
    assert.equal(server.protocolEra, "legacy");
    assert.deepEqual(
      server.tools.map((tool) => tool.name).sort(),
      ["analyze_attack_ip", "analyze_security_alert", "extract_alert_image", "parse_pcap_file"],
    );
    const alertTool = server.tools.find((tool) => tool.name === "analyze_security_alert");
    assert.ok(alertTool);
    const inputSchema = alertTool.inputSchema as { required?: string[] };
    assert.deepEqual(inputSchema.required, ["alertText"]);
    const result = await callMcpToolWithTimeout(server, "analyze_security_alert", { alertText: "test" }, 10);
    assert.deepEqual(result.structuredContent, {
      tool: "analyze_security_alert",
      ok: true,
      args: { alertText: "test" },
    });
  } finally {
    await disconnectMcpServer(server);
  }
});

test("negotiates the 2026 stdio era and refreshes tools through subscriptions/listen", { timeout: 60_000 }, async () => {
  const config: McpServerConfig = {
    serviceId: "modern-fixture-mcp",
    transport: "stdio",
    commandPath: process.execPath,
    commandArgs: `${JSON.stringify(fixturePath)} --modern`,
    url: "",
    enabled: true,
    launchMode: "script",
  };
  const server = await connectMcpServer(config);
  try {
    assert.equal(server.protocolEra, "modern");
    assert.ok(server.tools.some((tool) => tool.name === "add_dynamic_tool"));
    assert.equal(server.tools.some((tool) => tool.name === "dynamic_tool"), false);

    await callMcpToolWithTimeout(server, "add_dynamic_tool", {}, 10);
    await waitFor(() => server.tools.some((tool) => tool.name === "dynamic_tool"));
    assert.ok(server.tools.some((tool) => tool.name === "dynamic_tool"));
  } finally {
    await disconnectMcpServer(server);
  }
});

test("negotiates the 2026 era over Streamable HTTP", { timeout: 60_000 }, async () => {
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: "nova-pi-http-fixture", version: "2.0.0" });
    mcp.registerTool(
      "http_fixture_tool",
      {
        title: "HTTP fixture tool",
        inputSchema: fromJsonSchema({ type: "object", properties: {} }),
      },
      async () => ({
        content: [{ type: "text", text: "ok" }],
        structuredContent: ["streamable-http", true],
      }),
    );
    return mcp;
  });
  const httpServer = createWebHandlerServer((request) => handler.fetch(request));
  const url = await listen(httpServer);
  const config: McpServerConfig = {
    serviceId: "modern-http-fixture-mcp",
    transport: "http",
    commandPath: "",
    commandArgs: "",
    url,
    enabled: true,
    launchMode: "script",
  };

  let server: Awaited<ReturnType<typeof connectMcpServer>> | undefined;
  try {
    server = await connectMcpServer(config);
    assert.equal(server.transportKind, "streamable-http");
    assert.equal(server.protocolEra, "modern");
    const result = await callMcpToolWithTimeout(server, "http_fixture_tool", {}, 10);
    assert.deepEqual(result.structuredContent, ["streamable-http", true]);
  } finally {
    if (server) await disconnectMcpServer(server);
    await close(httpServer);
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP tool list refresh");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function createWebHandlerServer(fetchHandler: (request: Request) => Promise<Response>): HttpServer {
  return createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const address = request.headers.host ?? "127.0.0.1";
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else if (value !== undefined) {
          headers.set(name, value);
        }
      }
      const webRequest = new Request(`http://${address}${request.url ?? "/mcp"}`, {
        method: request.method,
        headers,
        body: body.length > 0 ? body : undefined,
      });
      const webResponse = await fetchHandler(webRequest);
      response.statusCode = webResponse.status;
      webResponse.headers.forEach((value, name) => response.setHeader(name, value));
      if (!webResponse.body) {
        response.end();
        return;
      }
      const reader = webResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(value);
      }
      response.end();
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
}

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP port");
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function close(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
