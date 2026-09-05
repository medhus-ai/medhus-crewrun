import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMcpBridge, mcpToolFullName, sanitizeToolName, toolError, toolResult } from "../src/mcp.js";
import { configureCrew } from "../src/crew-dirs.js";
import { buildMcpServer, loadMcpAuthEnv, mcpRoleFromEnv, readMcpContextData } from "../src/mcp-stdio.js";
import { createRoleGovernance } from "../src/role-contract.js";

function demoRegistry(overrides = {}) {
  const calls = [];
  return {
    calls,
    registry: {
      serverName: "demo",
    crewTools: false,
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
  assert.deepEqual(toolResult("plain"), { content: [{ type: "text", text: "plain" }], structuredContent: { value: "plain" } });
  assert.deepEqual(toolResult([{ id: 1 }]).structuredContent, { value: [{ id: 1 }] }, "structuredContent is always a record, never a bare array");
  assert.deepEqual(toolResult({ items: [] }).structuredContent, { items: [] }, "plain objects pass through unwrapped");
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
  const env = { CREW_MCP_CONTEXT_FILE: contextFile, LEGACY_MCP_ROLE: "legacy-role", CREW_MCP_AUTH_FILE: authFile };
  assert.deepEqual(readMcpContextData(env), { targetRoot: "/repo" });
  assert.equal(mcpRoleFromEnv(env), "", "legacy prefixes are opt-in");
  configureCrew({ legacyEnvPrefix: "LEGACY" });
  assert.equal(mcpRoleFromEnv(env), "legacy-role");
  configureCrew({ legacyEnvPrefix: "" });
  loadMcpAuthEnv(["DEMO_TOKEN"], env);
  assert.equal(env.DEMO_TOKEN, "tok");
  assert.equal(env.IGNORED, undefined);
  assert.deepEqual(readMcpContextData({ CREW_MCP_CONTEXT: "{\"role\":\"r\"}" }), { role: "r" });
  assert.deepEqual(readMcpContextData({ CREW_MCP_CONTEXT: "not json" }), {});
});

test("every bridge carries the kernel's built-in crew tools unless a host overrides or opts out", async () => {
  const { mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const root = mkdtempSync(pathMod.join(os.tmpdir(), "crew-merge-"));

  const bridge = createMcpBridge({
    serverName: "hosty",
    toolsForRole: () => ["inbox.list", "memory.reflect"],
    describe: (name) => `host ${name}`,
    inputSchema: () => ({}),
    call: async ({ toolName }) => ({ from: "host", toolName })
  });
  const handlers = bridge.toolHandlers({ role: "ops", toolContext: { targetRoot: root } });
  const names = handlers.map((handler) => handler.toolName);
  assert.deepEqual(names, ["inbox.list", "memory.reflect", "skill.read", "skill.propose", "prefs.propose"],
    "crew tools append; the host's memory.reflect overrides the built-in");
  const hostReflect = await handlers.find((handler) => handler.toolName === "memory.reflect").invoke({});
  assert.deepEqual(hostReflect.structuredContent, { from: "host", toolName: "memory.reflect" });
  const kernelReflectHandler = createMcpBridge({
    serverName: "bare",
    toolsForRole: () => [],
    describe: () => "",
    inputSchema: () => ({}),
    call: async () => ({})
  }).toolHandlers({ role: "ops", toolContext: { targetRoot: root } }).find((handler) => handler.toolName === "memory.reflect");
  assert.equal(kernelReflectHandler, undefined, "optional reflection proposals are off by default");

  const optedOut = createMcpBridge({
    serverName: "strict",
    crewTools: false,
    toolsForRole: () => ["only.this"],
    describe: () => "",
    inputSchema: () => ({}),
    call: async () => ({})
  });
  assert.deepEqual(optedOut.toolHandlers({ role: "ops", toolContext: { targetRoot: root } }).map((handler) => handler.toolName), ["only.this"]);

  // Web tools appear only for roles whose spec enables them.
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(pathMod.join(root, ".crew", "roles"), { recursive: true });
  writeFileSync(pathMod.join(root, ".crew", "roles", "scout.json"), JSON.stringify({ web: { allow: ["example.com"], search: false } }));
  writeFileSync(pathMod.join(root, ".crew", "roles", "surfer.json"), JSON.stringify({ web: true }));
  const bare = createMcpBridge({ serverName: "bare2", toolsForRole: () => [], describe: () => "", inputSchema: () => ({}), call: async () => ({}) });
  const namesOf = (role) => bare.toolHandlers({ role, toolContext: { targetRoot: root } }).map((handler) => handler.toolName);
  assert.ok(!namesOf("ops").includes("web.fetch"), "no web tools without opt-in");
  assert.deepEqual(namesOf("scout").filter((name) => name.startsWith("web.")), ["web.fetch"], "search:false drops web.search");
  assert.deepEqual(namesOf("surfer").filter((name) => name.startsWith("web.")), ["web.fetch", "web.search"]);
  const fetchImpl = async (url) => ({ status: 200, ok: true, headers: new Map([["content-type", "text/html"]]), text: async () => `<html><title>T</title><body><p>hello ${url}</p></body></html>` });
  const scoutFetch = bare.toolHandlers({ role: "scout", toolContext: { targetRoot: root, fetchImpl } }).find((handler) => handler.toolName === "web.fetch");
  const ok = await scoutFetch.invoke({ url: "https://example.com/x" });
  assert.equal(ok.structuredContent.text, "hello https://example.com/x");
  const denied = await scoutFetch.invoke({ url: "https://evil.test/x" });
  assert.equal(denied.isError, true, "allowlist enforced");
});

test("a governed bridge never registers kernel or host tools outside the role contract", () => {
  const governance = createRoleGovernance({
    requireContracts: true,
    contracts: {
      researcher: {
        version: 1,
        revision: 3,
        mandate: "Read approved reusable research guidance.",
        authority: { tools: [{ name: "skill.read", impact: "read" }] }
      }
    }
  });
  const bridge = createMcpBridge({
    serverName: "governed",
    governance,
    toolsForRole: () => ["docs.read"],
    describe: (name) => name,
    inputSchema: () => ({}),
    call: async () => ({ ok: true })
  });
  const names = bridge.toolHandlers({ role: "researcher", toolContext: { targetRoot: "/repo" } })
    .map((handler) => handler.toolName);
  assert.deepEqual(names, ["skill.read"]);
  assert.equal(bridge.toolHandlers({ role: "legacy", toolContext: { targetRoot: "/repo" } }).length, 0,
    "requireContracts fails closed for uncontracted roles");
});
