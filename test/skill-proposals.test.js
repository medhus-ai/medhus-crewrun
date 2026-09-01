import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { crewDir } from "../src/crew-dirs.js";
import { approveSkill, listSkillProposals, proposeSkill, rejectSkill } from "../src/skill-proposals.js";
import { listSkills, readSkill } from "../src/skills.js";

test("a proposed skill becomes a scoped SKILL.md only after approval", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "crew-skill-proposals-"));
  const workspace = path.join(base, "workspace");
  const repo = path.join(workspace, "repo");
  const env = { CREW_HOME: path.join(base, "home") };

  const proposal = proposeSkill({
    targetRoot: repo,
    id: "weekly-brief",
    description: "How this company writes the Monday brief.",
    content: "# Weekly brief\n\n1. Read open items.\n2. Rank by blocker.\n",
    roles: ["ceo"],
    scope: "workspace",
    evidence: "Asked for three weeks running.",
    proposedBy: "ceo"
  });
  assert.equal(proposal.status, "pending");
  assert.deepEqual(listSkillProposals({ targetRoot: repo }).map((p) => p.skillId), ["weekly-brief"]);
  assert.deepEqual(listSkills({ targetRoot: repo, workspaceRoot: workspace, role: "ceo", env }), [], "nothing is installed before approval");

  const approved = approveSkill({ targetRoot: repo, workspaceRoot: workspace, proposalId: proposal.id, approvedBy: "founder", env });
  assert.equal(approved.status, "approved");
  assert.equal(approved.installedAt, path.join(workspace, crewDir(), "skills", "weekly-brief", "SKILL.md"));
  const file = readFileSync(approved.installedAt, "utf8");
  assert.match(file, /^---\nname: weekly-brief\ndescription: How this company writes the Monday brief\.\nroles: \[ceo\]\nproposed_by: ceo\napproved_by: founder\napproved_at: /);
  assert.match(file, /# Weekly brief\n\n1\. Read open items\./);

  const skills = listSkills({ targetRoot: repo, workspaceRoot: workspace, role: "ceo", env });
  assert.deepEqual(skills.map((s) => [s.id, s.scope]), [["weekly-brief", "workspace"]]);
  assert.match(readSkill({ targetRoot: repo, workspaceRoot: workspace, id: "weekly-brief", role: "ceo", env }).content, /Rank by blocker/);
  assert.deepEqual(listSkills({ targetRoot: repo, workspaceRoot: workspace, role: "ops", env }), [], "role-scoped");
  assert.deepEqual(listSkillProposals({ targetRoot: repo }), []);
  assert.throws(() => approveSkill({ targetRoot: repo, workspaceRoot: workspace, proposalId: proposal.id, env }), /already approved/);
  assert.match(readFileSync(path.join(repo, crewDir(), "memory", "changelog.jsonl"), "utf8"), /skill\.proposed[\s\S]*skill\.approved/);
});

test("rejected proposals install nothing and inputs are validated", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "crew-skill-reject-"));
  const proposal = proposeSkill({ targetRoot: repo, id: "noisy", description: "x", content: "body" });
  const rejected = rejectSkill({ targetRoot: repo, proposalId: proposal.id, approvedBy: "founder" });
  assert.equal(rejected.status, "rejected");
  assert.equal(existsSync(path.join(repo, crewDir(), "skills")), false);
  assert.throws(() => proposeSkill({ targetRoot: repo, id: "Bad Id", description: "x", content: "y" }), /lowercase slug/);
  assert.throws(() => proposeSkill({ targetRoot: repo, id: "ok", description: "", content: "y" }), /description/);
  assert.throws(() => proposeSkill({ targetRoot: repo, id: "ok", description: "x", content: "---\nname: sneaky\n---\n" }), /body only/);
  assert.throws(() => proposeSkill({ targetRoot: repo, id: "ok", description: "x", content: "y", scope: "global" }), /scope/);
  assert.throws(() => rejectSkill({ targetRoot: repo, proposalId: "skill-missing" }), /not found/);
});
