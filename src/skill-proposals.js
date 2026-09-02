import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { writeSkillIndexFile } from "./skills.js";
import path from "node:path";

import { crewDir } from "./crew-dirs.js";
import { appendAudit, readJson, writeJsonAtomic } from "./preference-memory.js";
import { skillScopes } from "./skills.js";

// Skills learned the governed way: a role notices a repeatable workflow and proposes a SKILL.md;
// a human approves it into a scope (user, workspace, repository) or rejects it. Nothing an agent
// writes becomes a skill on its own.
const SKILL_ID = /^[a-z][a-z0-9-]{0,79}$/;
const SCOPES = new Set(["user", "workspace", "repository"]);
const MAX_CONTENT = 20_000;

export function proposeSkill({ targetRoot, id, description, content, roles = [], workProfiles = [], scope = "repository", evidence = "", proposedBy = "agent" } = {}) {
  const root = path.resolve(targetRoot || process.cwd());
  const proposal = {
    id: `skill-${randomUUID()}`,
    ...normalizeSkillInput({ id, description, content, roles, workProfiles, scope }),
    evidence: String(evidence || "").trim().slice(0, 4000),
    proposedBy: String(proposedBy || "agent").trim().slice(0, 80),
    status: "pending",
    createdAt: new Date().toISOString()
  };
  const file = proposalFile(root);
  const state = readJson(file, { version: 1, proposals: [] });
  state.proposals.push(proposal);
  writeJsonAtomic(file, state);
  appendAudit(root, { event: "skill.proposed", proposalId: proposal.id, skillId: proposal.skillId, scope: proposal.scope, proposedBy: proposal.proposedBy });
  return proposal;
}

export function listSkillProposals({ targetRoot, status = "pending" } = {}) {
  const root = path.resolve(targetRoot || process.cwd());
  return readJson(proposalFile(root), { version: 1, proposals: [] }).proposals
    .filter((proposal) => !status || proposal.status === status);
}

export function approveSkill({ targetRoot, workspaceRoot, proposalId, approvedBy = "user", env = process.env } = {}) {
  return decideSkill({ targetRoot, workspaceRoot, proposalId, approvedBy, decision: "approved", env });
}

export function rejectSkill({ targetRoot, proposalId, approvedBy = "user" } = {}) {
  return decideSkill({ targetRoot, proposalId, approvedBy, decision: "rejected" });
}

function decideSkill({ targetRoot, workspaceRoot, proposalId, approvedBy, decision, env = process.env }) {
  const root = path.resolve(targetRoot || process.cwd());
  const file = proposalFile(root);
  const state = readJson(file, { version: 1, proposals: [] });
  const proposal = state.proposals.find((entry) => entry.id === proposalId);
  if (!proposal) throw new Error(`skill proposal ${proposalId} was not found`);
  if (proposal.status !== "pending") throw new Error(`skill proposal ${proposalId} is already ${proposal.status}`);
  const now = new Date().toISOString();
  proposal.status = decision;
  proposal.decidedAt = now;
  proposal.decidedBy = String(approvedBy || "user").slice(0, 80);

  let installedAt = "";
  if (decision === "approved") {
    const scope = skillScopes({ targetRoot: root, workspaceRoot, env }).find((entry) => entry.scope === proposal.scope);
    const dir = path.join(scope.dir, proposal.skillId);
    installedAt = `${dir}.md`;
    const existed = existsSync(installedAt);
    mkdirSync(path.dirname(installedAt), { recursive: true });
    writeFileSync(installedAt, renderSkill(proposal, { approvedBy: proposal.decidedBy, approvedAt: now }), "utf8");
    try { writeSkillIndexFile(root); } catch { /* index is regenerable */ }
    proposal.installedAt = installedAt;
    proposal.superseded = existed;
  }
  writeJsonAtomic(file, state);
  appendAudit(root, { event: `skill.${decision}`, proposalId, skillId: proposal.skillId, scope: proposal.scope, actor: proposal.decidedBy, ...(installedAt ? { file: installedAt } : {}) });
  return proposal;
}

// SKILL.md: frontmatter the skills index understands (name, description, roles, work_profiles)
// plus provenance, then the proposed body.
export function renderSkill(proposal, { approvedBy = "", approvedAt = "" } = {}) {
  const front = [
    `name: ${proposal.skillId}`,
    `description: ${proposal.description}`,
    proposal.roles.length ? `roles: [${proposal.roles.join(", ")}]` : "",
    proposal.workProfiles.length ? `work_profiles: [${proposal.workProfiles.join(", ")}]` : "",
    proposal.proposedBy ? `proposed_by: ${proposal.proposedBy}` : "",
    approvedBy ? `approved_by: ${approvedBy}` : "",
    approvedAt ? `approved_at: ${approvedAt}` : "",
    proposal.id ? `proposal: ${proposal.id}` : ""
  ].filter(Boolean);
  return `---\n${front.join("\n")}\n---\n\n${proposal.content.trim()}\n`;
}

function normalizeSkillInput({ id, description, content, roles, workProfiles, scope }) {
  const skillId = String(id || "").trim().toLowerCase();
  const normalizedDescription = String(description || "").trim().replace(/\s+/g, " ");
  const normalizedContent = String(content || "").replace(/\r\n/g, "\n").trim();
  const normalizedScope = String(scope || "repository").trim().toLowerCase();
  if (!SKILL_ID.test(skillId)) throw new Error("skill id must be a lowercase slug");
  if (!normalizedDescription || normalizedDescription.length > 200) throw new Error("skill description must contain 1 to 200 characters");
  if (!normalizedContent || normalizedContent.length > MAX_CONTENT) throw new Error(`skill content must contain 1 to ${MAX_CONTENT} characters`);
  if (normalizedContent.startsWith("---")) throw new Error("skill content is the body only; frontmatter is generated on approval");
  if (!SCOPES.has(normalizedScope)) throw new Error("skill scope must be user, workspace, or repository");
  const slugs = (values) => [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
  const normalizedRoles = slugs(roles);
  if (normalizedRoles.some((role) => !SKILL_ID.test(role))) throw new Error("skill roles must be lowercase slugs");
  return { skillId, description: normalizedDescription, content: normalizedContent, roles: normalizedRoles, workProfiles: slugs(workProfiles), scope: normalizedScope };
}

function proposalFile(root) {
  return path.join(root, crewDir(), "memory", "skill-proposals.json");
}
