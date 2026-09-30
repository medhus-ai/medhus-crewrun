import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUp } from "../src/up.js";
import { createRuntimeStore } from "../src/runtime-store.js";
import { requireWorkspace } from "../src/workspace-manifest.js";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "crew-v6-up-"));
  mkdirSync(path.join(root, ".crew/agents"), { recursive: true });
  writeFileSync(path.join(root, ".crew/workspace.json"), JSON.stringify({ version: 1, id: "v6-test-workspace", timezone: "UTC" }));
  writeFileSync(path.join(root, ".crew/agents/ops.json"), JSON.stringify({ heartbeat: "1h", scheduled: [{ id: "brief", cron: "* * * * *", prompt: "Prepare brief", enabled: true }] }));
  const store = createRuntimeStore({ targetRoot: root, env: { CREW_HOME: path.join(root, "private") } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store };
}

test("v6 loop shares durable trigger claims and has no legacy event bus", async (t) => {
  const { root, store } = fixture(t);
  let ticks = 0;
  const host = { durableRuntime: { store, start() {}, stop() {} }, operations: {}, start() {}, stop() {}, tick() { ticks++; } };
  const one = createUp({ targetRoot: root, host, now: () => new Date("2026-09-08T12:00:05Z") });
  const two = createUp({ targetRoot: root, host, now: () => new Date("2026-09-08T12:00:05Z") });
  await Promise.all([one.tickOnce(), one.tickOnce(), two.tickOnce()]);
  assert.equal(store.snapshot().runs.length, 2);
  assert.equal(ticks, 2, "overlapping housekeeping in one loop is coalesced");
  assert.equal(one.emit, undefined, "events use verified ingress or transactional lifecycle rules");
});

test("v6 startup rejects legacy hosts and workspace layouts without changing their files", (t) => {
  const { root } = fixture(t);
  assert.throws(() => createUp({ targetRoot: root, host: { runTurn() {} } }), /bundled governed host/);
  mkdirSync(path.join(root, ".crew/roles"));
  writeFileSync(path.join(root, ".crew/roles/old.json"), "{}");
  assert.throws(() => requireWorkspace(root), /no longer reads .crew\/roles/);
});

test("failed host startup releases the runtime and host resources", async (t) => {
  const { root, store } = fixture(t);
  const stopped = [];
  const host = { durableRuntime: { store, stop() { stopped.push("runtime"); } }, operations: {}, start() { throw new Error("ingress unavailable"); }, stop() { stopped.push("host"); } };
  await assert.rejects(createUp({ targetRoot: root, host }).start(), /ingress unavailable/);
  assert.deepEqual(stopped, ["runtime", "host"]);
});
