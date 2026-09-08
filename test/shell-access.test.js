import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initializeWorkspace } from "../src/workspace-setup.js";
import { readWorkspace } from "../src/workspace-manifest.js";
import { createRuntimeStore } from "../src/runtime-store.js";
import { createShellSession, setShellAgent } from "../src/shell-access.js";
import { createWorkspaceTools, validateWorkspaceChange } from "../src/workspace-tools.js";
import { createRoleGovernance } from "../src/role-contract.js";
import { loadRoleSpec } from "../src/role-spec.js";
import { createClaudeAgentEngine } from "../src/engines/claude-agent.js";
import { claudeShellOptions, claudeShellEnv } from "../src/engines/claude-shell.js";
import { collectModels, renderPartial } from "../src/console/pages.js";
import { createConsole } from "../src/console/server.js";

const profile = { id: "test-claude", engine: "claude-agent", model: "sonnet", auth: "subscription" };
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "crew-shell-test-"));
  const root = path.join(dir, "workspace");
  const env = { CREW_HOME: path.join(dir, "private") };
  initializeWorkspace(root);
  const spec = readFileSync(path.join(root, ".crew/agents/assistant.json"), "utf8");
  writeFileSync(path.join(root, ".crew/agents/peer.json"), spec);
  const args = { targetRoot: root, role: "assistant", profile, env };
  const store = createRuntimeStore(args);
  const sessions = [];
  const start = (extra = {}) => { const session = createShellSession({ ...args, ...extra }); sessions.push(session); return session; };
  const enable = (extra = {}) => setShellAgent({ ...args, enabled: true, confirmed: true, ...extra });
  t.after(() => { for (const s of sessions) s.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { root, env, args, store, enable, start };
}

test("shell is off by default, owner-confirmed, exclusive, non-inheritable and absent from peer controls", (t) => {
  const f = fixture(t);
  assert.equal(readWorkspace(f.root).shellAgent, null);
  assert.throws(() => f.start(), /selected shell agent/);
  assert.throws(() => f.enable({ confirmed: false }), /Confirm/);
  assert.throws(() => f.enable({ role: "crew-helper" }), /ordinary/);
  for (const forbidden of [{ engine: "codex-agent" }, { ...profile, base_url: "https://example.com" }, { engine: "cli" }]) assert.throws(() => f.enable({ profile: forbidden }), /requires a direct Claude/);
  f.enable();
  assert.throws(() => f.enable({ role: "peer" }), /belongs to assistant/);
  for (const key of ["allowShell", "allow_shell", "alloshell"]) assert.throws(() => validateWorkspaceChange(".crew/agents/_defaults.json", JSON.stringify({ [key]: true })), /never inherited/);
  const models = collectModels(f.root);
  const directory = renderPartial("agents", models, { roleView: "list" });
  const cards = directory.match(/<article class="agent-card">[\s\S]*?<\/article>/g);
  assert.equal(cards.filter((card) => card.includes(">Shell access<")).length, 1);
  assert.match(cards.find((card) => card.includes('href="/agents/assistant"')), /class="pill danger">Shell access</);
  assert.doesNotMatch(cards.find((card) => card.includes('href="/agents/peer"')), />Shell access</);
  assert.doesNotMatch(directory, /class="pill[^"]*">(?:governed|legacy)</);
  const owner = renderPartial("agents", models, { roleView: "detail", selectedRole: "assistant" });
  const peer = renderPartial("agents", models, { roleView: "detail", selectedRole: "peer" });
  assert.match(owner, /class="card flat shell-access"/);
  assert.doesNotMatch(owner, /class="pill[^"]*">(?:governed|legacy)</);
  assert.match(owner, /Authority contract/);
  assert.match(owner, /aria-label="Allow shell for assistant"/);
  assert.doesNotMatch(peer, /action="\/agents\/shell"/);
  assert.match(peer, /authorized task handoff/);
  setShellAgent({ ...f.args, enabled: false });
  f.enable({ role: "peer" });
  assert.equal(readWorkspace(f.root).shellAgent, "peer");
});

test("independent store connections share the shell lease; revocation blocks new tools and handover", (t) => {
  const f = fixture(t); f.enable();
  const s = f.start();
  assert.throws(() => s.check({ role: "peer", targetRoot: f.root }), /different agent or workspace/);
  assert.throws(() => s.check({ role: "assistant", targetRoot: path.dirname(f.root) }), /different agent or workspace/);
  assert.throws(() => f.start(), /already active/);
  assert.throws(() => f.start({ role: "peer" }), /selected shell agent/);
  setShellAgent({ ...f.args, enabled: false });
  assert.throws(() => s.check(), /authority changed/);
  assert.throws(() => f.enable({ role: "peer" }), /active shell turn/);
  s.close(); f.enable({ role: "peer" });
  f.start({ role: "peer" }).check();
});

test("another process cannot start a second shell turn", (t) => {
  const f = fixture(t); f.enable(); f.start();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createShellSession } from ${JSON.stringify(new URL("../src/shell-access.js", import.meta.url).href)};
    try { const s = createShellSession(JSON.parse(process.argv[1])); s.close(); process.exitCode = 1; }
    catch (error) { if (!/already active/.test(error.message)) throw error; }
  `, JSON.stringify(f.args)], { encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
});

test("owner console enforces confirmation, exclusivity and cross-origin protection on the shell endpoint", async (t) => {
  const f = fixture(t);
  const console_ = createConsole({ targetRoot: f.root, port: 0, operations: {
    getSnapshot: () => ({}), setShellAgent: (options) => setShellAgent({ ...options, env: f.env, profile })
  } });
  const base = `http://127.0.0.1:${await console_.listen()}`;
  const post = (form, headers = {}) => fetch(`${base}/agents/shell`, { method: "POST", body: new URLSearchParams(form), redirect: "manual", headers });
  try {
    await post({ role: "assistant", enabled: "1" });
    assert.equal(readWorkspace(f.root).shellAgent, null);
    await post({ role: "assistant", enabled: "1", confirmed: "1" });
    assert.equal(readWorkspace(f.root).shellAgent, "assistant");
    await post({ role: "peer", enabled: "1", confirmed: "1" });
    assert.equal(readWorkspace(f.root).shellAgent, "assistant");
    const peer = await (await fetch(`${base}/agents/peer`)).text();
    assert.doesNotMatch(peer, /action="\/agents\/shell"/);
    const foreign = await post({ role: "assistant", enabled: "" }, { Origin: "https://foreign.invalid" });
    assert.equal(foreign.status, 403);
    assert.equal(readWorkspace(f.root).shellAgent, "assistant");
    await post({ role: "assistant", enabled: "" });
    assert.equal(readWorkspace(f.root).shellAgent, null);
  } finally { await console_.close(); }
});

test("flagged commands survive restart, are never provider deliveries, and consume exact owner approval once", (t) => {
  const f = fixture(t); f.enable();
  let s = f.start({ context: { chatId: 7 } });
  const command = { command: "systemctl --user status demo.service", timeout: null };
  const review = s.request("Bash", command, "Check this service action");
  assert.equal(s.request("Bash", command).id, review.id);
  assert.equal(s.before("Bash", command, "a"), "deny");
  s.close();
  f.store.decideAction(review.id, "approve");
  assert.equal(f.store.claimAction(), null);
  assert.equal(f.store.claimAction(review.id), null);
  s = f.start({ context: { chatId: 7 } });
  assert.equal(s.before("Bash", { ...command, command: "different command" }, "b"), "auto", "a changed command must face native review, never inherit approval");
  assert.equal(s.before("Bash", command, "c"), "approved");
  assert.equal(s.before("Bash", command, "d"), "deny");
  s.finish("c");
  assert.equal(f.store.getAction(review.id).status, "delivered");
  assert.equal(s.before("Bash", command, "e"), "deny");
});

test("rejections do not retry, changed authority invalidates approval, and interrupted execution is uncertain", (t) => {
  const f = fixture(t); f.enable();
  let s = f.start();
  const input = { command: "some-command", timeout: null };
  const denied = s.request("Bash", input);
  f.store.decideAction(denied.id, "reject");
  assert.equal(s.before("Bash", input, "denied"), "deny");
  const changed = { command: "another-command", timeout: null };
  const approval = s.request("Bash", changed);
  f.store.decideAction(approval.id, "approve");
  assert.equal(s.before("Bash", changed, "claimed"), "approved");
  s.close();
  assert.equal(f.store.getAction(approval.id).status, "uncertain");
  s = f.start();
  assert.equal(s.before("Bash", changed, "again"), "deny");
  const file = path.join(f.root, ".crew/agents/assistant.json");
  const spec = JSON.parse(readFileSync(file, "utf8")); spec.instructions = "Updated instructions";
  writeFileSync(file, JSON.stringify(spec));
  assert.throws(() => s.check(), /authority changed/);
});

test("helper proposals cannot assign or revoke shell access", (t) => {
  const f = fixture(t);
  const governance = createRoleGovernance({ ...f.args, getContract: (role) => loadRoleSpec(f.root, role)?.contract });
  const workspace = createWorkspaceTools({ ...f.args, store: f.store, governance });
  const changed = { ...readWorkspace(f.root), shellAgent: "assistant" };
  assert.throws(() => workspace.propose({ role: "crew-helper", setup: true, title: "Grant shell", changes: [{ path: ".crew/workspace.json", content: JSON.stringify(changed) }] }), /only be changed by the owner/);
  assert.equal(readWorkspace(f.root).shellAgent, null);
});

test("revoking then regranting does not revive prior approvals or expose integration secrets", (t) => {
  const f = fixture(t); f.enable();
  let s = f.start();
  const input = { command: "old-command", timeout: null };
  const old = s.request("Bash", input);
  f.store.decideAction(old.id, "approve");
  s.close();
  setShellAgent({ ...f.args, enabled: false }); f.enable();
  s = f.start();
  assert.equal(s.before("Bash", input, "new-grant"), "auto");
  assert.equal(f.store.getAction(old.id).status, "queued", "old permission was not consumed");
  assert.deepEqual(claudeShellEnv({ PATH: "/bin", HOME: "/home/user", ANTHROPIC_API_KEY: "provider", CREWRUN_INTEGRATIONS_KEY: "vault", CREWRUN_SLACK_CLIENT_SECRET: "secret", GITHUB_TOKEN: "secret" }), { PATH: "/bin", HOME: "/home/user", ANTHROPIC_API_KEY: "provider" });
});

test("Claude native auto review is not shadowed by Bash allow rules; denied actions enter Reviews", async (t) => {
  const f = fixture(t); f.enable();
  const s = f.start();
  const tool = { tool_name: "Bash", tool_input: { command: "uname -s" } };
  const engine = createClaudeAgentEngine({ loadSdk: async () => ({ query: async function* ({ options }) {
    assert.equal(options.permissionMode, "auto");
    assert.deepEqual(options.tools, ["Bash"]);
    assert.deepEqual(options.allowedTools, []);
    assert.deepEqual(options.settingSources, []);
    yield { type: "system", subtype: "init", permissionMode: "auto" };
    assert.deepEqual(await options.hooks.PreToolUse[0].hooks[0](tool, "one"), {});
    await options.hooks.PermissionDenied[0].hooks[0]({ ...tool, reason: "Native classifier flagged it" });
    const decision = await options.hooks.PreToolUse[0].hooks[0](tool, "two");
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    yield { type: "result", subtype: "success", permission_denials: [{ ...tool, tool_use_id: "one" }] };
  } }) });
  const result = await new Promise((resolve) => engine.startTurn({ ...f.args, workdir: f.root, mode: "propose", prompt: "Inspect", toolContext: { governedToolsOnly: true, shell: s }, onClose: resolve }));
  assert.equal(result.code, 0);
  const actions = f.store.snapshot().runs.flatMap((r) => r.actions);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, "awaiting_approval");
  const reviewModels = collectModels(f.root, { operations: { approvals: [{ ...actions[0], status: "pending", summary: actions[0].summary, source: "runtime" }] } });
  assert.match(renderPartial("reviews", reviewModels, { selectedReview: actions[0].id, canDecideApprovals: true }), /uname -s/);
});

test("Claude permission fallback, missing shell host, and detached requests fail closed", async (t) => {
  const f = fixture(t); f.enable(); const s = f.start();
  const engine = createClaudeAgentEngine({ loadSdk: async () => ({ query: async function* () { yield { type: "system", subtype: "init", permissionMode: "default" }; } }) });
  const result = await new Promise((resolve) => engine.startTurn({ ...f.args, workdir: f.root, prompt: "Inspect", toolContext: { governedToolsOnly: true, shell: s }, onClose: resolve }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unavailable/);
  const { options } = claudeShellOptions(s, f.root);
  assert.equal((await options.hooks.PreToolUse[0].hooks[0]({ tool_name: "Bash", tool_input: { command: "sleep 99", run_in_background: true } }, "bg")).hookSpecificOutput.permissionDecision, "deny");
});

test("approving task shell work queues one continuation, including approval during a running turn", (t) => {
  const f = fixture(t); f.enable();
  const run = f.store.enqueue({ agent: "assistant", prompt: "Inspect system" });
  let claim = f.store.claimRun(run.id);
  const s = f.start({ context: { runId: run.id, runLease: claim.lease } });
  const action = s.request("Bash", { command: "uname -s", timeout: null });
  f.store.decideAction(action.id, "approve");
  s.close();
  f.store.finishRun(claim, { ok: true });
  assert.equal(f.store.getRun(run.id).status, "queued");
  claim = f.store.claimRun(run.id);
  assert.match(f.store.taskContext(run.id), /uname -s/);
  f.store.finishRun(claim, { ok: true, text: "Could not retry" });
  assert.equal(f.store.getRun(run.id).status, "completed", "do not loop when the model does not consume an approval");
  assert.equal(f.store.claimRun(run.id), null);
});
