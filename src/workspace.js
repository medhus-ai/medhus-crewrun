import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Execute-mode isolation: agentic engines never edit the user's working tree. They get a
// dedicated git worktree on a fresh <branchPrefix>/* branch; the host inspects, pushes, or
// discards it afterwards (`git worktree list` / `git worktree remove`).
export function createExecuteWorktree(targetRoot, slug, { branchPrefix = "crew", onCreated } = {}) {
  const root = path.resolve(targetRoot);
  if (!existsSync(path.join(root, ".git"))) {
    throw new Error("execute mode requires the project to be a git repository");
  }
  const safeSlug = String(slug || "turn").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "turn";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const branch = `${branchPrefix}/${safeSlug}-${stamp}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), `${branchPrefix}-worktree-${safeSlug}-`));
  const result = spawnSync("git", ["-C", root, "worktree", "add", "-b", branch, dir, "HEAD"], {
    encoding: "utf8",
    timeout: 30000
  });
  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr?.trim() || "unknown error"}`);
  }
  onCreated?.(root, { dir, branch });
  return { dir, branch };
}
