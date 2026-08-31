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

test("loadRoleMemory rejects relative and absolute paths outside .gitcrew", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-role-memory-"));
  const root = path.join(parent, "repo");
  const allowed = path.join(root, ".gitcrew", "memory", "allowed.md");
  const outside = path.join(parent, "outside.md");
  await mkdir(path.dirname(allowed), { recursive: true });
  await writeFile(allowed, "allowed marker", "utf8");
  await writeFile(outside, "outside marker", "utf8");

  try {
    const sections = loadRoleMemory(root, roleWithPointers(
      ".gitcrew/memory/allowed.md",
      "../outside.md",
      outside
    ), { universal: [] });
    assert.deepEqual(sections.map((section) => section.body), ["allowed marker"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("loadRoleMemory rejects a symlink that escapes the repository", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-role-symlink-"));
  const root = path.join(parent, "repo");
  const memory = path.join(root, ".gitcrew", "memory");
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
    assert.deepEqual(loadRoleMemory(root, roleWithPointers(".gitcrew/memory/linked.md"), { universal: [] }), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
