import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, renameSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { initializeWorkspace } from "../src/workspace-setup.js";
import { normalizeWorkspace, readWorkspace, resolveWorkspacePath } from "../src/workspace-manifest.js";
import { createRuntimeStore, runtimeStatePath } from "../src/runtime-store.js";
import { createWorkspaceTools, WORK_TOOLS } from "../src/workspace-tools.js";
import { createRoleGovernance } from "../src/role-contract.js";
import { loadRoleSpec } from "../src/role-spec.js";
import { routeLifecycleEvents } from "../src/runtime-lifecycle.js";
import { createHost } from "../packages/crewrun-reference-host/index.js";
import { createClaudeAgentEngine } from "../src/engines/claude-agent.js";
import { loadRoleMemory } from "../src/runner.js";
import { collectModels, renderPartial } from "../src/console/pages.js";
import { setEngineForTests } from "../src/engines/index.js";
import { nextRun } from "../src/schedules.js";
import { createConsoleChatService } from "../src/console-chat.js";

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crew-workspace-test-"));
  const root = path.join(directory, "repo");
  const env = { CREW_HOME: path.join(directory, "private") };
  initializeWorkspace(root);
  mkdirSync(path.join(root, "knowledge"));
  writeFileSync(path.join(root, "knowledge/brief.md"), "Original knowledge");
  const file = path.join(root, ".crew/agents/assistant.json");
  const spec = JSON.parse(readFileSync(file, "utf8"));
  spec.contract.authority.tools = Object.keys(WORK_TOOLS).map((name) => ({ name, impact: ["task.get", "task.list", "workspace.read", "workspace.search"].includes(name) ? "read" : "internal-write" }));
  spec.contract.authority.handoffs = { send: ["peer"], receive: ["peer"] };
  writeFileSync(file, JSON.stringify(spec));
  writeFileSync(path.join(root, ".crew/agents/peer.json"), JSON.stringify({ ...spec, contract: { ...spec.contract, authority: { ...spec.contract.authority, handoffs: { send: ["assistant"], receive: ["assistant"] } } } }));
  let clock = 1_800_000_000_000;
  const store = createRuntimeStore({ targetRoot: root, env, now: () => clock });
  const governance = createRoleGovernance({ targetRoot: root, env, requireContracts: true, getContract: (role) => loadRoleSpec(root, role)?.contract });
  const workspace = createWorkspaceTools({ targetRoot: root, store, governance, now: () => clock });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (toolName, input = {}, context = {}, role = "assistant") => workspace.call({ role, toolName, input, context });
  return { root, directory, env, store, governance, workspace, call, advance: () => clock++ };
}

test("workspace identity survives relocation and never opens legacy path state", (t) => {
  const f = fixture(t);
  const original = runtimeStatePath(f.root, f.env);
  const next = path.join(f.directory, "moved");
  renameSync(f.root, next);
  assert.equal(runtimeStatePath(next, f.env), original);
  assert.notEqual(runtimeStatePath(f.root, f.env), original);
  assert.equal(readWorkspace(next).policy.governed, true);
  assert.throws(() => normalizeWorkspace({ ...readWorkspace(next), policy: { governed: false } }), /cannot be disabled/);
  assert.throws(() => initializeWorkspace(next), /already initialized/);
});

test("owner question resumes one task even when answered during the finishing turn", async (t) => {
  const f = fixture(t);
  const run = f.store.enqueue({ agent: "assistant", prompt: "Help", criteria: "A reviewed result" });
  const claim = f.store.claimRun(run.id);
  const q = await f.call("task.askOwner", { question: "Which day?", options: ["Monday", "Tuesday"] }, { runId: run.id, runLease: claim.lease });
  f.store.answerQuestion(q.id, "Monday");
  f.store.finishRun(claim, { text: "Waiting for an answer" });
  assert.equal(f.store.getRun(run.id).status, "queued");
  const resumed = f.store.claimRun(run.id);
  assert.match(f.store.taskContext(run.id), /Monday/);
  f.store.finishRun(resumed, { text: "Done" });
  assert.equal(f.store.getRun(run.id).status, "completed");
  f.store.answerQuestion(q.id, "Monday");
  assert.equal(f.store.claimRun(), null);
  assert.throws(() => f.store.answerQuestion(q.id, "Tuesday"), /already been answered/);
  assert.throws(() => f.store.controlRun(run.id, "request_changes"), /feedback/);
  f.store.controlRun(run.id, "request_changes", { feedback: "Include evidence" });
  assert.match(f.store.taskContext(run.id), /Include evidence/);
  assert.equal(f.store.getRun(run.id).id, run.id);
});

test("delegation checks both roles, scopes task access, and waits for child acceptance", async (t) => {
  const f = fixture(t);
  const run = f.store.enqueue({ agent: "assistant", prompt: "Coordinate" });
  const claim = f.store.claimRun(run.id);
  const ctx = { runId: run.id, runLease: claim.lease };
  const child = await f.call("task.delegate", { agent: "peer", prompt: "Prepare evidence", outcome: "Evidence" }, ctx);
  assert.equal(child.parent_id, run.id);
  assert.equal((await f.call("task.delegate", { agent: "peer", prompt: "Prepare evidence", outcome: "Evidence" }, ctx)).id, child.id);
  await assert.rejects(f.call("task.update", { id: child.id, progress: "Hijack" }, ctx), /authority/);
  await assert.rejects(f.call("task.get", { id: run.id }, {}, "peer"), /authority/);
  f.store.finishRun(claim, { text: "Delegated" });
  assert.equal(f.store.getRun(run.id).status, "waiting");
  const childClaim = f.store.claimRun(child.id);
  f.store.finishRun(childClaim, { text: "Evidence result" });
  assert.equal(f.store.claimRun(run.id), null);
  f.store.controlRun(child.id, "accept");
  assert.equal(f.store.claimRun(run.id).id, run.id);
});

test("workspace tools deny traversal, symlinks, cross-role paths and durable direct writes", async (t) => {
  const f = fixture(t);
  assert.throws(() => resolveWorkspacePath(f.root, "../private"), /relative/);
  symlinkSync(f.directory, path.join(f.root, "knowledge/escape"), "junction");
  await assert.rejects(f.call("workspace.read", { path: "knowledge/escape/private" }), /symlink/);
  await assert.rejects(f.call("workspace.read", { path: "private.md" }), /authority/);
  await assert.rejects(f.call("workspace.writeDraft", { path: "knowledge/brief.md", content: "overwrite" }), /draft/);
  await assert.rejects(f.call("workspace.writeDraft", { path: "drafts/peer/data.md", content: "overwrite" }), /authority/);
  await f.call("workspace.writeDraft", { path: "drafts/assistant/brief.md", content: "Draft" });
  assert.equal(readFileSync(path.join(f.root, "drafts/assistant/brief.md"), "utf8"), "Draft");
  await assert.rejects(f.call("workspace.proposePatch", { title: "Elevate", changes: [{ path: ".crew/agents/assistant.json", content: "{}" }] }), /setup proposals/);
  assert.deepEqual(loadRoleMemory(f.root, "", { pointers: ["knowledge/brief.md", "README.md"], governed: true, contract: { authority: { data: { read: ["workspace:readme.md"] } } } }).map((m) => m.title), ["README"]);
});

test("review proposals reject without writes, reject stale bases and resume partial application", (t) => {
  const f = fixture(t);
  const proposal = () => f.workspace.propose({ role: "assistant", title: "Clarify", changes: [{ path: "knowledge/brief.md", content: "Reviewed" }, { path: "knowledge/new.md", content: "New" }] });
  const rejected = proposal(); f.workspace.decide({ id: rejected.id, action: "reject" });
  assert.equal(readFileSync(path.join(f.root, "knowledge/brief.md"), "utf8"), "Original knowledge");
  const stale = proposal(); writeFileSync(path.join(f.root, "knowledge/brief.md"), "Operator edit");
  assert.throws(() => f.workspace.decide({ id: stale.id, action: "approve" }), /Stale/);
  const recover = proposal();
  f.store.db.prepare("UPDATE workspace_proposals SET status='applying' WHERE id=?").run(recover.id);
  writeFileSync(path.join(f.root, "knowledge/brief.md"), "Reviewed");
  f.workspace.recover();
  assert.equal(f.workspace.listProposals().find((p) => p.id === recover.id).status, "applied");
  assert.equal(readFileSync(path.join(f.root, "knowledge/new.md"), "utf8"), "New");
});

test("lifecycle cursor is durable, routes are explicit and chains are bounded", (t) => {
  const f = fixture(t);
  const manifest = readWorkspace(f.root);
  manifest.rules = [{ id: "approval-followup", event: "approval.rejected", agent: "assistant", enabled: true }];
  manifest.limits = { depth: 1, chainRuns: 2, attempts: 5 };
  writeFileSync(path.join(f.root, ".crew/workspace.json"), JSON.stringify(manifest));
  const file = path.join(f.root, ".crew/agents/assistant.json");
  const spec = JSON.parse(readFileSync(file, "utf8")); spec.hooks = ["approval.rejected"]; writeFileSync(file, JSON.stringify(spec));
  const run = f.store.enqueue({ agent: "assistant", prompt: "Work" });
  const action = f.store.queueAction({ runId: run.id, action: "example.send", payload: {}, dedupeKey: "one" });
  f.store.decideAction(action.id, "reject");
  const route = () => routeLifecycleEvents({ targetRoot: f.root, store: f.store, governance: f.governance });
  assert.equal(route().created, 1); assert.equal(route().created, 0);
  assert.equal(f.store.getAction(action.id).status, "rejected");
  const child = f.store.db.prepare("SELECT * FROM runtime_runs WHERE parent_id=?").get(run.id);
  f.store.event(child.id, "approval.rejected");
  assert.equal(route().created, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM runtime_runs").get().n, 2);
});

test("bundled host works without provider secrets, exposes workspace reviews and remains private", async (t) => {
  const f = fixture(t);
  const host = createHost({ targetRoot: f.root, env: f.env });
  t.after(() => host.stop());
  await host.start();
  assert.equal(host.ingress, null);
  assert.equal(host.privateConsoleOnly, true);
  const proposal = await host.operations.proposeSetup({ title: "Guide", changes: [{ path: "knowledge/guide.md", content: "Owner-reviewed guide" }] });
  const snapshot = await host.operations.getSnapshot();
  assert.equal(snapshot.workspaceProposals[0].id, proposal.id);
  assert.ok(snapshot.connectors.every((c) => !c.configured));
  assert.doesNotMatch(JSON.stringify(snapshot), /host\.key|CREWRUN_INTEGRATIONS_KEY/);
  const html = renderPartial("reviews", collectModels(f.root, { operations: snapshot }), { tab: "workspace", selectedReview: proposal.id });
  assert.match(html, /Edit proposal before approval/);
  assert.match(html, /Owner-reviewed guide/);
  const tools = host.runtime.tools.toolHandlers({ role: "assistant", toolContext: { targetRoot: f.root } });
  assert.ok(tools.some((tool) => tool.toolName === "task.list"));
});

test("governed Claude turns expose no native filesystem, shell, web or subagent tools", async () => {
  let options;
  const engine = createClaudeAgentEngine({ loadSdk: async () => ({ query: (input) => { options = input.options; return (async function* () { yield { type: "result", subtype: "success", result: "Done" }; })(); } }) });
  await new Promise((resolve, reject) => engine.startTurn({ profile: {}, workdir: os.tmpdir(), mode: "execute", role: "assistant", capabilities: { subagents: { allowed: true } }, prompt: "test", toolContext: { governedToolsOnly: true, nativeWeb: true, web: { allow: [] } }, onClose: resolve, onError: reject }));
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.agents, undefined);
});

test("personal and organization presets complete the same question/review workflow with no custom host", async (t) => {
  setEngineForTests("claude-agent", {
    id: "claude-agent", capabilities: { agentic: true, governedToolsOnly: true },
    startTurn(input) {
      assert.equal(input.toolContext.governedToolsOnly, true);
      assert.notEqual(input.workdir, input.targetRoot);
      Promise.resolve().then(async () => {
        const tools = input.tools.toolHandlers({ role: input.role, toolContext: input.toolContext });
        if (!`${input.prompt}\n${input.systemPrompt}`.includes('"answer":"Monday"')) {
          const answer = await tools.find((tool) => tool.toolName === "task.askOwner").invoke({ question: "Which day?", options: ["Monday"] });
          assert.equal(answer.isError, undefined);
          input.onLine("Waiting for your choice");
        } else {
          const write = await tools.find((tool) => tool.toolName === "workspace.writeDraft").invoke({ path: `drafts/${input.role}/result.md`, content: "Monday result" });
          assert.equal(write.isError, undefined);
          input.onLine("Monday result delivered as a draft");
        }
        input.onClose({ code: 0, engineSessionId: "test-session", usage: { inputTokens: 10, outputTokens: 10 } });
      }).catch(input.onError);
      return { kill() {} };
    }
  });
  t.after(() => setEngineForTests("claude-agent", null));
  for (const kind of ["personal", "organization"]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "crew-rehearsal-"));
    const root = path.join(directory, "repo");
    initializeWorkspace(root, { kind });
    const host = createHost({ targetRoot: root, env: { CREW_HOME: path.join(directory, "private") } });
    try {
      await host.start();
      const role = kind === "personal" ? "assistant" : "coordinator";
      const task = host.operations.enqueueTask({ agent: role, prompt: "Prepare the chosen day", criteria: "A saved draft" });
      await host.runtime.tick();
      const snapshot = await host.operations.getSnapshot();
      assert.equal(snapshot.runs[0].status, "waiting");
      host.operations.answerQuestion({ id: snapshot.runs[0].questions[0].id, answer: "Monday" });
      await host.runtime.tick();
      assert.equal(host.runtime.store.getRun(task.id).status, "completed");
      host.operations.controlTask({ id: task.id, action: "accept" });
      assert.ok(host.runtime.store.getRun(task.id).accepted_at);
      assert.equal(readFileSync(path.join(root, `drafts/${role}/result.md`), "utf8"), "Monday result");
      assert.ok((await host.operations.getSnapshot()).audit.some((entry) => entry.tool_name === "workspace.writeDraft"));
    } finally { await host.stop(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("workspace timezone is independent of process timezone and handles a DST gap", () => {
  assert.equal(nextRun("0 9 * * *", new Date("2026-09-08T00:00:00Z"), { timezone: "America/Phoenix" }).toISOString(), "2026-09-08T16:00:00.000Z");
  assert.equal(nextRun("30 2 * * *", new Date("2026-03-08T06:00:00Z"), { timezone: "America/New_York" }).toISOString(), "2026-03-09T06:30:00.000Z");
});

test("rejected external actions remain rejected across an explicitly requested revision", (t) => {
  const f = fixture(t);
  const task = f.store.enqueue({ agent: "assistant", prompt: "Draft and send" });
  const claim = f.store.claimRun(task.id);
  const action = f.store.queueAction({ runId: task.id, action: "example.send", payload: {}, dedupeKey: "reject-me" });
  f.store.finishRun(claim, { text: "Prepared" });
  f.store.decideAction(action.id, "reject");
  assert.throws(() => f.store.controlRun(task.id, "accept"), /deliveries/);
  f.store.controlRun(task.id, "request_changes", { feedback: "Keep this as a draft; do not send it." });
  const revised = f.store.claimRun(task.id); f.store.finishRun(revised, { text: "Draft only" });
  f.store.controlRun(task.id, "accept");
  assert.equal(f.store.getAction(action.id).status, "rejected");
  assert.equal(f.store.claimAction(), null);
});

test("a role policy change resets model context while retaining the owner's chat transcript", async (t) => {
  const f = fixture(t);
  const calls = [];
  const runner = { startAgentTurn(input) { calls.push(input); queueMicrotask(() => input.onClose({ code: 0, text: "Done", engineSessionId: `session-${calls.length}` })); return { kill() {} }; } };
  const chats = createConsoleChatService({ targetRoot: f.root, getDb: () => f.store.db, createRunner: () => runner });
  const first = await chats.sendChat({ role: "assistant", message: "Old sensitive context" });
  await chats.sendChat({ role: "assistant", message: "Continue" });
  assert.equal(calls[1].resumeSessionId, "session-1");
  const file = path.join(f.root, ".crew/agents/assistant.json");
  const spec = JSON.parse(readFileSync(file, "utf8")); spec.contract.revision++; writeFileSync(file, JSON.stringify(spec));
  const after = await chats.sendChat({ role: "assistant", message: "New permitted context" });
  assert.equal(first.id, after.id);
  assert.equal(calls[2].resumeSessionId, null);
  assert.equal(calls[2].messages.length, 1);
  assert.equal(after.messages.length, 6);
});
