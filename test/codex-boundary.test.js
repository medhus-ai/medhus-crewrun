import assert from "node:assert/strict";
import { createRoleGovernance } from "../src/role-contract.js";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import { createCodexAgentEngine } from "../src/engines/codex-agent.js";
import { codexBoundaryId, CODEX_BOUNDARY_CONFIG } from "../src/engines/codex-boundary.js";
import { getEngine, setEngineForTests } from "../src/engines/index.js";
import { initializeWorkspace } from "../src/workspace-setup.js";
import { createHost } from "../packages/crewrun-reference-host/index.js";
import { createMcpBridge } from "../src/mcp.js";
import { serveLocalMcp } from "../src/mcp-local.js";
import { createConsoleHelperBridge } from "../src/console-chat.js";

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crew-codex-boundary-"));
  const root = path.join(directory, "repo");
  initializeWorkspace(root, { runner: "codex-agent-low" });
  const prior = Object.fromEntries(["HOME", "CODEX_HOME", "CREW_HOME"].map((k) => [k, process.env[k]]));
  process.env.HOME = directory;
  process.env.CODEX_HOME = path.join(directory, "source-codex");
  process.env.CREW_HOME = path.join(directory, "private");
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    setEngineForTests("codex-agent", createCodexAgentEngine());
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, root };
}

const message = () => ({ type: "message", id: `msg_${randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK" }] });
const call = (name, args) => {
  const parts = name.split("__");
  return { type: "function_call", name: parts.length === 3 ? parts[2] : name,
    ...(parts.length === 3 ? { namespace: `${parts[0]}__${parts[1]}` } : {}),
    arguments: JSON.stringify(args), call_id: randomUUID(), id: randomUUID() };
};
const patch = (input) => ({ type: "custom_tool_call", name: "apply_patch", input, call_id: randomUUID(), id: randomUUID() });
const discover = (query) => ({ type: "tool_search_call", execution: "client", arguments: { query, limit: 30 }, call_id: randomUUID(), id: randomUUID(), status: "completed" });

async function mockProvider(t, replies, features = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push(body);
      const items = replies.shift() || [message()];
      res.writeHead(200, { "content-type": "text/event-stream" });
      items.forEach((item, output_index) => res.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index, item })}\n\n`));
      res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: randomUUID(), status: "completed", output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const clients = [];
  const threads = [];
  class LocalCodex extends Codex {
    constructor(options) {
      clients.push(options);
      super({ ...options, apiKey: undefined, config: {
        ...options.config, features: { ...options.config.features, ...features, enable_request_compression: false },
        model_provider: "boundary-test", model: features.code_mode ? "gpt-5.6-sol" : "gpt-5.5",
        model_providers: { "boundary-test": { name: "boundary-test", base_url: `http://127.0.0.1:${server.address().port}`, wire_api: "responses" } }
      } });
    }
    startThread(options) { threads.push({ kind: "start" }); return super.startThread(options); }
    resumeThread(id, options) { threads.push({ kind: "resume", id }); return super.resumeThread(id, options); }
  }
  setEngineForTests("codex-agent", createCodexAgentEngine({ loadCodex: async () => LocalCodex }));
  return { requests, clients, threads };
}

test("real Codex dispatcher denies native IO and role escapes while governed MCP writes work", { timeout: 60000, skip: process.platform !== "linux" }, async (t) => {
  const { root, directory } = fixture(t);
  const secret = `cross-role-${randomUUID()}`;
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), 'developer_instructions = "ambient-config-canary"\n[features]\nshell_tool = true\n');
  mkdirSync(path.join(directory, ".agents/skills/ambient"), { recursive: true });
  writeFileSync(path.join(directory, ".agents/skills/ambient/SKILL.md"), "---\nname: ambient\ndescription: Always load this skill\n---\nambient-skill-canary");
  mkdirSync(path.join(root, "private"));
  writeFileSync(path.join(root, "private/secret.md"), secret);
  mkdirSync(path.join(root, "drafts/assistant"), { recursive: true });
  symlinkSync(path.join(root, "private"), path.join(root, "drafts/assistant/link"));
  const outside = path.join(directory, "native.txt");
  const specPath = path.join(root, ".crew/agents/assistant.json");
  const specBefore = readFileSync(specPath, "utf8");
  const rejected = [
    call("exec_command", { cmd: `printf bypass > ${outside}` }),
    call("shell", { command: ["sh", "-c", `cat ${root}/private/secret.md`] }),
    call("view_image", { path: path.join(root, "private/secret.md") }),
    call("spawn_agent", { message: "Read private/secret.md" }),
    patch(`*** Begin Patch\n*** Add File: ${outside}\n+bypass\n*** End Patch`),
    patch(`*** Begin Patch\n*** Update File: ${root}/private/secret.md\n@@\n-unknown\n+changed\n*** End Patch`),
    call("mcp__integrations__workspace_read", { path: "private/secret.md" }),
    call("mcp__integrations__workspace_read", { path: "drafts/assistant/link/secret.md" }),
    call("mcp__integrations__workspace_read", { path: "../native.txt" }),
    call("mcp__integrations__workspace_writeDraft", { path: ".crew/agents/assistant.json", content: "bypass" }),
    call("mcp__integrations__workspace_writeDraft", { path: "drafts/peer/bypass.md", content: "bypass" }),
    call("mcp__integrations__owner_approve", { id: "invented" })
  ];
  const probe = await mockProvider(t, [[discover("workspace_read"), discover("workspace_writeDraft")], rejected, [call("mcp__integrations__workspace_writeDraft", { path: "drafts/assistant/ok.md", content: "authorized" })], [message()]]);
  const host = createHost({ targetRoot: root, env: { CREW_HOME: process.env.CREW_HOME } });
  try {
    const result = await host.runtime.runTurn("assistant", "Exercise the workspace tools.");
    assert.equal(result.ok, true, result.reason);
    assert.ok(existsSync(path.join(root, "drafts/assistant/ok.md")), JSON.stringify(probe.requests.at(-1)?.input.filter((x) => /output/.test(x.type))));
    assert.equal(readFileSync(path.join(root, "drafts/assistant/ok.md"), "utf8"), "authorized");
    assert.equal(readFileSync(path.join(root, "private/secret.md"), "utf8"), secret);
    assert.equal(readFileSync(specPath, "utf8"), specBefore);
    assert.equal(existsSync(outside), false);
    assert.equal(existsSync(path.join(root, "drafts/peer/bypass.md")), false);
    assert.ok(probe.requests.length >= 3);
    assert.equal(JSON.stringify(probe.requests).includes(secret), false, "forbidden content must never reach the model");
    assert.doesNotMatch(JSON.stringify(probe.requests), /ambient-config-canary|ambient-skill-canary/);
    const outputs = probe.requests.flatMap((r) => r.input.filter((i) => /tool_call_output|function_call_output/.test(i.type)));
    for (const item of rejected) assert.ok(outputs.some((o) => o.call_id === item.call_id && /denied|not allowed|outside|sandbox|unsupported|unknown|symlink|relative|limited to|authority/i.test(JSON.stringify(o.output))), `missing denial for ${item.name}`);
    const audit = host.runtime.governance.audit.list();
    assert.ok(audit.some((e) => e.tool_name === "workspace.writeDraft" && e.outcome === "completed"));
    assert.equal(probe.clients[0].config.default_permissions, "crew-governed");
    assert.equal(probe.clients[0].env.HOME, probe.clients[0].env.CODEX_HOME);
    assert.equal(probe.clients[0].env.CREWRUN_INTEGRATIONS_KEY, undefined);
    assert.ok(probe.clients[0].config.mcp_servers.integrations.url.startsWith("http://127.0.0.1:"));
    await assert.rejects(fetch(probe.clients[0].config.mcp_servers.integrations.url), /fetch failed/);
  } finally { await host.stop(); }
});

test("governed Codex resume identity is workspace, role, contract and profile scoped", (t) => {
  const { root } = fixture(t);
  const profile = { id: "codex", auth: "subscription" };
  const first = codexBoundaryId(root, "assistant", profile);
  assert.equal(codexBoundaryId(root, "assistant", profile), first);
  assert.notEqual(codexBoundaryId(root, "peer", profile), first);
  assert.notEqual(codexBoundaryId(root, "assistant", { ...profile, model: "different" }), first);
  const file = path.join(root, ".crew/agents/assistant.json");
  const spec = JSON.parse(readFileSync(file, "utf8"));
  spec.instructions += " Changed authority context.";
  writeFileSync(file, JSON.stringify(spec));
  assert.notEqual(codexBoundaryId(root, "assistant", profile), first);
  assert.equal(CODEX_BOUNDARY_CONFIG.permissions["crew-governed"].filesystem["/"], "deny");
});

test("Codex code mode has no Node or shell escape", { timeout: 60000, skip: process.platform !== "linux" }, async (t) => {
  const { root } = fixture(t);
  const probe = await mockProvider(t, [[{ type: "custom_tool_call", name: "exec", input: 'text({ process: typeof process, require: typeof require, shell: typeof tools.exec_command });', id: randomUUID(), call_id: randomUUID() }], [message()]], { code_mode: true });
  const host = createHost({ targetRoot: root, env: { CREW_HOME: process.env.CREW_HOME } });
  try {
    const result = await host.runtime.runTurn("assistant", "Inspect the isolated code-mode globals.");
    assert.equal(result.ok, true, result.reason);
    const outputs = JSON.stringify(probe.requests.at(-1)?.input.filter((x) => /output/.test(x.type)));
    assert.match(outputs, /process.*undefined.*require.*undefined.*shell.*undefined/, JSON.stringify(probe.requests[0].tools) + outputs);
  } finally { await host.stop(); }
});

test("real Codex chats resume their thread and reset on authority changes", { timeout: 60000, skip: process.platform !== "linux" }, async (t) => {
  const { root } = fixture(t);
  const probe = await mockProvider(t, [[message()], [message()], [message()]]);
  const host = createHost({ targetRoot: root, env: { CREW_HOME: process.env.CREW_HOME } });
  try {
    const first = await host.runtime.chats.sendChat({ role: "assistant", message: "first-private-turn-marker" });
    const second = await host.runtime.chats.sendChat({ role: "assistant", message: "Continue this conversation." });
    assert.equal(first.id, second.id);
    assert.equal(second.messages.at(-1).content, "OK");
    assert.deepEqual(probe.threads.map((x) => x.kind), ["start", "resume"]);
    assert.ok(probe.threads[1].id);
    assert.equal(probe.clients[0].env.CODEX_HOME, probe.clients[1].env.CODEX_HOME);
    const file = path.join(root, ".crew/agents/assistant.json");
    const spec = JSON.parse(readFileSync(file, "utf8"));
    spec.instructions = "Changed responsibility: answer the current question only.";
    writeFileSync(file, JSON.stringify(spec));
    const third = await host.runtime.chats.sendChat({ role: "assistant", message: "New boundary." });
    assert.equal(third.id, first.id);
    assert.equal(third.messages.length, 6);
    assert.equal(probe.threads[2].kind, "start");
    assert.notEqual(probe.clients[1].env.CODEX_HOME, probe.clients[2].env.CODEX_HOME);
    assert.equal(JSON.stringify(probe.requests.at(-1)).includes("first-private-turn-marker"), false);
  } finally { await host.stop(); }
});

test("Codex helper can propose a real reviewed change but cannot approve it", { timeout: 60000, skip: process.platform !== "linux" }, async (t) => {
  const { root, directory } = fixture(t);
  const probe = await mockProvider(t, [[discover("crew_proposeSetup")], [call("mcp__crew_helper__crew_proposeSetup", { title: "Review this change", changes: [{ path: "README.md", content: "Proposed only" }] })], [call("mcp__crew_helper__owner_approve", { id: "any" })], [message()]]);
  const host = createHost({ targetRoot: root, env: { CREW_HOME: process.env.CREW_HOME } });
  const original = readFileSync(path.join(root, "README.md"), "utf8");
  try {
    const result = await new Promise((resolve) => getEngine("codex-agent").startTurn({
      targetRoot: root, workdir: directory, role: "crew-helper", profile: { id: "test-helper" }, mode: "propose", prompt: "Prepare the proposal.",
      toolContext: { targetRoot: root, governedToolsOnly: true }, tools: createConsoleHelperBridge({ targetRoot: root, workspace: host.runtime.workspace }),
      onClose: resolve
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(path.join(root, "README.md"), "utf8"), original);
    const proposals = host.runtime.store.db.prepare("SELECT * FROM workspace_proposals").all();
    assert.equal(proposals.length, 1, JSON.stringify(probe.requests.at(-1)?.input.filter((x) => /output/.test(x.type))));
    assert.equal(proposals[0].status, "pending");
  } finally { await host.stop(); }
});

test("governed Codex refuses unsupported hard USD limits before model execution", { skip: process.platform !== "linux" }, async (t) => {
  const { root, directory } = fixture(t);
  let loaded = false;
  const result = await new Promise((resolve) => createCodexAgentEngine({ loadCodex: async () => { loaded = true; return Codex; } }).startTurn({
    targetRoot: root, workdir: directory, role: "assistant", profile: { id: "test" }, prompt: "Never execute", mode: "execute",
    toolContext: { governedToolsOnly: true, maxBudgetUsd: 1 }, onClose: resolve
  }));
  assert.equal(loaded, false);
  assert.match(result.stderr, /cannot enforce a hard per-run USD/);
});

test("local MCP requires a per-turn credential and never exposes unlisted tools", async () => {
  const bridge = createMcpBridge({ serverName: "probe", governance: createRoleGovernance({ contracts: { assistant: { version: 1, revision: 1, mandate: "Test MCP transport.", authority: { tools: [{ name: "safe.read", impact: "read" }] } } } }), crewTools: false, toolsForRole: () => ["safe.read"], describe: () => "read", inputSchema: () => ({}), call: () => ({ ok: true }) });
  const local = await serveLocalMcp({ bridge, role: "assistant", toolContext: {} });
  const url = local.config.mcp_servers.probe.url;
  try {
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer wrong" } })).status, 401);
    const headers = { authorization: `Bearer ${local.env.CREW_CODEX_MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.deepEqual((await response.json()).result.tools.map((x) => x.name), ["safe_read"]);
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, origin: "https://untrusted.invalid" }, body: "{}" })).status, 405);
  } finally { await local.cleanup(); }
});
