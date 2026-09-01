import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  approvePreference,
  listPreferenceProposals,
  listPreferences,
  proposePreference,
  rejectPreference
} from "../src/preference-memory.js";

test("preference memory requires approval and applies scoped precedence", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "crew-preferences-"));
  const workspace = path.join(base, "workspace");
  const repo = path.join(workspace, "repo");
  const env = { CREW_HOME: path.join(base, "user-home") };

  for (const [scope, statement] of [["user", "run broad tests"], ["workspace", "run package tests"], ["repository", "run focused tests first"]]) {
    const proposal = proposePreference({ targetRoot: repo, workspaceRoot: workspace, key: "testing.order", statement, scope, proposedBy: "engineer", env });
    assert.equal(listPreferences({ targetRoot: repo, workspaceRoot: workspace, env }).effective.length, scope === "user" ? 0 : scope === "workspace" ? 1 : 1);
    approvePreference({ targetRoot: repo, workspaceRoot: workspace, proposalId: proposal.id, env });
  }

  const memory = listPreferences({ targetRoot: repo, workspaceRoot: workspace, env });
  assert.equal(memory.effective.find((entry) => entry.key === "testing.order").statement, "run focused tests first");
  assert.equal(listPreferenceProposals({ targetRoot: repo }).length, 0);
  const changelog = path.join(repo, ".crew/memory/changelog.jsonl");
  assert.equal(existsSync(changelog), true);
  assert.match(readFileSync(changelog, "utf8"), /preference\.approved/);
});

test("rejected preferences never become active", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "crew-preference-reject-"));
  const proposal = proposePreference({ targetRoot: repo, key: "style.quotes", statement: "Use single quotes", scope: "repository" });
  rejectPreference({ targetRoot: repo, proposalId: proposal.id });
  assert.equal(listPreferences({ targetRoot: repo }).effective.length, 0);
  assert.equal(listPreferenceProposals({ targetRoot: repo, status: "rejected" }).length, 1);
});
