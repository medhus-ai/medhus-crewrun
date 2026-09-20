import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { createKnowledgeModels, downloadModel, verifyModel, EMBEDDING_MODEL } from "../src/knowledge-models.js";

const bytes = Buffer.from("GGUF fixture data");
const tiny = { ...EMBEDDING_MODEL, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
function fixture(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "crew-model-"));
  const store = { file: path.join(dir, "state.sqlite"), db: new Database(path.join(dir, "state.sqlite")) };
  const manager = createKnowledgeModels({ store, model: tiny, processRunner: async () => ({ matches: [{ score: 0.5 }] }),
    fetchImpl: async () => new Response(bytes), ...options });
  t.after(async () => { await manager.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { manager, dir, store };
}

test("download validates hash, exact size and redirects; never trusts arbitrary hosts", async (t) => {
  const { dir } = fixture(t);
  const file = path.join(dir, "model.part");
  const calls = [];
  await downloadModel({ file, model: tiny, fetchImpl: async (url, options) => {
    calls.push(String(url)); assert.equal(options.redirect, "manual");
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://cas-bridge.xethub.hf.co/file" } }) : new Response(bytes);
  } });
  await verifyModel(file, tiny); assert.equal(calls.length, 2);
  rmSync(file);
  for (const location of ["http://huggingface.co/file", "https://localhost/file", "https://huggingface.co.evil.test/file", "https://user:password@huggingface.co/file"]) {
    await assert.rejects(downloadModel({ file, model: tiny, fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) }), /Unapproved/);
  }
  for (const content of ["short", "different bytes!", "x".repeat(100)]) {
    await assert.rejects(downloadModel({ file, model: tiny, fetchImpl: async () => new Response(content) }), /checksum|size/);
    rmSync(file, { force: true });
  }
});

test("setup requires consent and publishes ready only after a real-worker verification result", async (t) => {
  let release;
  const { manager, store } = fixture(t, { processRunner: () => new Promise((r) => { release = r; }) });
  assert.throws(() => manager.install(), /terms/);
  manager.install({ consent: true });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(manager.snapshot().ready, false);
  assert.equal(manager.snapshot().status, "verifying");
  const second = createKnowledgeModels({ store, model: tiny });
  assert.throws(() => second.install({ consent: true }), /already running/);
  assert.throws(() => manager.configure({ enabled: false }), /cancel/);
  release({ matches: [{ score: 0.7 }] }); await manager.idle();
  assert.equal(manager.snapshot().ready, true); assert.equal(manager.snapshot().enabled, true);
  assert.equal(manager.snapshot().status, "ready");
  manager.configure({ enabled: false, fallback: false });
  assert.equal(second.snapshot().enabled, false); assert.equal(second.snapshot().fallback, false);
});

test("bad download can retry, partial files are removed, and cancellation never marks ready", async (t) => {
  let attempt = 0;
  const { manager } = fixture(t, { fetchImpl: async () => new Response(++attempt === 1 ? "bad" : bytes) });
  manager.install({ consent: true }); await manager.idle();
  assert.equal(manager.snapshot().status, "failed"); assert.equal(manager.snapshot().ready, false);
  manager.install({ consent: true }); await manager.idle(); assert.equal(manager.snapshot().ready, true);

  const cancelled = fixture(t, { fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
  cancelled.manager.install({ consent: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  cancelled.manager.cancel(); await cancelled.manager.idle();
  assert.equal(cancelled.manager.snapshot().ready, false); assert.equal(cancelled.manager.snapshot().status, "cancelled");
});

test("restart recovers stale lease and verifies an existing artifact without downloading", async (t) => {
  const { manager, store } = fixture(t, { fetchImpl: async () => { throw new Error("must not download"); } });
  mkdirSync(manager.directory, { recursive: true }); writeFileSync(path.join(manager.directory, tiny.file), bytes);
  const part = path.join(manager.directory, "00000000-0000-0000-0000-000000000000.part"); writeFileSync(part, "partial");
  store.db.prepare("UPDATE knowledge_setup SET token='old',lease=0,status='downloading'").run();
  assert.match(manager.snapshot().status, /interrupted/);
  manager.install({ consent: true }); await manager.idle();
  assert.equal(manager.snapshot().ready, true); assert.equal(existsSync(part), false);
  assert.equal(readFileSync(path.join(manager.directory, tiny.file), "utf8"), bytes.toString());
});

test("verification failure never enables embeddings and diagnostics stay redacted", async (t) => {
  const { manager } = fixture(t, { processRunner: async () => { throw new Error("secret document and https://signed-url?token=secret"); } });
  manager.install({ consent: true }); await manager.idle();
  assert.equal(manager.snapshot().ready, false); assert.equal(manager.snapshot().enabled, false);
  assert.doesNotMatch(JSON.stringify(manager.snapshot()), /secret|signed-url/);
});

test("live pinned model download and sandbox smoke verification", { timeout: 1800000 }, async (t) => {
  if (process.env.CREW_LIVE_KNOWLEDGE_INSTALL !== "1") return t.skip("set CREW_LIVE_KNOWLEDGE_INSTALL=1 for the 334 MB download and real sandbox check");
  const { manager } = fixture(t, { model: EMBEDDING_MODEL, processRunner: undefined, fetchImpl: fetch });
  manager.install({ consent: true }); await manager.idle();
  assert.equal(manager.snapshot().ready, true, JSON.stringify(manager.snapshot()));
});
