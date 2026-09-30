import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMcpBridge, mcpToolFullName, sanitizeToolName, toolError, toolResult } from "../src/mcp.js";
import { buildMcpServer } from "../src/mcp-server.js";
import { createRoleGovernance } from "../src/role-contract.js";

function testGovernance() {
  return createRoleGovernance({ getContract: () => ({
    version: 1, revision: 1, mandate: "Exercise bridge transport with explicit test authority.",
    authority: { tools: ["doc.read", "doc.write", "inbox.list", "memory.reflect", "skill.read", "skill.propose", "prefs.propose", "only.this", "web.fetch", "web.search"].map((name) => ({ name, impact: /propose|reflect|write/.test(name) ? "internal-write" : "read" })) }
  }) });
}

function demoRegistry(overrides = {}) {
  const calls = [];
  return {
    calls,
    registry: {
      serverName: "demo",
      governance: testGovernance(),
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
  const handlers = bridge.toolHandlers({ role: "writer", toolContext: { targetRoot: process.cwd(), roleOptions: { x: 1 } }, onToolCall: (name) => seen.push(name) });
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
  const mcp = bridge.createClaudeMcp({ sdk, role: "reader", targetRoot: process.cwd(), toolContext: {} });
  assert.equal(mcp.serverName, "demo");
  assert.deepEqual(mcp.allowedTools, ["mcp__demo__doc_read"]);
  assert.equal(mcp.server.instructions, "Demo tools.");
  assert.equal(bridge.createClaudeMcp({ sdk, role: "reader", targetRoot: "", toolContext: {} }), null);
  assert.equal(bridge.createClaudeMcp({ sdk: {}, role: "reader", targetRoot: process.cwd() }), null);
  const text = bridge.claudeToolInstructions("writer", { targetRoot: process.cwd() });
  assert.match(text, /^## Demo MCP tools/);
  assert.match(text, /- doc\.write \(mcp__demo__doc_write\): Tool doc\.write/);
  assert.equal(bridge.claudeToolInstructions("writer", {}), "");
  const disabled = createMcpBridge({ ...registry, enabled: (ctx) => ctx.tools !== "off" });
  assert.equal(disabled.createClaudeMcp({ sdk, role: "reader", targetRoot: process.cwd(), toolContext: { tools: "off" } }), null);
});

test("every bridge carries the kernel's built-in crew tools unless a host overrides or opts out", async () => {
  const { mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const root = mkdtempSync(pathMod.join(os.tmpdir(), "crew-merge-"));

  const bridge = createMcpBridge({
    serverName: "hosty",
    governance: testGovernance(),
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
    governance: testGovernance(),
    crewTools: false,
    toolsForRole: () => ["only.this"],
    describe: () => "",
    inputSchema: () => ({}),
    call: async () => ({})
  });
  assert.deepEqual(optedOut.toolHandlers({ role: "ops", toolContext: { targetRoot: root } }).map((handler) => handler.toolName), ["only.this"]);

  // Web tools appear only for roles whose spec enables them.
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(pathMod.join(root, ".crew", "agents"), { recursive: true });
  writeFileSync(pathMod.join(root, ".crew", "agents", "scout.json"), JSON.stringify({ web: { allow: ["example.com"], search: false } }));
  writeFileSync(pathMod.join(root, ".crew", "agents", "surfer.json"), JSON.stringify({ web: true }));
  const bare = createMcpBridge({ serverName: "bare2", governance: testGovernance(), toolsForRole: () => [], describe: () => "", inputSchema: () => ({}), call: async () => ({}) });
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
  const names = bridge.toolHandlers({ role: "researcher", toolContext: { targetRoot: process.cwd() } })
    .map((handler) => handler.toolName);
  assert.deepEqual(names, ["skill.read"]);
  assert.equal(bridge.toolHandlers({ role: "legacy", toolContext: { targetRoot: process.cwd() } }).length, 0,
    "requireContracts fails closed for uncontracted roles");
});

test("MCP exposes no tools without a host authority policy", () => {
  const { registry } = demoRegistry({ governance: null });
  assert.deepEqual(createMcpBridge(registry).toolHandlers({ role: "writer", toolContext: {} }), []);
});

test("registered host handlers recheck revoked authority before invocation", async () => {
  let allowed = true;
  const { registry, calls } = demoRegistry({ governance: createRoleGovernance({ getContract: () => allowed ? {
    version: 1, revision: 1, mandate: "Read only while authorized.",
    authority: { tools: [{ name: "doc.read", impact: "read" }] }
  } : null }) });
  const [handler] = createMcpBridge(registry).toolHandlers({ role: "reader" });
  assert.ok(handler);
  allowed = false;
  assert.equal((await handler.invoke()).isError, true);
  assert.equal(calls.length, 0);
});
