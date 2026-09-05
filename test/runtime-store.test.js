import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRuntimeStore } from "../src/runtime-store.js";
import { createStandaloneRuntime } from "../src/standalone.js";
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

test("standalone sends retain retry deadlines and reconcile ambiguous responses without a duplicate", async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.targetRoot, ".crew/agents/ops.json"), JSON.stringify({ contract: { version: 1, authority: { tools: [{ name: "slack.postMessage", impact: "external-write" }], data: { write: ["connector:slack:slack"] } } } }));
  let mode = "rate", sends = 0, clientId;
  const runtime = f.keep(createStandaloneRuntime({ ...f.options, fetchImpl: async (url, options) => {
    if (url.endsWith("auth.test")) return Response.json({ ok: true, team: "Fixture" }, { headers: { "x-oauth-scopes": "chat:write,channels:history" } });
    if (url.includes("conversations.history")) return Response.json({ ok: true, messages: [{ ts: "12.1", client_msg_id: clientId }] });
    sends++; const key = JSON.parse(options.body).client_msg_id;
    assert.ok(!clientId || clientId === key); clientId = key;
    if (mode === "rate") return Response.json({}, { status: 429, headers: { "retry-after": "10" } });
    throw new Error("Socket closed after provider accepted message");
  } }));
  await runtime.operations.connect({ connectorId: "slack", credentials: { access_token: "xoxb-private-fixture" } });
  const queued = await runtime.tools.registry.call({ role: "ops", toolName: "slack.postMessage", input: { channel: "C123", text: "One update" } });
  await runtime.operations.decideApproval({ id: queued.actionId, action: "approve" });
  assert.equal((await runtime.deliver()).status, "retry_wait");
  await runtime.deliver(); assert.equal(sends, 1);
  f.advance(10_001); mode = "ambiguous";
  assert.equal((await runtime.deliver()).status, "uncertain");
  await runtime.deliver(); assert.equal(sends, 2);
  await runtime.operations.checkDelivery({ id: queued.actionId });
  assert.equal(runtime.store.getAction(queued.actionId).status, "delivered");
  assert.equal(runtime.store.getAction(queued.actionId).receipt.ts, "12.1");
});

test("standalone records captured results and can stop a running model", async (t) => {
  const f = fixture(t);
  const runtime = f.keep(createStandaloneRuntime({ ...f.options, executeTurn: async ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, reason: "Stopped", text: "Partial result" }), { once: true })) }));
  const run = runtime.store.enqueue({ agent: "ops", prompt: "Work until paused" });
  const working = runtime.tick();
  await new Promise((resolve) => setImmediate(resolve));
  runtime.operations.controlTask({ id: run.id, action: "pause" });
  await working;
  assert.equal(runtime.store.getRun(run.id).status, "paused");
  assert.equal(runtime.store.snapshot().runs[0].artifacts[0].content, "Partial result");
});

test("Gmail 403 rate-limit rejections retry safely and search matches remain review candidates", async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.targetRoot, ".crew/agents/ops.json"), JSON.stringify({ contract: { version: 1, authority: { tools: [{ name: "gmail.sendDraft", impact: "external-write" }], data: { write: ["connector:gmail:gmail"] } } } }));
  const raw = Buffer.from("Message-ID: <brief@example.test>\r\nTo: client@example.test\r\n\r\nApproved brief").toString("base64url");
  let sends = 0;
  const runtime = f.keep(createStandaloneRuntime({ ...f.options, fetchImpl: async (url) => {
    if (url.endsWith("/token")) return Response.json({ access_token: "private", scope: "https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly" });
    if (url.includes("?format=raw")) return Response.json({ message: { raw } });
    if (url.includes("/messages?")) return Response.json({ messages: [{ id: "candidate", threadId: "thread" }] });
    sends++;
    return sends === 1 ? Response.json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, { status: 403, headers: { "retry-after": "1" } }) : Response.json(null);
  } }));
  await runtime.operations.connect({ connectorId: "gmail", credentials: { client_id: "client", client_secret: "secret", refresh_token: "refresh", gmail_read: "1" } });
  const queued = await runtime.tools.registry.call({ role: "ops", toolName: "gmail.sendDraft", input: { draftId: "draft123" } });
  await runtime.operations.decideApproval({ id: queued.actionId, action: "approve" });
  assert.equal((await runtime.deliver()).status, "retry_wait");
  f.advance(3000);
  assert.equal((await runtime.deliver()).status, "uncertain");
  await runtime.operations.checkDelivery({ id: queued.actionId });
  assert.equal(runtime.store.getAction(queued.actionId).status, "uncertain", "a reused Message-ID cannot prove that this attempt sent it");
  assert.ok(runtime.store.snapshot().runs[0].timeline.some((e) => e.type === "action.receipt_candidate"));
  assert.equal(sends, 2);
});
