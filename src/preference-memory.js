import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { crewEnv, crewHome, crewDir } from "./crew-dirs.js";

const SCOPES = new Set(["user", "workspace", "repository"]);
const KEY_PATTERN = /^[a-z][a-z0-9._-]{1,79}$/;

// Trusted operator/host API for an explicit user instruction. Do not expose this
// approval shortcut as an agent tool; inferred preferences use prefs.propose.
export function saveUserPreference(input = {}) {
  if (!String(input.evidence || "").trim()) throw new Error("Include the explicit user instruction as evidence.");
  const proposal = proposePreference({ ...input, proposedBy: "user" });
  return approvePreference({ ...input, proposalId: proposal.id, approvedBy: "user" });
}

export function proposePreference({ targetRoot, workspaceRoot, key, statement, scope = "repository", evidence = "", proposedBy = "agent", env = process.env } = {}) {
  const root = path.resolve(targetRoot || process.cwd());
  const normalized = normalizePreferenceInput({ key, statement, scope });
  const proposal = {
    id: `pref-${randomUUID()}`,
    ...normalized,
    evidence: String(evidence || "").trim().slice(0, 4000),
    proposedBy: String(proposedBy || "agent").trim().slice(0, 80),
    status: "pending",
    createdAt: new Date().toISOString()
  };
  const file = proposalFile(root);
  const state = readJson(file, { version: 1, proposals: [] });
  state.proposals.push(proposal);
  writeJsonAtomic(file, state);
  appendAudit(root, { event: "preference.proposed", proposal });
  return proposal;
}

export function listPreferenceProposals({ targetRoot, status = "pending" } = {}) {
  const root = path.resolve(targetRoot || process.cwd());
  const state = readJson(proposalFile(root), { version: 1, proposals: [] });
  return state.proposals.filter((proposal) => !status || proposal.status === status);
}

export function approvePreference({ targetRoot, workspaceRoot, proposalId, approvedBy = "user", env = process.env } = {}) {
  return decidePreference({ targetRoot, workspaceRoot, proposalId, approvedBy, decision: "approved", env });
}

export function rejectPreference({ targetRoot, proposalId, approvedBy = "user" } = {}) {
  return decidePreference({ targetRoot, proposalId, approvedBy, decision: "rejected" });
}

export function listPreferences({ targetRoot, workspaceRoot, env = process.env } = {}) {
  const locations = preferenceLocations({ targetRoot, workspaceRoot, env });
  const effective = new Map();
  const byScope = {};
  for (const location of locations) {
    const entries = readJson(location.file, { version: 1, preferences: [] }).preferences;
    byScope[location.scope] = entries;
    for (const entry of entries) effective.set(entry.key, entry);
  }
  return { effective: [...effective.values()].sort((a, b) => a.key.localeCompare(b.key)), byScope };
}

function decidePreference({ targetRoot, workspaceRoot, proposalId, approvedBy, decision, env = process.env }) {
  const root = path.resolve(targetRoot || process.cwd());
  const file = proposalFile(root);
  const state = readJson(file, { version: 1, proposals: [] });
  const proposal = state.proposals.find((entry) => entry.id === proposalId);
  if (!proposal) throw new Error(`preference proposal ${proposalId} was not found`);
  if (proposal.status !== "pending") throw new Error(`preference proposal ${proposalId} is already ${proposal.status}`);
  const now = new Date().toISOString();
  proposal.status = decision;
  proposal.decidedAt = now;
  proposal.decidedBy = String(approvedBy || "user").slice(0, 80);
  writeJsonAtomic(file, state);

  if (decision === "approved") {
    const location = preferenceLocations({ targetRoot: root, workspaceRoot, env }).find((entry) => entry.scope === proposal.scope);
    const memory = readJson(location.file, { version: 1, preferences: [] });
    const previous = memory.preferences.find((entry) => entry.key === proposal.key);
    const preference = {
      id: proposal.id,
      key: proposal.key,
      statement: proposal.statement,
      scope: proposal.scope,
      evidence: proposal.evidence,
      proposedBy: proposal.proposedBy,
      approvedBy: proposal.decidedBy,
      approvedAt: now,
      ...(previous ? { supersedes: previous.id } : {})
    };
    memory.preferences = memory.preferences.filter((entry) => entry.key !== proposal.key);
    memory.preferences.push(preference);
    writeJsonAtomic(location.file, memory);
    appendScopeAudit(location.file, { event: "preference.approved", preference });
  }
  appendAudit(root, { event: `preference.${decision}`, proposalId, key: proposal.key, scope: proposal.scope, actor: proposal.decidedBy });
  return proposal;
}

function normalizePreferenceInput({ key, statement, scope }) {
  const normalizedKey = String(key || "").trim().toLowerCase();
  const normalizedStatement = String(statement || "").trim();
  const normalizedScope = String(scope || "repository").trim().toLowerCase();
  if (!KEY_PATTERN.test(normalizedKey)) throw new Error("preference key must be a lowercase dotted or dashed identifier");
  if (!normalizedStatement || normalizedStatement.length > 2000) throw new Error("preference statement must contain 1 to 2000 characters");
  if (!SCOPES.has(normalizedScope)) throw new Error("preference scope must be user, workspace, or repository");
  return { key: normalizedKey, statement: normalizedStatement, scope: normalizedScope };
}

function preferenceLocations({ targetRoot, workspaceRoot, env }) {
  const root = path.resolve(targetRoot || process.cwd());
  const workspace = path.resolve(workspaceRoot || crewEnv("WORKSPACE", env) || path.dirname(root));
  const values = [
    { scope: "user", file: path.join(crewHome(env), "memory", "preferences.json") },
    { scope: "workspace", file: path.join(workspace, crewDir(), "memory", "preferences.json") },
    { scope: "repository", file: path.join(root, crewDir(), "memory", "preferences.json") }
  ];
  return values;
}

function proposalFile(root) {
  return path.join(root, crewDir(), "memory", "preference-proposals.json");
}

export function appendAudit(root, event) {
  const file = path.join(root, crewDir(), "memory", "changelog.jsonl");
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

function appendScopeAudit(preferencesFile, event) {
  const file = path.join(path.dirname(preferencesFile), "changelog.jsonl");
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
}

export function readJson(file, fallback) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

export function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}
