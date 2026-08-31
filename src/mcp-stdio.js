import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { crewEnv } from "./crew-dirs.js";

// Child-process side of the Codex MCP transport. The host's entry script reconstructs its tool
// context from the serialized data and calls serveStdio with its bridge.
export function buildMcpServer({ bridge, role, toolContext, ServerClass = McpServer } = {}) {
  const server = new ServerClass(
    { name: bridge.serverName, version: "0.1.0" },
    { instructions: bridge.registry.instructions || `${bridge.label} internal tools. Respect role permissions; report authorization errors instead of bypassing them.` }
  );
  const handlers = bridge.toolHandlers({ role, toolContext });
  for (const handler of handlers) {
    const config = { description: handler.description };
    if (Object.keys(handler.inputSchema || {}).length > 0) config.inputSchema = handler.inputSchema;
    server.registerTool(handler.name, config, (args) => handler.invoke(args || {}));
  }
  return { server, handlers, toolNames: handlers.map((handler) => handler.toolName) };
}

export function mcpRoleFromEnv(env = process.env) {
  return crewEnv("MCP_ROLE", env) || "";
}

export function readMcpContextData(env = process.env) {
  const file = crewEnv("MCP_CONTEXT_FILE", env);
  if (file) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  }
  try {
    return JSON.parse(crewEnv("MCP_CONTEXT", env) || "{}");
  } catch {
    return {};
  }
}

// Copies the listed keys from the auth file the parent wrote; missing file means no remote auth.
export function loadMcpAuthEnv(keys = [], env = process.env) {
  const file = crewEnv("MCP_AUTH_FILE", env);
  if (!file) return;
  try {
    const auth = JSON.parse(readFileSync(file, "utf8"));
    for (const key of keys) {
      if (typeof auth[key] === "string" && auth[key]) env[key] = auth[key];
    }
  } catch {
    // Remote tools report their normal unavailable-auth error.
  }
}

export async function serveStdio({ bridge, role, toolContext }) {
  const built = buildMcpServer({ bridge, role, toolContext });
  await built.server.connect(new StdioServerTransport());
  return built;
}
