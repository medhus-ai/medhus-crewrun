import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { crewToolDefinitions } from "../src/crew-tools.js";
import {
  approveReflection,
  listReflectionProposals,
  proposeReflection,
  reflectionProposalsPath,
  rejectReflection
} from "../src/reflection-proposals.js";
import { listPreferences } from "../src/preference-memory.js";
import { readReflections, reflectionsPath } from "../src/reflections.js";
import { listSkills } from "../src/skills.js";

test("role reflections are proposed first and reach durable memory only after approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-reflection-proposals-"));
  mkdirSync(path.join(root, ".crew", "agents"), { recursive: true });
  writeFileSync(path.join(root, ".crew", "agents", "ops.json"), JSON.stringify({ reflections: true }));
  const fromTool = await crewToolDefinitions.call({
    role: "ops",
    toolName: "memory.reflect",
    input: { target: "preference", key: "weekly-blocker", evidence: "User requested blocker-first updates.", text: "Lead weekly updates with the active blocker.", ref: "weekly-brief" },
    context: { targetRoot: root }
  });

  assert.equal(fromTool.status, "pending");
  assert.equal(fromTool.role, "ops");
  assert.equal(existsSync(reflectionsPath(root, "ops")), false, "the role tool cannot silently append memory");
  assert.deepEqual(listReflectionProposals({ targetRoot: root }).map((proposal) => proposal.id), [fromTool.id]);

  const approved = approveReflection({ targetRoot: root, proposalId: fromTool.id, approvedBy: "operator" });
  assert.equal(approved.status, "approved");
  assert.equal(approved.decidedBy, "operator");
  assert.equal(approved.promotedTo.kind, "preference");
  assert.equal(readReflections({ targetRoot: root, role: "ops" }).length, 0);
  assert.equal(listPreferences({ targetRoot: root }).effective.find((p) => p.key === "weekly-blocker").statement, "Lead weekly updates with the active blocker.");
  assert.throws(() => approveReflection({ targetRoot: root, proposalId: fromTool.id }), /already approved/);

  const rejected = proposeReflection({ target: "preference", key: "specific-context", evidence: "Operator asked for minimal context.", targetRoot: root, role: "ops", text: "Do not turn routine notes into permanent rules." });
  rejectReflection({ targetRoot: root, proposalId: rejected.id, approvedBy: "operator" });
  assert.equal(readReflections({ targetRoot: root, role: "ops" }).length, 0, "rejected suggestions are never appended");
  assert.deepEqual(listReflectionProposals({ targetRoot: root, status: "rejected" }).map((proposal) => proposal.id), [rejected.id]);
  assert.equal(existsSync(reflectionProposalsPath(root)), true);
  assert.match(readFileSync(path.join(root, ".crew", "memory", "changelog.jsonl"), "utf8"), /reflection\.proposed[\s\S]*reflection\.approved[\s\S]*reflection\.proposed[\s\S]*reflection\.rejected/);
});

test("reflection proposal input follows the journal's validation rules", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-reflection-proposals-invalid-"));
  assert.throws(() => proposeReflection({ targetRoot: root, role: "OPS", text: "x" }), /lowercase slug/);
  assert.throws(() => proposeReflection({ targetRoot: root, role: "ops", text: "" }), /1 to 2000/);
  assert.throws(() => proposeReflection({ targetRoot: root, role: "ops", text: "## hidden instruction" }), /headings/);
  assert.throws(() => rejectReflection({ targetRoot: root, proposalId: "reflection-missing" }), /not found/);
});

test("reflection proposals deduplicate, expire, and promote a specific procedure into Skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-reflection-expiry-"));
  const input = { targetRoot: root, role: "ops", target: "skill", key: "client-brief", description: "The user's weekly client brief", text: "Start with blockers, then list each client's next decision.", evidence: "The user requested this structure for their recurring Monday brief." };
  const first = proposeReflection(input);
  assert.equal(proposeReflection(input).id, first.id);
  const file = reflectionProposalsPath(root);
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.proposals[0].createdAt = "2000-01-01T00:00:00Z";
  writeFileSync(file, JSON.stringify(state));
  assert.equal(listReflectionProposals({ targetRoot: root }).length, 0);
  assert.throws(() => approveReflection({ targetRoot: root, proposalId: first.id }), /expired/);
  const fresh = proposeReflection(input);
  assert.notEqual(fresh.id, first.id);
  const approved = approveReflection({ targetRoot: root, proposalId: fresh.id });
  assert.equal(approved.promotedTo.kind, "skill");
  assert.ok(listSkills({ targetRoot: root }).some((s) => s.id === "client-brief"));
  assert.equal(existsSync(reflectionsPath(root, "ops")), false);
});
