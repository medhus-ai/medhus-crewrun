import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "crew-engines-test-"));
process.env.CREW_RUNNERS_FILE = path.join(tmpRoot, "ai-runners.json");
process.env.CREW_HOME = path.join(tmpRoot, "home");

const { ENGINE_IDS, getEngine, setEngineForTests } = await import("../src/engines/index.js");
const { createClaudeAgentEngine } = await import("../src/engines/claude-agent.js");
const { createCodexAgentEngine } = await import("../src/engines/codex-agent.js");
const { saveGlobalRunnerConfig, checkGlobalRunner } = await import("../src/runner-config.js");
const { createRoleRunner } = await import("../src/runner.js");
const { createMcpBridge } = await import("../src/mcp.js");
const { createRoleGovernance } = await import("../src/role-contract.js");

after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const OK_RESULT = { type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };

function fakeClaudeQuery(captured, messages) {
  return async function* query({ prompt, options }) {
    captured.prompt = prompt;
    captured.options = options;
    yield* messages;
  };
}

function fakeClaudeSdk(captured, messages) {
  return {
    query: fakeClaudeQuery(captured, messages),
    tool(name, description, inputSchema, handler, extras) {
      return { name, description, inputSchema, handler, extras };
    },
    createSdkMcpServer(options) {
      return { type: "sdk", name: options.name, instance: { tools: options.tools } };
    }
  };
}

function demoBridge() {
  return createMcpBridge({
    governance: createRoleGovernance({ getContract: () => ({ version: 1, revision: 1, mandate: "Test engine tool transport.", authority: { tools: [{ name: "doc.read", impact: "read" }, { name: "doc.write", impact: "internal-write" }] } }) }),
    serverName: "demo",
    crewTools: false,
    label: "Demo",
    toolLineMarker: "[demo-tool]",
    toolsForRole: (role) => (role === "reader" ? ["doc.read"] : ["doc.read", "doc.write"]),
    describe: (name) => `Tool ${name}`,
    inputSchema: () => ({}),
    call: async () => ({ ok: true }),
    stdioServerEntry: path.join(tmpRoot, "demo-mcp-server.js")
  });
}

function runClaude(engine, input) {
  return new Promise((resolve, reject) => {
    engine.startTurn({ profile: { id: "x" }, workdir: "/tmp/anywhere", role: "planner", mode: "propose", prompt: "p", onClose: resolve, onError: reject, ...input });
  });
}

test("engine registry rejects retired CLI and unknown engines", () => {
  assert.deepEqual(ENGINE_IDS, ["claude-agent", "codex-agent"]);
  assert.throws(() => getEngine("cli"), /Unsupported v6 engine/);
  assert.throws(() => getEngine("not-an-engine"), /Unsupported v6 engine/);
  assert.equal(getEngine("claude-agent").id, "claude-agent");
  assert.equal(getEngine("codex-agent").id, "codex-agent");
});

test("claude-agent engine streams partial text without changing final output", async () => {
  const captured = {};
  const engine = createClaudeAgentEngine({
    loadQuery: async () => fakeClaudeQuery(captured, [
      { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "line one" } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "\nline two" } } },
      { type: "stream_event", parent_tool_use_id: "toolu-subagent", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "not parent text" } } },
      { type: "assistant", message: { content: [{ type: "text", text: "line one\nline two" }, { type: "tool_use", name: "Read" }] } },
      { type: "result", subtype: "success", is_error: false, result: "line one\nline two", total_cost_usd: 0.0123, usage: { input_tokens: 100, output_tokens: 25 } }
    ])
  });
  const lines = [];
  const partial = [];
  const closed = await runClaude(engine, {
    profile: { id: "claude-agent-sonnet-high", model: "sonnet", reasoning_effort: "high" },
    systemPrompt: "system!",
    prompt: "hello",
    onLine: (line) => lines.push(line),
    onPartialText: (text) => partial.push(text)
  });
  assert.deepEqual(lines, ["line one", "line two", "[tool] Read"]);
  assert.deepEqual(partial, ["line one", "\nline two"]);
  assert.equal(closed.code, 0);
  assert.deepEqual(closed.usage, { inputTokens: 100, outputTokens: 25, costUsd: 0.0123 });
  assert.equal(captured.options.model, "sonnet");
  assert.equal(captured.options.effort, "high");
  assert.equal(captured.options.systemPrompt, "system!");
  assert.equal(captured.options.permissionMode, "dontAsk");
  assert.deepEqual(captured.options.tools, []);
  assert.equal(captured.options.mcpServers, undefined);
  assert.equal(captured.options.includePartialMessages, true);
});

test("old execute, shell, web and subagent flags cannot grant Claude native tools", async () => {
  const captured = {};
  await runClaude(createClaudeAgentEngine({ loadQuery: async () => fakeClaudeQuery(captured, [OK_RESULT]) }), {
    profile: { id: "x", allow_shell: true }, mode: "execute", role: "engineer",
    capabilities: { subagents: { allowed: true, writable: true } },
    toolContext: { nativeWeb: true, web: { search: true, allow: [] } }
  });
  assert.deepEqual(captured.options.tools, []);
  assert.deepEqual(captured.options.allowedTools, []);
  assert.equal(captured.options.agents, undefined);
  assert.equal(captured.options.permissionMode, "dontAsk");
});

test("claude-agent engine wires host MCP tools only through an injected bridge", async () => {
  const root = path.join(tmpRoot, "claude-mcp-root");
  await mkdir(root, { recursive: true });
  const captured = {};
  const lines = [];
  const engine = createClaudeAgentEngine({ loadSdk: async () => fakeClaudeSdk(captured, [OK_RESULT]) });
  await runClaude(engine, { targetRoot: root, workdir: root, role: "reader", systemPrompt: "system!", tools: demoBridge(), onLine: (line) => lines.push(line) });
  assert.ok(captured.options.mcpServers.demo);
  assert.equal(captured.options.strictMcpConfig, true);
  assert.deepEqual(captured.options.allowedTools, ["mcp__demo__doc_read"]);
  assert.match(captured.options.systemPrompt, /^system!\n\n## Demo MCP tools/);
  assert.match(captured.options.systemPrompt, /doc\.read \(mcp__demo__doc_read\)/);

  const bare = {};
  await runClaude(createClaudeAgentEngine({ loadSdk: async () => fakeClaudeSdk(bare, [OK_RESULT]) }), { targetRoot: root, workdir: root, role: "reader", systemPrompt: "system!" });
  assert.equal(bare.options.mcpServers, undefined);
  assert.equal(bare.options.systemPrompt, "system!");
});

test("claude-agent engine surfaces SDK failures and passes resume ids", async () => {
  const errors = [];
  const failed = await new Promise((resolve) => {
    createClaudeAgentEngine({ loadQuery: async () => async function* () { throw new Error("not logged in"); } })
      .startTurn({ profile: { id: "x" }, workdir: "/tmp", role: "planner", mode: "propose", prompt: "p", onError: (error) => errors.push(error), onClose: resolve });
  });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /not logged in/);
  assert.equal(errors.length, 1);

  const captured = {};
  const closed = await runClaude(
    createClaudeAgentEngine({ loadQuery: async () => fakeClaudeQuery(captured, [{ ...OK_RESULT, session_id: "sess-new" }]) }),
    { resumeSessionId: "sess-old" }
  );
  assert.equal(captured.options.resume, "sess-old");
  assert.equal(closed.engineSessionId, "sess-new");
});

test("codex-agent engine resumes threads and reports the thread id", { skip: process.platform !== "linux" && "Governed Codex is verified on Linux only." }, async () => {
  const captured = {};
  class FakeCodex {
    startThread(options) { captured.started = options; return makeThread("thread-new"); }
    resumeThread(id, options) { captured.resumed = { id, options }; return makeThread(id); }
  }
  function makeThread(threadId) {
    return {
      async runStreamed(prompt) {
        captured.prompt = prompt;
        async function* events() {
          yield { type: "thread.started", thread_id: threadId };
          yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
        }
        return { events: events() };
      }
    };
  }
  const engine = createCodexAgentEngine({ loadCodex: async () => FakeCodex });
  const closed = await new Promise((resolve, reject) => {
    engine.startTurn({ targetRoot: tmpRoot, profile: { id: "x" }, workdir: tmpRoot, role: "planner", mode: "propose", systemPrompt: "system stuff", prompt: "just the new message", resumeSessionId: "thread-42", onClose: resolve, onError: reject });
  });
  assert.equal(captured.resumed.id, "thread-42");
  assert.equal(captured.started, undefined);
  assert.equal(captured.prompt, "just the new message");
  assert.equal(closed.engineSessionId, "thread-42");
});

test("runner profiles validate engines and checks dispatch to the engine healthcheck", async () => {
  const saved = saveGlobalRunnerConfig({
    runners: [
      { id: "agent-profile", engine: "claude-agent", model: "sonnet", reasoning_effort: "high" },
      { id: "codex-profile", engine: "codex-agent" }
    ]
  });
  assert.equal(saved.runners[0].engine, "claude-agent");
  assert.equal(saved.runners[0].mode, "propose");
  assert.equal(saved.runners[1].engine, "codex-agent");
  assert.throws(() => saveGlobalRunnerConfig({ runners: [{ id: "bad", engine: "skynet", command: "x" }] }), /unknown engine/);
  assert.throws(() => saveGlobalRunnerConfig({ runners: [{ id: "bad-cli", engine: "cli" }] }), /unknown engine/);

  setEngineForTests("claude-agent", { id: "claude-agent", capabilities: {}, async healthcheck(profile) { return { ok: true, status: "pass", message: `checked ${profile.id}` }; } });
  try {
    assert.equal((await checkGlobalRunner("agent-profile")).message, "checked agent-profile");
  } finally {
    setEngineForTests("claude-agent", null);
  }
});

async function projectWithRole(name, role, runnerId, files = {}) {
  const target = path.join(tmpRoot, name);
  await mkdir(path.join(target, ".crew/agents"), { recursive: true });
  await mkdir(path.join(target, ".crew/memory"), { recursive: true });
  await writeFile(path.join(target, ".crew/workspace.json"), JSON.stringify({ version: 1, id: "engine-test-workspace" }));
  await writeFile(path.join(target, `.crew/agents/${role}.json`), JSON.stringify({ runner: runnerId, instructions: `# ${role} role`, contract: { version: 1 } }));
  for (const [rel, body] of Object.entries(files)) await writeFile(path.join(target, ".crew", rel), body, "utf8");
  return target;
}

test("runRoleCapture drops tool noise and resolves ok:false on failure instead of rejecting", async (t) => {
  const target = await projectWithRole("capture-project", "ceo", "test-claude-capture");
  saveGlobalRunnerConfig({ runners: [{ id: "test-claude-capture", engine: "claude-agent", model: "sonnet", mode: "propose" }] });
  let attempt = 0;
  setEngineForTests("claude-agent", {
    id: "claude-agent",
    capabilities: { agentic: true, governedToolsOnly: true },
    startTurn(options) {
      attempt += 1;
      const code = attempt === 1 ? 0 : 2;
      queueMicrotask(() => {
        options.onLine?.("[demo-tool]");
        options.onLine?.("[tool] Read");
        options.onLine?.("mcp__demo__doc_read");
        options.onLine?.("real answer");
        options.onClose?.({ code, stderr: code ? "bad" : "" });
      });
      return { pid: null, kill: () => {} };
    }
  });
  t.after(() => setEngineForTests("claude-agent", null));
  const runner = createRoleRunner({ tools: demoBridge() });
  const captured = await runner.runRoleCapture({ root: target, role: "ceo", prompt: "brief" });
  assert.equal(captured.ok, true);
  assert.equal(captured.text, "real answer");
  assert.equal(captured.runnerId, "test-claude-capture");
  assert.equal(captured.engineId, "claude-agent");
  const failed = await runner.runRoleCapture({ root: target, role: "ceo", prompt: "brief" });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /runner exited 2: bad/);
});

test("startRoleTurn refuses a role name that is not a slug", () => {
  assert.throws(() => createRoleRunner().startRoleTurn({ targetRoot: tmpRoot, role: "../../etc/passwd", messages: [] }), /invalid role name/);
  assert.throws(() => createRoleRunner().startRoleTurn({ targetRoot: tmpRoot, role: "", messages: [] }), /invalid role name/);
});
