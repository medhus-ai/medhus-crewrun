import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMcpBridge, mcpToolFullName, sanitizeToolName, toolError, toolResult } from "../src/mcp.js";
import { buildMcpServer, loadMcpAuthEnv, mcpRoleFromEnv, readMcpContextData } from "../src/mcp-stdio.js";

function demoRegistry(overrides = {}) {
  const calls = [];
  return {
    calls,
    registry: {
      serverName: "demo",
      label: "Demo",
      instructions: "Demo tools.",
      toolsForRole: (role) => (role === "reader" ? ["doc.read"] : ["doc.read", "doc.write"]),
      describe: (name) => `Tool ${name}`,
      inputSchema: (name, z) => (name === "doc.write" ? { file: z.string(), body: z.string().optional() } : {}),
      validate: (name, input) => (name === "doc.write" && !input.file ? { ok: false, error: "file is required" } : { ok: true, input }),
      call: async ({ role, toolName, input }) => { calls.push([role, toolName, input]); return { ok: true, toolName }; },
      alwaysLoad: (name) => name === "doc.read",
      stdioServerEntry: "/opt/demo/mcp-server.js",
      childEnvPassthrough: ["DEMO_DB"],
      childEnvPrefixes: ["DEMO_"],
      childAuthEnv: ["DEMO_TOKEN"],
      ...overrides
    }
  };
}

test("tool names sanitize for function calling", () => {
  assert.equal(sanitizeToolName("codebase.search_code"), "codebase_search_code");
  assert.equal(mcpToolFullName("demo", "doc.read"), "mcp__demo__doc_read");
  assert.deepEqual(toolResult("plain"), { content: [{ type: "text", text: "plain" }], structuredContent: "plain" });
  assert.equal(toolError(new Error("nope")).isError, true);
});

test("handlers validate input, invoke the registry, and report errors as MCP results", async () => {
  const { registry, calls } = demoRegistry();
  const bridge = createMcpBridge(registry);
  const seen = [];
  const handlers = bridge.toolHandlers({ role: "writer", toolContext: { targetRoot: "/repo", roleOptions: { x: 1 } }, onToolCall: (name) => seen.push(name) });
  assert.deepEqual(handlers.map((handler) => [handler.name, handler.alwaysLoad]), [["doc_read", true], ["doc_write", false]]);
  const ok = await handlers[1].invoke({ file: "a.md" });
  assert.deepEqual(ok.structuredContent, { ok: true, toolName: "doc.write" });
  assert.deepEqual(calls, [["writer", "doc.write", { file: "a.md" }]]);
  const rejected = await handlers[1].invoke({});
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /file is required/);
  assert.deepEqual(seen, ["doc.write", "doc.write"]);
  assert.equal(bridge.toolLineMarker, "[demo-tool]");
});

test("Claude in-process server and instructions follow the role allowlist", () => {
  const { registry } = demoRegistry();
  const bridge = createMcpBridge(registry);
  const sdk = {
    tool: (name, description, inputSchema, handler, extras) => ({ name, description, inputSchema, handler, extras }),
    createSdkMcpServer: (options) => ({ name: options.name, tools: options.tools, instructions: options.instructions })
  };
  const mcp = bridge.createClaudeMcp({ sdk, role: "reader", targetRoot: "/repo", toolContext: {} });
  assert.equal(mcp.serverName, "demo");
  assert.deepEqual(mcp.allowedTools, ["mcp__demo__doc_read"]);
  assert.equal(mcp.server.instructions, "Demo tools.");
  assert.equal(bridge.createClaudeMcp({ sdk, role: "reader", targetRoot: "", toolContext: {} }), null);
  assert.equal(bridge.createClaudeMcp({ sdk: {}, role: "reader", targetRoot: "/repo" }), null);
  const text = bridge.claudeToolInstructions("writer", { targetRoot: "/repo" });
  assert.match(text, /^## Demo MCP tools/);
  assert.match(text, /- doc\.write \(mcp__demo__doc_write\): Tool doc\.write/);
  assert.equal(bridge.claudeToolInstructions("writer", {}), "");
  const disabled = createMcpBridge({ ...registry, enabled: (ctx) => ctx.tools !== "off" });
  assert.equal(disabled.createClaudeMcp({ sdk, role: "reader", targetRoot: "/repo", toolContext: { tools: "off" } }), null);
});

test("Codex config writes a plain-data context file and a scoped child environment", () => {
  const { registry } = demoRegistry();
  const bridge = createMcpBridge(registry);
  const env = { PATH: "/bin", HOME: "/home/u", DEMO_DB: "/db", DEMO_EXTRA: "1", CREW_HOME: "/crew", OTHER: "no", DEMO_TOKEN: "tok" };
  const cfg = bridge.codexMcpConfig({
    role: "writer",
    targetRoot: "/repo",
    toolContext: { roleOptions: {}, secret: () => "never", workItemId: "i9" },
    env
  });
  assert.equal(cfg.available, true);
  const server = cfg.config.mcp_servers.demo;
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, ["/opt/demo/mcp-server.js"]);
  assert.equal(server.default_tools_approval_mode, "approve");
  assert.equal(server.env.CREW_MCP_ROLE, "writer");
  assert.equal(server.env.DEMO_DB, "/db");
  assert.equal(server.env.DEMO_EXTRA, "1");
  assert.equal(server.env.CREW_HOME, "/crew");
  assert.equal(server.env.OTHER, undefined);
  assert.equal(server.env.DEMO_TOKEN, undefined);
  const context = JSON.parse(readFileSync(server.env.CREW_MCP_CONTEXT_FILE, "utf8"));
  assert.deepEqual(context, { targetRoot: "/repo", root: "/repo", workItemId: "i9", roleOptions: {} });
  assert.deepEqual(JSON.parse(readFileSync(server.env.CREW_MCP_AUTH_FILE, "utf8")), { DEMO_TOKEN: "tok" });
  cfg.cleanup();
  assert.equal(existsSync(server.env.CREW_MCP_CONTEXT_FILE), false);
  assert.equal(bridge.codexMcpConfig({ role: "writer", targetRoot: null }).available, false);
  assert.equal(createMcpBridge({ ...registry, stdioServerEntry: "" }).codexMcpConfig({ role: "writer", targetRoot: "/repo" }).available, false);
});

test("stdio helpers rebuild the server and read the child environment", () => {
  const { registry } = demoRegistry();
  const bridge = createMcpBridge(registry);
  const registered = [];
  class FakeServer {
    constructor(info, options) { this.info = info; this.options = options; }
    registerTool(name, config, handler) { registered.push([name, Object.keys(config), typeof handler]); }
  }
  const built = buildMcpServer({ bridge, role: "writer", toolContext: { targetRoot: "/repo" }, ServerClass: FakeServer });
  assert.deepEqual(built.toolNames, ["doc.read", "doc.write"]);
  assert.deepEqual(registered, [["doc_read", ["description"], "function"], ["doc_write", ["description", "inputSchema"], "function"]]);
  assert.equal(built.server.info.name, "demo");

  const dir = mkdtempSync(path.join(os.tmpdir(), "crew-mcp-env-"));
  const contextFile = path.join(dir, "ctx.json");
  const authFile = path.join(dir, "auth.json");
  writeFileSync(contextFile, JSON.stringify({ targetRoot: "/repo" }));
  writeFileSync(authFile, JSON.stringify({ DEMO_TOKEN: "tok", IGNORED: "x" }));
  const env = { CREW_MCP_CONTEXT_FILE: contextFile, GITCREW_MCP_ROLE: "legacy-role", CREW_MCP_AUTH_FILE: authFile };
  assert.deepEqual(readMcpContextData(env), { targetRoot: "/repo" });
  assert.equal(mcpRoleFromEnv(env), "legacy-role");
  loadMcpAuthEnv(["DEMO_TOKEN"], env);
  assert.equal(env.DEMO_TOKEN, "tok");
  assert.equal(env.IGNORED, undefined);
  assert.deepEqual(readMcpContextData({ CREW_MCP_CONTEXT: "{\"role\":\"r\"}" }), { role: "r" });
  assert.deepEqual(readMcpContextData({ CREW_MCP_CONTEXT: "not json" }), {});
});
