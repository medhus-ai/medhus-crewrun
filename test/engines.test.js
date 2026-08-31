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
    serverName: "demo",
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

test("engine registry knows all engines and falls back to cli", () => {
  assert.deepEqual(ENGINE_IDS, ["cli", "claude-agent", "codex-agent"]);
  assert.equal(getEngine("cli").id, "cli");
  assert.equal(getEngine("not-an-engine").id, "cli");
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
  assert.deepEqual(captured.options.tools, ["Read", "Grep", "Glob"]);
  assert.equal(captured.options.mcpServers, undefined);
  assert.equal(captured.options.includePartialMessages, true);
});

test("claude-agent engine maps execute mode to edit tools, subagents, and opt-in shell", async () => {
  const captured = {};
  const engine = createClaudeAgentEngine({ loadQuery: async () => fakeClaudeQuery(captured, [OK_RESULT]) });
  await runClaude(engine, { profile: { id: "x", reasoning_effort: "very-high" }, workdir: "/tmp/wt", role: "engineer", mode: "execute", systemPrompt: "s" });
  assert.equal(captured.options.permissionMode, "acceptEdits");
  assert.equal(captured.options.effort, "xhigh");
  assert.equal(captured.options.includePartialMessages, undefined);
  assert.equal(captured.options.cwd, "/tmp/wt");
  assert.ok(captured.options.tools.includes("Edit"));
  assert.ok(captured.options.tools.includes("Agent"));
  assert.ok(captured.options.allowedTools.includes("Agent(crew-investigator,crew-implementation-worker)"));
  assert.ok(captured.options.agents["crew-implementation-worker"]);
  assert.ok(!captured.options.tools.includes("Bash"));

  const shell = {};
  await runClaude(createClaudeAgentEngine({ loadQuery: async () => fakeClaudeQuery(shell, [OK_RESULT]) }), { profile: { id: "x", allow_shell: true }, role: "engineer", mode: "execute" });
  assert.ok(shell.options.tools.includes("Bash"));
  assert.ok(shell.options.agents["crew-implementation-worker"].tools.includes("Bash"));

  const branded = {};
  await runClaude(createClaudeAgentEngine({ loadQuery: async () => fakeClaudeQuery(branded, [OK_RESULT]) }), {
    role: "engineer",
    mode: "execute",
    capabilities: { subagents: { allowed: true, writable: true, prefix: "acme" } }
  });
  assert.ok(branded.options.allowedTools.includes("Agent(acme-investigator,acme-implementation-worker)"));
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
  assert.deepEqual(captured.options.allowedTools, ["Read", "Grep", "Glob", "mcp__demo__doc_read"]);
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

test("codex-agent engine resumes threads and reports the thread id", async () => {
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
    engine.startTurn({ profile: { id: "x" }, workdir: "/tmp", role: "planner", mode: "propose", systemPrompt: "system stuff", prompt: "just the new message", resumeSessionId: "thread-42", onClose: resolve, onError: reject });
  });
  assert.equal(captured.resumed.id, "thread-42");
  assert.equal(captured.started, undefined);
  assert.equal(captured.prompt, "just the new message");
  assert.equal(closed.engineSessionId, "thread-42");
});

test("codex-agent engine streams items, maps sandbox per mode, and serves host tools over stdio MCP", async () => {
  const captured = {};
  const root = path.join(tmpRoot, "codex-mcp-root");
  await mkdir(root, { recursive: true });
  class FakeThread {
    async runStreamed(prompt, options) {
      captured.prompt = prompt;
      captured.turnOptions = options;
      async function* events() {
        yield { type: "item.completed", item: { type: "reasoning", text: "thinking" } };
        yield { type: "item.completed", item: { type: "command_execution", command: "npm test" } };
        yield { type: "item.completed", item: { type: "mcp_tool_call", server: "demo", tool: "doc_read", status: "completed" } };
        yield { type: "item.completed", item: { type: "mcp_tool_call", server: "demo", tool: "doc_write", status: "failed", error: { message: "transport closed" } } };
        yield { type: "item.started", item: { id: "message-1", type: "agent_message", text: "" } };
        yield { type: "item.updated", item: { id: "message-1", type: "agent_message", text: "all" } };
        yield { type: "item.updated", item: { id: "message-1", type: "agent_message", text: "all good" } };
        yield { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "all good" } };
        yield { type: "turn.completed", usage: { input_tokens: 50, output_tokens: 9 } };
      }
      return { events: events() };
    }
  }
  class FakeCodex {
    constructor(options) { captured.codexOptions = options; }
    startThread(options) { captured.threadOptions = options; return new FakeThread(); }
  }
  const engine = createCodexAgentEngine({ loadCodex: async () => FakeCodex });
  const lines = [];
  const partial = [];
  const closed = await new Promise((resolve, reject) => {
    engine.startTurn({
      profile: { id: "codex-agent-high", reasoning_effort: "high" },
      workdir: root,
      role: "writer",
      capabilities: { subagents: { allowed: true } },
      mode: "propose",
      systemPrompt: "system context",
      prompt: "review this",
      toolContext: { targetRoot: root },
      tools: demoBridge(),
      onLine: (line) => lines.push(line),
      onPartialText: (text) => partial.push(text),
      onClose: resolve,
      onError: reject
    });
  });
  assert.deepEqual(lines, ["[cmd] npm test", "[mcp] demo.doc_read (completed)", "[mcp] demo.doc_write (failed): transport closed", "all good"]);
  assert.deepEqual(partial, ["all", " good"]);
  assert.equal(closed.code, 0);
  assert.deepEqual(closed.tools, { available: true, transport: "mcp", mcp: true });
  assert.deepEqual(closed.usage, { inputTokens: 50, outputTokens: 9, costUsd: null });
  assert.equal(captured.threadOptions.sandboxMode, "read-only");
  assert.equal(captured.threadOptions.workingDirectory, root);
  assert.equal(captured.threadOptions.modelReasoningEffort, "high");
  assert.equal(captured.codexOptions.config.features.multi_agent, true);
  const server = captured.codexOptions.config.mcp_servers.demo;
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, [path.join(tmpRoot, "demo-mcp-server.js")]);
  assert.equal(server.env.CREW_MCP_ROLE, "writer");
  assert.equal(existsSync(server.env.CREW_MCP_CONTEXT_FILE), false, "context file is cleaned up after the turn");
  assert.equal(captured.prompt, "system context\n\nreview this");
});

test("codex-agent engine isolates every turn and omits MCP config without a bridge or target root", async () => {
  const captured = {};
  class FakeCodex {
    constructor(options) { captured.codexOptions = options; }
    startThread(options) {
      captured.threadOptions = options;
      return {
        async runStreamed() {
          async function* events() {
            yield { type: "item.completed", item: { type: "agent_message", text: "no tools" } };
            yield { type: "turn.failed", error: { message: "boom" } };
          }
          return { events: events() };
        }
      };
    }
  }
  const engine = createCodexAgentEngine({ loadCodex: async () => FakeCodex });
  const closed = await new Promise((resolve) => {
    engine.startTurn({ profile: { id: "x" }, workdir: "/tmp/wt", role: "engineer", mode: "execute", prompt: "p", onClose: resolve });
  });
  assert.equal(captured.threadOptions.sandboxMode, "workspace-write");
  assert.equal(captured.codexOptions.config.mcp_servers, undefined);
  assert.equal(captured.codexOptions.config.features.memories, false);
  assert.equal(captured.codexOptions.env.GH_TOKEN, undefined);
  assert.ok(captured.codexOptions.env.GH_CONFIG_DIR);
  assert.equal(captured.codexOptions.env.CODEX_HOME, path.join(process.env.CREW_HOME, "provider-runtime", "codex"));
  assert.deepEqual(closed.tools, { available: false, transport: "mcp", mcp: true });
  assert.equal(closed.code, 1);
  assert.match(closed.stderr, /boom/);
});

test("runner profiles validate engines and checks dispatch to the engine healthcheck", async () => {
  const saved = saveGlobalRunnerConfig({
    runners: [
      { id: "agent-profile", engine: "claude-agent", model: "sonnet", reasoning_effort: "high" },
      { id: "cli-profile", engine: "cli", command: "node", args: [] }
    ]
  });
  assert.equal(saved.runners[0].engine, "claude-agent");
  assert.equal(saved.runners[0].mode, "propose");
  assert.equal(saved.runners[1].engine, "cli");
  assert.throws(() => saveGlobalRunnerConfig({ runners: [{ id: "bad", engine: "skynet", command: "x" }] }), /unknown engine/);
  assert.throws(() => saveGlobalRunnerConfig({ runners: [{ id: "bad-cli", engine: "cli" }] }), /missing command/);

  setEngineForTests("claude-agent", { id: "claude-agent", capabilities: {}, async healthcheck(profile) { return { ok: true, status: "pass", message: `checked ${profile.id}` }; } });
  try {
    assert.equal((await checkGlobalRunner("agent-profile")).message, "checked agent-profile");
  } finally {
    setEngineForTests("claude-agent", null);
  }
});

async function projectWithRole(name, role, runnerId, files = {}) {
  const target = path.join(tmpRoot, name);
  await mkdir(path.join(target, ".gitcrew/roles"), { recursive: true });
  await mkdir(path.join(target, ".gitcrew/memory"), { recursive: true });
  await writeFile(path.join(target, `.gitcrew/roles/${role}.md`), `# ${role} role`, "utf8");
  await writeFile(path.join(target, ".gitcrew/memory/ai-runners.json"), JSON.stringify({ version: 1, default_role_runners: { [role]: runnerId }, runners: [] }), "utf8");
  for (const [rel, body] of Object.entries(files)) await writeFile(path.join(target, ".gitcrew", rel), body, "utf8");
  return target;
}

test("startRoleTurn routes engine turns with a system prompt and records the worktree branch on execute", async (t) => {
  const target = await projectWithRole("turn-project", "engineer", "test-claude-execute", { "memory/lean-engineering.md": "be lean", "memory/house.md": "house rules" });
  spawnSync("git", ["-C", target, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", target, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "init"], { encoding: "utf8" });
  saveGlobalRunnerConfig({ runners: [{ id: "test-claude-execute", engine: "claude-agent", model: "sonnet", mode: "execute" }] });

  const captured = {};
  setEngineForTests("claude-agent", {
    id: "claude-agent",
    capabilities: { agentic: true },
    startTurn(options) {
      captured.options = options;
      queueMicrotask(() => options.onClose?.({ code: 0, stderr: "", usage: null }));
      return { pid: null, kill: () => {} };
    }
  });
  t.after(() => setEngineForTests("claude-agent", null));

  const lines = [];
  const runner = createRoleRunner({ tools: demoBridge() });
  const handle = runner.startRoleTurn({ targetRoot: target, role: "engineer", messages: [{ author: "user", content: "do the thing" }], onLine: (line) => lines.push(line) });
  assert.equal(handle.engineId, "claude-agent");
  assert.equal(handle.mode, "execute");
  assert.match(handle.branch, /^crew\/engineer-/);
  assert.ok(existsSync(captured.options.workdir));
  assert.notEqual(captured.options.workdir, target);
  assert.equal(captured.options.tools.serverName, "demo");
  assert.match(captured.options.systemPrompt, /# engineer role/);
  assert.match(captured.options.systemPrompt, /## Lean & readable engineering\nbe lean/);
  assert.doesNotMatch(captured.options.systemPrompt, /house rules/, "unlisted memory files are not injected");
  assert.match(captured.options.systemPrompt, /isolated git worktree/);
  assert.match(captured.options.systemPrompt, /provider-native subagents/);
  assert.equal(captured.options.capabilities.subagents.allowed, true);
  assert.match(captured.options.prompt, /do the thing/);
  assert.match(lines[0], /^\[worktree\] crew\/engineer-/);
  spawnSync("git", ["-C", target, "worktree", "remove", "--force", captured.options.workdir], { encoding: "utf8" });
});

test("host hooks shape prompts, memory titles, display names, and worktree naming", async (t) => {
  const target = await projectWithRole("hooked-project", "ceo", "test-claude-hooked", { "memory/charter.md": "we ship", "memory/lean-engineering.md": "be lean" });
  spawnSync("git", ["-C", target, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", target, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "init"], { encoding: "utf8" });
  saveGlobalRunnerConfig({ runners: [{ id: "test-claude-hooked", engine: "claude-agent", model: "sonnet", mode: "execute" }] });
  const captured = {};
  setEngineForTests("claude-agent", { id: "claude-agent", capabilities: { agentic: true }, startTurn(options) { captured.options = options; return { pid: null, kill: () => {} }; } });
  t.after(() => setEngineForTests("claude-agent", null));

  const runner = createRoleRunner({
    displayRoleName: (role) => (role === "ceo" ? "Chief Executive Officer" : role),
    universalMemory: ["charter.md"],
    memoryTitles: { charter: "Company charter" },
    protocol: (role) => [`## ${role} protocol`, "Ask in prose."],
    capabilityInstructions: () => "## Acme boundary\nAcme owns the ledger.",
    createWorktree: (root, slug) => ({ dir: root, branch: `acme/${slug}` })
  });
  const handle = runner.startRoleTurn({ targetRoot: target, role: "ceo", messages: [{ author: "user", content: "brief me" }] });
  assert.equal(handle.branch, "acme/ceo");
  assert.match(captured.options.systemPrompt, /^You are the Chief Executive Officer for this project/);
  assert.match(captured.options.systemPrompt, /## Company charter\nwe ship/);
  assert.doesNotMatch(captured.options.systemPrompt, /be lean/);
  assert.match(captured.options.systemPrompt, /## ceo protocol\nAsk in prose\./);
  assert.match(captured.options.systemPrompt, /## Acme boundary/);
  assert.doesNotMatch(captured.options.systemPrompt, /Control boundary/);

  const body = runner.buildPromptBody({ role: "ceo", rolePrompt: "# CEO", messages: [{ author: "user", content: "hi" }] });
  assert.match(body, /^You are the Chief Executive Officer\. Follow the role file below exactly\./);
  assert.match(body, /## ceo protocol\nAsk in prose\.\n## Your turn/);
});

test("startRoleTurn runs propose-mode reviews from an explicit read-only worktree", async (t) => {
  const target = await projectWithRole("review-turn-project", "qa-engineer", "test-claude-review");
  const reviewDir = path.join(tmpRoot, "review-turn-worktree");
  await mkdir(reviewDir, { recursive: true });
  saveGlobalRunnerConfig({ runners: [{ id: "test-claude-review", engine: "claude-agent", model: "sonnet", mode: "propose" }] });
  const captured = {};
  setEngineForTests("claude-agent", { id: "claude-agent", capabilities: { agentic: true }, startTurn(options) { captured.options = options; return { pid: null, kill: () => {} }; } });
  t.after(() => setEngineForTests("claude-agent", null));

  const statuses = [];
  const handle = createRoleRunner().startRoleTurn({
    targetRoot: target,
    role: "qa-engineer",
    messages: [{ author: "user", content: "verify the PR" }],
    readOnlyWorktree: { dir: reviewDir, branch: "crew/issue-31" },
    onStatus: (status) => statuses.push(status)
  });
  assert.equal(handle.mode, "propose");
  assert.equal(handle.workdir, reviewDir);
  assert.equal(handle.branch, "crew/issue-31");
  assert.equal(captured.options.workdir, reviewDir);
  assert.deepEqual(statuses, ["reviewing branch crew/issue-31"]);
});

test("runRoleCapture drops tool noise and resolves ok:false on failure instead of rejecting", async (t) => {
  const target = await projectWithRole("capture-project", "ceo", "test-claude-capture");
  saveGlobalRunnerConfig({ runners: [{ id: "test-claude-capture", engine: "claude-agent", model: "sonnet", mode: "propose" }] });
  let attempt = 0;
  setEngineForTests("claude-agent", {
    id: "claude-agent",
    capabilities: { agentic: true },
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
  assert.deepEqual(await runner.runRoleCapture({ root: target, role: "ceo", prompt: "brief" }), { ok: true, text: "real answer" });
  const failed = await runner.runRoleCapture({ root: target, role: "ceo", prompt: "brief" });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /runner exited 2: bad/);
});
