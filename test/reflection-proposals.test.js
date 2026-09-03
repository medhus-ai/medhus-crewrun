import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
import { readReflections, reflectionsPath } from "../src/reflections.js";

test("role reflections are proposed first and reach durable memory only after approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-reflection-proposals-"));
  const fromTool = await crewToolDefinitions.call({
    role: "ops",
    toolName: "memory.reflect",
    input: { text: "Lead weekly updates with the active blocker.", ref: "weekly-brief" },
    context: { targetRoot: root }
  });

  assert.equal(fromTool.status, "pending");
  assert.equal(fromTool.role, "ops");
  assert.equal(existsSync(reflectionsPath(root, "ops")), false, "the role tool cannot silently append memory");
  assert.deepEqual(listReflectionProposals({ targetRoot: root }).map((proposal) => proposal.id), [fromTool.id]);

  const approved = approveReflection({ targetRoot: root, proposalId: fromTool.id, approvedBy: "operator" });
  assert.equal(approved.status, "approved");
  assert.equal(approved.decidedBy, "operator");
  assert.ok(approved.appendedAt);
  assert.deepEqual(readReflections({ targetRoot: root, role: "ops" }).map((entry) => [entry.ref, entry.author, entry.text]), [
    ["weekly-brief", "ops", "Lead weekly updates with the active blocker."]
  ]);
  assert.throws(() => approveReflection({ targetRoot: root, proposalId: fromTool.id }), /already approved/);

  const rejected = proposeReflection({ targetRoot: root, role: "ops", text: "Do not turn routine notes into permanent rules." });
  rejectReflection({ targetRoot: root, proposalId: rejected.id, approvedBy: "operator" });
  assert.equal(readReflections({ targetRoot: root, role: "ops" }).length, 1, "rejected suggestions are never appended");
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
