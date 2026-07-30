/**
 * pi extension exposing configured MCP servers as first-class agent tools.
 *
 * This mirrors pi-mcp-adapter's embedded-host pattern: the MCP layer is loaded
 * through DefaultResourceLoader.extensionFactories, tools keep their original
 * JSON Schema, and registry changes are reflected in active sessions.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  extractMcpError,
  extractMcpModelContent,
  extractMcpPayload,
  isMcpCallError,
} from "./payload.js";
import { mcpRegistry, type RegisteredMcpTool } from "./registry.js";

function parametersFromMcp(schema: unknown): TSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return Type.Object({}, { additionalProperties: true });
  }
  // Type.Unsafe retains required/optional, oneOf/anyOf, enum, defaults, and
  // nested constraints exactly as the MCP server advertised them.
  return Type.Unsafe(schema as TSchema);
}

function stringifyForModel(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function assignRegisteredNames(tools: RegisteredMcpTool[]): Array<RegisteredMcpTool & { registeredName: string }> {
  const seen = new Set<string>();
  return tools.map((entry) => {
    const registeredName = seen.has(entry.tool.name)
      ? `${entry.serviceId}__${entry.tool.name}`
      : entry.tool.name;
    seen.add(entry.tool.name);
    return { ...entry, registeredName };
  });
}

export function createMcpExtension(allowedMcpServices: string[]): InlineExtension {
  return {
    name: "nova-mcp",
    hidden: true,
    factory(pi) {
      const knownNames = new Set<string>();
      const fingerprints = new Map<string, string>();
      let sessionStarted = false;

      const syncTools = (updateActiveTools = true) => {
        const current = assignRegisteredNames(mcpRegistry.listToolsForServices(allowedMcpServices));
        const currentNames = new Set(current.map((entry) => entry.registeredName));

        for (const entry of current) {
          const { serviceId, tool, registeredName } = entry;
          const fingerprint = JSON.stringify([serviceId, tool]);
          knownNames.add(registeredName);
          if (fingerprints.get(registeredName) === fingerprint) continue;
          fingerprints.set(registeredName, fingerprint);

          pi.registerTool({
            name: registeredName,
            label: tool.title || tool.name,
            description: tool.description || `${serviceId} MCP 工具：${tool.name}`,
            parameters: parametersFromMcp(tool.inputSchema),
            async execute(_toolCallId, args, signal) {
              const raw = await mcpRegistry.callTool(
                serviceId,
                tool.name,
                args as Record<string, unknown>,
                undefined,
                signal,
              );
              const { data, text } = extractMcpPayload(raw);
              const domainError = extractMcpError(data);
              if (isMcpCallError(raw) || domainError) {
                throw new Error(domainError || text || `MCP 工具 ${tool.name} 返回失败`);
              }
              const modelText = text || stringifyForModel(data);
              return {
                content: extractMcpModelContent(raw, modelText),
                // Keep the existing Nova front-end contract: details is the
                // unwrapped business payload, not an adapter-specific envelope.
                details: data,
              };
            },
          });
        }

        if (updateActiveTools) {
          // registerTool has no unregister counterpart. Deactivate tools removed
          // by a settings change while retaining tools owned by other extensions.
          const nextActive = pi.getActiveTools().filter((name) => !knownNames.has(name) || currentNames.has(name));
          for (const name of currentNames) {
            if (!nextActive.includes(name)) nextActive.push(name);
          }
          pi.setActiveTools(nextActive);
        }
      };

      // During extension discovery, registration APIs are available but session
      // action APIs (get/setActiveTools) are not bound yet.
      syncTools(false);
      const unsubscribe = mcpRegistry.subscribe(() => syncTools(sessionStarted));
      pi.on("session_start", () => {
        sessionStarted = true;
        syncTools(true);
      });
      pi.on("session_shutdown", () => unsubscribe());
    },
  };
}
