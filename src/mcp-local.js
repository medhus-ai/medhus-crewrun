import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp-server.js";
import { sanitizeToolName } from "./mcp.js";

// A turn-scoped transport for the existing host bridge. No runtime or credentials
// are reconstructed in a child; helper closures and live leases stay in the host.
export async function serveLocalMcp({ bridge, role, toolContext }) {
  const toolNames = bridge.toolHandlers({ role, toolContext }).map((h) => sanitizeToolName(h.toolName));
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const transports = new Set();
  const listener = createServer(async (req, res) => {
    const supplied = Buffer.from(String(req.headers.authorization || ""));
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end(); return;
    }
    if (req.url !== "/mcp" || req.method !== "POST" || req.headers.origin) {
      res.writeHead(405).end(); return;
    }
    try {
      const { server } = buildMcpServer({ bridge, role, toolContext });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      transports.add(server);
      res.on("close", () => { transports.delete(server); void server.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  return {
    available: true, transport: "mcp", mcp: true,
    env: { CREW_CODEX_MCP_TOKEN: token },
    config: { mcp_servers: { [bridge.serverName]: {
      url: `http://127.0.0.1:${listener.address().port}/mcp`,
      bearer_token_env_var: "CREW_CODEX_MCP_TOKEN", required: true,
      enabled_tools: toolNames,
      default_tools_approval_mode: "approve"
    } } },
    async cleanup() {
      listener.closeAllConnections();
      try { await Promise.all([...transports].map((server) => server.close())); }
      finally { await new Promise((resolve) => listener.close(resolve)); }
    }
  };
}
