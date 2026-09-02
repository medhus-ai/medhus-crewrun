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

test("roles/runners.json registry drives runner, pointers, and settings; role.md becomes optional", async () => {
  const { runnerIdForRole, roleRegistryEntry, loadRoleMemory } = await import("../src/runner.js");
  const { loadRoleSettings } = await import("../src/pulse.js");
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-registry-"));
  const root = path.join(parent, "repo");
  try {
    await mkdir(path.join(root, ".crew", "roles"), { recursive: true });
    await mkdir(path.join(root, "personas"), { recursive: true });
    await writeFile(path.join(root, "personas", "soul.md"), "soul marker", "utf8");
    await writeFile(path.join(root, ".crew", "roles", "ops.md"), "# Ops prompt body\nno frontmatter needed", "utf8");
    await writeFile(path.join(root, ".crew", "roles", "runners.json"), JSON.stringify({
      ops: { runner: "claude-agent-opus-high", hooks: ["thing.happened"], heartbeat: "2h", memory_pointers: [".crew/roles/ops.md", "personas/soul.md"] },
      ghost: { runner: "claude-agent-sonnet-low", memory_pointers: ["personas/soul.md"] }
    }), "utf8");

    assert.equal(runnerIdForRole("ops", root), "claude-agent-opus-high");
    assert.equal(runnerIdForRole("ghost", root), "claude-agent-sonnet-low", "a role with no .md at all still resolves");
    const entry = roleRegistryEntry(root, "ops");
    const sections = loadRoleMemory(root, null, { universal: [], pointers: entry.memory_pointers });
    assert.deepEqual(sections.map((s) => s.body.trim().split("\n")[0]), ["# Ops prompt body", "soul marker"]);

    const settings = loadRoleSettings(root);
    assert.deepEqual(settings.ops.hooks, ["thing.happened"]);
    assert.equal(settings.ops.heartbeat.intervalSeconds, 7200);
    assert.equal(settings.ops.front.runner, "claude-agent-opus-high");
    assert.ok(settings.ghost, "registry-only roles appear in settings");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
