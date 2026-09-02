import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { upsertSchedule } from "../src/schedules.js";
import { createUp, defaultRouteEvent, loadHostModule } from "../src/up.js";

async function project({ role = "ops", frontmatter = "title: Ops" } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-up-"));
  const root = path.join(parent, "repo");
  await mkdir(path.join(root, ".crew", "roles"), { recursive: true });
  await writeFile(path.join(root, ".crew", "roles", `${role}.md`), `---\nname: ${role}\n${frontmatter}\n---\n# Role\n`, "utf8");
  return { parent, root, env: { CREW_HOME: path.join(parent, "home") } };
}

test("createUp runs due schedules and heartbeats through the host's runTurn", async () => {
  const { parent, root, env } = await project({ frontmatter: "heartbeat: 10s" });
  try {
    upsertSchedule({ targetRoot: root, schedule: { id: "tick", role: "ops", cron: "* * * * *", prompt: "scheduled work" } });
    const turns = [];
    const up = createUp({
      targetRoot: root,
      env,
      now: () => new Date("2026-09-02T10:00:05Z"),
      host: { runTurn: async (role, prompt, meta) => { turns.push([role, meta.workflow]); return { ok: true, text: "done" }; } }
    });
    await up.tickOnce();
    assert.deepEqual(turns.sort((a, b) => a[1].localeCompare(b[1])), [["ops", "heartbeat"], ["ops", "schedule"]]);
    await up.tickOnce();
    assert.equal(turns.length, 2, "same minute and interval: nothing fires twice");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("hooks are disabled with one notice when the host has no enqueue; host tick runs", async () => {
  const { parent, root, env } = await project({ frontmatter: "hooks: [thing.happened]" });
  try {
    const logs = [];
    let ticks = 0;
    const up = createUp({
      targetRoot: root,
      env,
      log: (line) => logs.push(line),
      host: { runTurn: async () => ({ ok: true, text: "x" }), tick: () => { ticks += 1; } }
    });
    up.emit("thing.happened", { id: "1" });
    up.emit("thing.happened", { id: "2" });
    assert.equal(logs.filter((line) => line.includes("hooks are disabled")).length, 1);
    await up.tickOnce();
    assert.equal(ticks, 1);
    assert.deepEqual(defaultRouteEvent("thing.happened", {}, { ops: { role: "ops", hooks: ["thing.happened"] } }), ["ops"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("loadHostModule accepts createHost factories and plain host objects", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-up-host-"));
  try {
    const factory = path.join(parent, "factory.mjs");
    await writeFile(factory, "export function createHost({ targetRoot }) { return { name: 'f', targetRoot }; }", "utf8");
    const object = path.join(parent, "object.mjs");
    await writeFile(object, "export default { name: 'o' };", "utf8");
    const bad = path.join(parent, "bad.mjs");
    await writeFile(bad, "export const nothing = 1;", "utf8");

    assert.equal((await loadHostModule(factory, { targetRoot: "/t" })).name, "f");
    assert.equal((await loadHostModule(factory, { targetRoot: "/t" })).targetRoot, "/t");
    assert.equal((await loadHostModule(object, { targetRoot: "/t" })).name, "o");
    assert.deepEqual(await loadHostModule("", {}), {});
    await assert.rejects(loadHostModule(bad, { targetRoot: "/t" }), /neither createHost/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
