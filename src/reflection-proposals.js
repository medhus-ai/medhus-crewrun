import { randomUUID } from "node:crypto";
import path from "node:path";

import { crewDir } from "./crew-dirs.js";
import { appendAudit, readJson, writeJsonAtomic } from "./preference-memory.js";
import { appendReflection, normalizeReflection } from "./reflections.js";

// A role may suggest a note for its future context, but only an operator can put that note in
// the durable journal. The journal remains a compact, human-editable markdown file; proposals
// live alongside the other durable-learning approval queues.
export function reflectionProposalsPath(targetRoot) {
  const root = path.resolve(targetRoot || process.cwd());
  return path.join(root, crewDir(), "memory", "reflection-proposals.json");
}

export function proposeReflection({ targetRoot, role, text, ref = "", proposedBy = role } = {}) {
  const root = path.resolve(targetRoot || process.cwd());
  const input = normalizeReflection({ role, text, ref, author: proposedBy });
  const proposal = {
    id: `reflection-${randomUUID()}`,
    role: input.role,
    text: input.text,
    ref: input.ref,
    proposedBy: input.author,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  const file = reflectionProposalsPath(root);
  const state = readJson(file, { version: 1, proposals: [] });
  state.proposals.push(proposal);
  writeJsonAtomic(file, state);
  appendAudit(root, { event: "reflection.proposed", proposalId: proposal.id, role: proposal.role, ref: proposal.ref, proposedBy: proposal.proposedBy });
  return proposal;
}

export function listReflectionProposals({ targetRoot, status = "pending" } = {}) {
  const root = path.resolve(targetRoot || process.cwd());
  return readJson(reflectionProposalsPath(root), { version: 1, proposals: [] }).proposals
    .filter((proposal) => !status || proposal.status === status);
}

export function approveReflection({ targetRoot, proposalId, approvedBy = "user" } = {}) {
  return decideReflection({ targetRoot, proposalId, approvedBy, decision: "approved" });
}

export function rejectReflection({ targetRoot, proposalId, approvedBy = "user" } = {}) {
  return decideReflection({ targetRoot, proposalId, approvedBy, decision: "rejected" });
}

function decideReflection({ targetRoot, proposalId, approvedBy, decision }) {
  const root = path.resolve(targetRoot || process.cwd());
  const file = reflectionProposalsPath(root);
  const state = readJson(file, { version: 1, proposals: [] });
  const proposal = state.proposals.find((entry) => entry.id === proposalId);
  if (!proposal) throw new Error(`reflection proposal ${proposalId} was not found`);
  if (proposal.status !== "pending") throw new Error(`reflection proposal ${proposalId} is already ${proposal.status}`);

  const now = new Date().toISOString();
  proposal.status = decision;
  proposal.decidedAt = now;
  proposal.decidedBy = String(approvedBy || "user").trim().slice(0, 80);
  if (decision === "approved") {
    const entry = appendReflection({
      targetRoot: root,
      role: proposal.role,
      text: proposal.text,
      ref: proposal.ref,
      author: proposal.proposedBy
    });
    proposal.appendedAt = entry.at;
  }
  writeJsonAtomic(file, state);
  appendAudit(root, { event: `reflection.${decision}`, proposalId: proposal.id, role: proposal.role, actor: proposal.decidedBy });
  return proposal;
}
