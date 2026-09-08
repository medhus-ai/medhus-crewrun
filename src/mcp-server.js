import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function buildMcpServer({ bridge, role, toolContext, ServerClass = McpServer } = {}) {
  const server = new ServerClass(
    { name: bridge.serverName, version: "0.6.0" },
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
