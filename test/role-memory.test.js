import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadRoleMemory } from "../src/runner.js";

function roleWithPointers(...pointers) {
  return [
    "---",
    "name: test-role",
    "memory_pointers:",
    ...pointers.map((pointer) => `  - ${pointer}`),
    "triggers:",
    "  - test",
    "---",
    "# Test role"
  ].join("\n");
}

test("loadRoleMemory allows any path inside the repository and rejects paths outside it", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-role-memory-"));
  const root = path.join(parent, "repo");
  const allowed = path.join(root, ".crew", "memory", "allowed.md");
  const identity = path.join(root, "personas", "ceo", "SOUL.md");
  const outside = path.join(parent, "outside.md");
  await mkdir(path.dirname(allowed), { recursive: true });
  await mkdir(path.dirname(identity), { recursive: true });
  await writeFile(allowed, "allowed marker", "utf8");
  await writeFile(identity, "identity marker", "utf8");
  await writeFile(outside, "outside marker", "utf8");

  try {
    const sections = loadRoleMemory(root, roleWithPointers(
      ".crew/memory/allowed.md",
      "personas/ceo/SOUL.md",
      "../outside.md",
      outside
    ), { universal: [] });
    assert.deepEqual(sections.map((section) => section.body), ["allowed marker", "identity marker"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("loadRoleMemory rejects a symlink that escapes the repository", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-role-symlink-"));
  const root = path.join(parent, "repo");
  const memory = path.join(root, ".crew", "memory");
  const outside = path.join(parent, "outside.md");
  const link = path.join(memory, "linked.md");
  await mkdir(memory, { recursive: true });
  await writeFile(outside, "outside marker", "utf8");

  try {
    try {
      await symlink(outside, link, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`file symlinks are unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.deepEqual(loadRoleMemory(root, roleWithPointers(".crew/memory/linked.md"), { universal: [] }), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("runnerIdForRole prefers the role file's runner frontmatter over the legacy mapping", async () => {
  const { runnerIdForRole } = await import("../src/runner.js");
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-runner-id-"));
  const root = path.join(parent, "repo");
  try {
    await mkdir(path.join(root, ".crew", "roles"), { recursive: true });
    await mkdir(path.join(root, ".crew", "memory"), { recursive: true });
    await writeFile(path.join(root, ".crew", "roles", "ops.md"), "---\nname: ops\nrunner: claude-agent-opus-high\n---\n# Ops\n", "utf8");
    await writeFile(path.join(root, ".crew", "roles", "ceo.md"), "---\nname: ceo\n---\n# CEO\n", "utf8");
    await writeFile(path.join(root, ".crew", "memory", "ai-runners.json"), JSON.stringify({ default_role_runners: { ops: "claude-agent-sonnet-low", ceo: "claude-agent-sonnet-high" } }), "utf8");
    assert.equal(runnerIdForRole("ops", root), "claude-agent-opus-high", "frontmatter wins");
    assert.equal(runnerIdForRole("ceo", root), "claude-agent-sonnet-high", "legacy mapping still works as fallback");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("role .json specs drive runner, pointers, defaults, schedules, and settings; role.md becomes optional", async () => {
  const { runnerIdForRole } = await import("../src/runner.js");
  const { loadRoleSpec, listRoleSpecs } = await import("../src/role-spec.js");
  const { loadRoleSettings } = await import("../src/pulse.js");
  const { listSchedules, upsertSchedule } = await import("../src/schedules.js");
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-rolespec-"));
  const root = path.join(parent, "repo");
  try {
    await mkdir(path.join(root, ".crew", "roles"), { recursive: true });
    await mkdir(path.join(root, "personas"), { recursive: true });
    await writeFile(path.join(root, "personas", "soul.md"), "soul marker", "utf8");
    await writeFile(path.join(root, ".crew", "roles", "_defaults.json"), JSON.stringify({
      runner: "claude-agent-sonnet-high",
      memory_pointers: ["personas/soul.md"]
    }), "utf8");
    await writeFile(path.join(root, ".crew", "roles", "ops.md"), "# Ops prompt body\nno frontmatter", "utf8");
    await writeFile(path.join(root, ".crew", "roles", "ops.json"), JSON.stringify({
      runner: "claude-agent-opus-high",
      hooks: ["thing.happened"],
      heartbeat: "2h",
      memory_pointers: [".crew/roles/ops.md"],
      schedules: [{ id: "tick", cron: "* * * * *", prompt: "do the thing" }]
    }), "utf8");
    await writeFile(path.join(root, ".crew", "roles", "ghost.json"), JSON.stringify({ reflections: false }), "utf8");

    assert.equal(runnerIdForRole("ops", root), "claude-agent-opus-high", "spec wins");
    assert.equal(runnerIdForRole("ghost", root), "claude-agent-sonnet-high", "defaults fill gaps; a role needs no .md");

    const spec = loadRoleSpec(root, "ops");
    assert.deepEqual(spec.memory_pointers, ["personas/soul.md", ".crew/roles/ops.md"], "default pointers prepend");
    assert.deepEqual(spec.reflections, { limit: 10 });
    assert.equal(loadRoleSpec(root, "ghost").reflections, false);
    assert.equal(Object.keys(listRoleSpecs(root)).length, 2);

    const settings = loadRoleSettings(root);
    assert.deepEqual(settings.ops.hooks, ["thing.happened"]);
    assert.equal(settings.ops.heartbeat.intervalSeconds, 7200);

    const schedules = listSchedules({ targetRoot: root });
    assert.deepEqual(schedules.map((s) => [s.role, s.id]), [["ops", "tick"]]);
    upsertSchedule({ targetRoot: root, schedule: { id: "tick", role: "ops", cron: "0 9 * * 1", prompt: "weekly now", enabled: false } });
    const updated = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(root, ".crew", "roles", "ops.json"), "utf8"));
    assert.equal(updated.schedules.length, 1);
    assert.equal(updated.schedules[0].cron, "0 9 * * 1", "upsert writes into the owning role's spec");
    assert.equal(updated.schedules[0].role, undefined, "the role key is implied by the file");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
