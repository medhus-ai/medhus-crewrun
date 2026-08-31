import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createExecuteWorktree } from "../src/workspace.js";

test("execute worktrees require a git repository", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crew-not-a-repo-"));
  assert.throws(() => createExecuteWorktree(dir, "engineer"), /git repository/);
});

test("execute worktrees use the host branch prefix and report creation", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "crew-worktree-"));
  const repo = path.join(base, "repo");
  await mkdir(repo);
  spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "init"], { encoding: "utf8" });
  const seen = [];
  const created = createExecuteWorktree(repo, "CEO brief", { branchPrefix: "acme", onCreated: (root, info) => seen.push([root, info.branch]) });
  try {
    assert.match(created.branch, /^acme\/ceo-brief-/);
    assert.ok(existsSync(created.dir));
    assert.deepEqual(seen, [[path.resolve(repo), created.branch]]);
    assert.match(createExecuteWorktree(repo, "x").branch, /^crew\/x-/);
  } finally {
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", created.dir], { encoding: "utf8" });
    await rm(base, { recursive: true, force: true });
  }
});
