import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRuntimeStore } from "../src/runtime-store.js";
import { createRuntimeScheduler } from "../src/runtime-scheduler.js";

function fixture(t) {
  const parent = mkdtempSync(path.join(os.tmpdir(), "crew-durable-"));
  const targetRoot = path.join(parent, "repo");
  const env = { CREW_HOME: path.join(parent, "private") };
  mkdirSync(path.join(targetRoot, ".crew/agents"), { recursive: true });
  let at = Date.now();
  const handles = [];
  const options = { targetRoot, env, now: () => at, leaseMs: 1000 };
  const store = createRuntimeStore(options); handles.push(store);
  t.after(async () => { for (const handle of handles.reverse()) await handle.close(); rmSync(parent, { recursive: true, force: true }); });
  return { ...options, options, store, advance: (ms) => { at += ms; }, keep: (handle) => { handles.push(handle); return handle; } };
}
function actionFor(store, runId, key = "action") {
  return store.queueAction({ runId, action: "slack.postMessage", payload: { role: "ops", input: { channel: "C123", text: "Hello" } }, dedupeKey: key });
}

test("two independent processes cannot claim the same task", async (t) => {
  const f = fixture(t);
  const run = f.store.enqueue({ agent: "ops", prompt: "Do this once", dedupeKey: "once" });
  const moduleUrl = new URL("../src/runtime-store.js", import.meta.url).href;
  const code = `import {createRuntimeStore} from ${JSON.stringify(moduleUrl)}; const s=createRuntimeStore(JSON.parse(process.argv[1])); console.log(JSON.stringify(s.claimRun())); s.close();`;
  const claim = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify({ targetRoot: f.targetRoot, env: f.env })]);
    let output = "", error = "";
    child.stdout.on("data", (b) => { output += b; }); child.stderr.on("data", (b) => { error += b; });
    child.on("error", reject); child.on("close", (status) => status ? reject(new Error(error)) : resolve(JSON.parse(output)));
  });
  const claims = await Promise.all([claim(), claim()]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean).id, run.id);
  assert.equal(f.store.enqueue({ agent: "ops", prompt: "duplicate", dedupeKey: "once" }).created, false);
});

test("expired workers are fenced, interrupted tasks need review, and sends become uncertain", (t) => {
  const f = fixture(t);
  const run = f.store.enqueue({ agent: "ops", prompt: "Recover" });
  const claimed = f.store.claimRun();
  const action = actionFor(f.store, run.id);
  f.store.decideAction(action.id, "approve");
  const delivery = f.store.claimAction();
  assert.equal(f.store.claimAction(), null);
  f.advance(1001); f.store.recover();
  assert.equal(f.store.getRun(run.id).status, "interrupted");
  assert.equal(f.store.getAction(action.id).status, "uncertain");
  assert.equal(f.store.finishRun(claimed, { ok: true, text: "Stale result" }), false);
  assert.equal(f.store.finishAction(delivery, { status: "delivered", receipt: { ts: "1" } }), false);
  assert.equal(f.store.claimAction(), null);
  assert.throws(() => f.store.reconcile(action.id, { outcome: "not_sent", evidence: "" }), /evidence/);
  f.store.reconcile(action.id, { outcome: "not_sent", evidence: "Provider confirmed it never accepted this request." });
  assert.equal(f.store.getAction(action.id).status, "awaiting_approval");
  f.store.controlRun(run.id, "retry");
  assert.equal(f.store.claimRun().attempt, 2);
  assert.equal(actionFor(f.store, run.id).id, action.id, "a restarted task reuses the same durable action");
});

test("artifacts, completion, and ledger commit together; acceptance unblocks dependencies", (t) => {
  const f = fixture(t);
  const first = f.store.enqueue({ agent: "ops", prompt: "Produce result" });
  const second = f.store.enqueue({ agent: "ops", prompt: "Use accepted result", dependencies: [first.id] });
  const claimed = f.store.claimRun(first.id);
  assert.equal(f.store.claimRun(second.id), null);
  assert.throws(() => f.store.finishRun(claimed, { ok: true, text: "not committed", artifacts: [{ content: 123 }] }), /Artifact/);
  assert.equal(f.store.ledger.readRuns().length, 0);
  assert.equal(f.store.snapshot().runs.find((r) => r.id === first.id).artifacts.length, 0);
  assert.equal(f.store.finishRun(claimed, { ok: true, text: "Useful deliverable", usage: { inputTokens: 12, outputTokens: 24, costUsd: 0.02 } }), true);
  assert.equal(f.store.finishRun(claimed, { ok: true }), false);
  assert.equal(f.store.ledger.readRuns().length, 1);
  assert.equal(f.store.claimRun(second.id), null);
  f.store.controlRun(first.id, "accept");
  assert.equal(f.store.snapshot().outcomes.accepted, 1);
  assert.ok(f.store.claimRun(second.id));
});

test("pause and cancel stop future claims; cancellation cannot hide an in-flight send", (t) => {
  const f = fixture(t);
  const run = f.store.enqueue({ agent: "ops", prompt: "Pause" });
  const action = actionFor(f.store, run.id);
  f.store.decideAction(action.id, "approve");
  f.store.controlRun(run.id, "pause");
  assert.equal(f.store.claimRun(), null); assert.equal(f.store.claimAction(), null);
  f.store.controlRun(run.id, "resume");
  const delivery = f.store.claimAction();
  f.store.controlRun(run.id, "cancel");
  f.store.finishAction(delivery, { status: "delivered", receipt: { channel: "C123", ts: "10.1" } });
  assert.equal(f.store.getRun(run.id).desired, "cancelled");
  assert.equal(f.store.getAction(action.id).status, "delivered");
  assert.throws(() => f.store.controlRun(run.id, "accept"), /completed/);
});

test("transactional triggers coalesce missed windows across scheduler instances", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.targetRoot, ".crew/agents/ops.json"), JSON.stringify({ scheduled: [{ id: "minute", cron: "* * * * *", prompt: "Update" }], heartbeat: "1h" }));
  const other = f.keep(createRuntimeStore(f.options));
  const one = createRuntimeScheduler({ ...f.options, runtime: { store: f.store }, now: () => new Date(f.options.now()) });
  const two = createRuntimeScheduler({ ...f.options, runtime: { store: other }, now: () => new Date(f.options.now()) });
  assert.equal(one.tick().length, 2);
  assert.equal(two.tick().length, 0);
  assert.equal(f.store.snapshot().runs.length, 2);
});

test("runtime scheduler ignores roles without a heartbeat", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.targetRoot, ".crew/agents/ops.json"), JSON.stringify({ title: "Operations" }));
  const scheduler = createRuntimeScheduler({ ...f.options, runtime: { store: f.store }, now: () => new Date(f.options.now()) });
  assert.deepEqual(scheduler.tick(), []);
});
