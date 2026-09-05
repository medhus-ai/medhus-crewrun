import { randomUUID } from "node:crypto";
import path from "node:path";

import { crewDir } from "./crew-dirs.js";
import { appendAudit, readJson, writeJsonAtomic } from "./preference-memory.js";
import { normalizeReflection } from "./reflections.js";
import { proposePreference, approvePreference } from "./preference-memory.js";
import { proposeSkill, approveSkill } from "./skill-proposals.js";

// Optional, expiring proposals promote reviewed learning into context or Skills.
// Legacy journals remain on disk but receive no automatic writes or prompt injection.
export function reflectionProposalsPath(targetRoot) {
  const root = path.resolve(targetRoot || process.cwd());
  return path.join(root, crewDir(), "memory", "reflection-proposals.json");
}

export function proposeReflection({ targetRoot, role, text, ref = "", proposedBy = role, target, key, evidence, description = "" } = {}) {
  const root = path.resolve(targetRoot || process.cwd());
  const input = normalizeReflection({ role, text, ref, author: proposedBy });
  if (!["preference", "skill"].includes(target)) throw new Error("Choose a reflection destination: preference or skill.");
  if (!/^[a-z][a-z0-9-]{1,79}$/.test(key || "")) throw new Error("Give the proposed update a stable lowercase key.");
  if (!String(evidence || "").trim()) throw new Error("Explain the user or application evidence that makes this update useful.");
  if (target === "skill" && (!String(description).trim() || description.length > 200)) throw new Error("A skill update needs a description of at most 200 characters.");
  const proposal = {
    id: `reflection-${randomUUID()}`,
    role: input.role,
    text: input.text,
    ref: input.ref,
    target, key, evidence: String(evidence).trim().slice(0, 4000), description: String(description).trim(),
    proposedBy: input.author,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  const file = reflectionProposalsPath(root);
  const state = readJson(file, { version: 1, proposals: [] });
  const existing = state.proposals.find((p) => p.status === "pending" && Date.now() - Date.parse(p.createdAt) <= 30 * 86400_000 && p.role === role && p.target === target && p.key === key && p.text === input.text);
  if (existing) return existing;
  state.proposals.push(proposal);
  writeJsonAtomic(file, state);
  appendAudit(root, { event: "reflection.proposed", proposalId: proposal.id, role: proposal.role, ref: proposal.ref, proposedBy: proposal.proposedBy });
  return proposal;
}

export function listReflectionProposals({ targetRoot, status = "pending" } = {}) {
  const root = path.resolve(targetRoot || process.cwd());
  return readJson(reflectionProposalsPath(root), { version: 1, proposals: [] }).proposals
    .map((proposal) => proposal.status === "pending" && Date.now() - Date.parse(proposal.createdAt) > 30 * 86400_000 ? { ...proposal, status: "expired" } : proposal)
    .filter((proposal) => !status || proposal.status === status);
}

export function approveReflection({ targetRoot, proposalId, approvedBy = "user", target, key, description, env = process.env } = {}) {
  return decideReflection({ targetRoot, proposalId, approvedBy, decision: "approved", target, key, description, env });
}

export function rejectReflection({ targetRoot, proposalId, approvedBy = "user" } = {}) {
  return decideReflection({ targetRoot, proposalId, approvedBy, decision: "rejected" });
}

function decideReflection({ targetRoot, proposalId, approvedBy, decision, target, key, description, env }) {
  const root = path.resolve(targetRoot || process.cwd());
  const file = reflectionProposalsPath(root);
  const state = readJson(file, { version: 1, proposals: [] });
  const proposal = state.proposals.find((entry) => entry.id === proposalId);
  if (!proposal) throw new Error(`reflection proposal ${proposalId} was not found`);
  if (proposal.status !== "pending") throw new Error(`reflection proposal ${proposalId} is already ${proposal.status}`);
  if (Date.now() - Date.parse(proposal.createdAt) > 30 * 86400_000) throw new Error("This reflection expired. Submit a current proposal if it is still useful.");

  const now = new Date().toISOString();
  proposal.status = decision;
  proposal.decidedAt = now;
  proposal.decidedBy = String(approvedBy || "user").trim().slice(0, 80);
  if (decision === "approved") {
    const destination = target || proposal.target;
    const stableKey = key || proposal.key;
    const evidence = proposal.evidence || proposal.ref || "Operator reviewed a legacy reflection.";
    if (destination === "preference") {
      const entry = proposePreference({ targetRoot: root, key: stableKey, statement: proposal.text, evidence, proposedBy: proposal.proposedBy });
      approvePreference({ targetRoot: root, proposalId: entry.id, approvedBy, env });
      proposal.promotedTo = { kind: "preference", key: stableKey, id: entry.id };
    } else if (destination === "skill") {
      const entry = proposeSkill({ targetRoot: root, id: stableKey, description: description || proposal.description, content: proposal.text, evidence, roles: [proposal.role], proposedBy: proposal.proposedBy });
      approveSkill({ targetRoot: root, proposalId: entry.id, approvedBy, env });
      proposal.promotedTo = { kind: "skill", key: stableKey, id: entry.id };
    } else throw new Error("Choose preference or skill and a stable key before approving this legacy reflection.");
  }
  writeJsonAtomic(file, state);
  appendAudit(root, { event: `reflection.${decision}`, proposalId: proposal.id, role: proposal.role, actor: proposal.decidedBy });
  return proposal;
}
