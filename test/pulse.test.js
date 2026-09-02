import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createPulse, heartbeatDue, hookExternalId, loadRoleSettings, parseInterval, readHeartbeatState, validateRoleSettings, MAX_INTERVAL_S } from "../src/pulse.js";

async function projectWith(roleFrontmatter) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-pulse-"));
  const root = path.join(parent, "repo");
  const roles = path.join(root, ".crew", "roles");
  await mkdir(roles, { recursive: true });
  await writeFile(path.join(roles, "ops.md"), `---\nname: ops\n${roleFrontmatter}\n---\n# Ops\n`, "utf8");
  return { parent, root };
}

test("parseInterval covers 1s to 1y, off states, and rejects garbage", () => {
  assert.equal(parseInterval("1s"), 1);
  assert.equal(parseInterval("90s"), 90);
  assert.equal(parseInterval("30m"), 1800);
  assert.equal(parseInterval("1h"), 3600);
  assert.equal(parseInterval("2d"), 172800);
  assert.equal(parseInterval("1mo"), 2629800);
  assert.equal(parseInterval("1y"), MAX_INTERVAL_S);
  assert.equal(parseInterval("45"), 45);
  assert.equal(parseInterval("off"), null);
  assert.equal(parseInterval(""), null);
  assert.ok(Number.isNaN(parseInterval("soon")));
  assert.ok(Number.isNaN(parseInterval("5 fortnights")));
});

test("role settings load from frontmatter and validate bounds, unknown events, and cost warnings", async () => {
  const { parent, root } = await projectWith("heartbeat: 5s\nhooks: [task.assigned, bogus.event]");
  try {
    const settings = loadRoleSettings(root);
    assert.equal(settings.ops.heartbeat.intervalSeconds, 5);
    assert.deepEqual(settings.ops.hooks, ["task.assigned", "bogus.event"]);
    const { problems, warnings } = validateRoleSettings(settings, { knownEvents: ["task.assigned"] });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /bogus\.event/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sub-minute/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a role without the new keys has no heartbeat and no hooks", async () => {
  const { parent, root } = await projectWith("title: Ops");
  try {
    const settings = loadRoleSettings(root);
    assert.equal(settings.ops.heartbeat, null);
    assert.deepEqual(settings.ops.hooks, []);
    assert.deepEqual(validateRoleSettings(settings, { knownEvents: [] }).problems, []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("heartbeats fire when due, never overlap, persist state, and respect the budget cap", async () => {
  const { parent, root } = await projectWith("heartbeat: 10s\nheartbeat_budget_usd_per_day: 1");
  try {
    let clock = new Date("2026-09-02T10:00:00Z");
    let spent = 0;
    const turns = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const pulse = createPulse({
      targetRoot: root,
      env: { CREW_HOME: path.join(parent, "home") },
      now: () => clock,
      spentToday: () => spent,
      runTurn: (role, prompt) => { turns.push([role, prompt.slice(0, 9)]); return gate; },
      enqueue: () => ({ created: true }),
      routeEvent: () => []
    });

    await pulse.tickHeartbeats();
    assert.equal(turns.length, 1, "a never-run heartbeat is due immediately");
    clock = new Date("2026-09-02T10:00:20Z");
    await pulse.tickHeartbeats();
    assert.equal(turns.length, 1, "an in-flight pulse is never overlapped");
    release();
    await gate;
    await new Promise((resolve) => setImmediate(resolve)); // let the pulse's finally clear the running flag
    await pulse.tickHeartbeats();
    assert.equal(turns.length, 2, "due again after the interval once the previous pulse finished");
    const state = readHeartbeatState(root, { CREW_HOME: path.join(parent, "home") });
    assert.equal(state.roles.ops.lastRunAt, "2026-09-02T10:00:20.000Z");

    spent = 2;
    clock = new Date("2026-09-02T10:05:00Z");
    await pulse.tickHeartbeats();
    assert.equal(turns.length, 2, "the daily budget cap skips the pulse");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("hooks route through the host and debounce within a bucket", async () => {
  const { parent, root } = await projectWith("hooks: [task.assigned]");
  try {
    const sent = [];
    const seen = new Set();
    const pulse = createPulse({
      targetRoot: root,
      now: () => new Date("2026-09-02T10:00:00Z"),
      runTurn: async () => {},
      enqueue: ({ role, body, externalId }) => {
        const created = !seen.has(externalId);
        seen.add(externalId);
        if (created) sent.push({ role, body, externalId });
        return { created };
      },
      routeEvent: (event, payload, settings) => Object.values(settings).filter((s) => s.hooks.includes(event)).map((s) => s.role),
      renderEvent: (event, payload) => `${event}: ${payload.id}`
    });
    pulse.emit("task.assigned", { id: "t-1" });
    pulse.emit("task.assigned", { id: "t-1" });
    pulse.emit("other.event", { id: "t-1" });
    assert.equal(sent.length, 1, "duplicate events debounce; unsubscribed events do not deliver");
    assert.equal(sent[0].role, "ops");
    assert.equal(sent[0].body, "task.assigned: t-1");
    assert.equal(hookExternalId("e", "r", "k", new Date(0)), "hook:e:r:k:0");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
