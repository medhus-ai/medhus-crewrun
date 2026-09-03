import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { crewHome } from "./crew-dirs.js";
import { readJson, writeJsonAtomic } from "./preference-memory.js";

// A tiny, host-local approval queue for high-impact tool calls. It persists only safe
// metadata and an input digest: OAuth credentials and raw action payloads never land here.
// A horizontally scaled host should use its transactional database/queue instead.
const ROLE = /^[a-z][a-z0-9-]{0,79}$/;
const ACTION = /^[a-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;
const CONNECTION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUS = new Set(["pending", "approved", "rejected", "used", "expired"]);
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function actionApprovalPath(targetRoot, env = process.env) {
  const root = path.resolve(targetRoot || process.cwd());
  const key = createHash("sha256").update(root).digest("hex").slice(0, 24);
  return path.join(crewHome(env), "approvals", `${key}.json`);
}

export function requestActionApproval({
  targetRoot,
  role,
  action,
  connectionId = "",
  input = {},
  summary = "",
  requestedBy = "agent",
  authorization = null,
  expiresInMs = DEFAULT_TTL_MS,
  now = new Date(),
  env = process.env,
  createId = () => randomUUID()
} = {}) {
  const request = normalizeRequest({ role, action, connectionId, input, summary, requestedBy, authorization, expiresInMs, now, createId });
  const file = actionApprovalPath(targetRoot, env);
  const state = readState(file);
  state.approvals.push(request);
  writeJsonAtomic(file, state);
  return request;
}

export function listActionApprovals({ targetRoot, status = "", now = new Date(), env = process.env } = {}) {
  const file = actionApprovalPath(targetRoot, env);
  const state = readState(file);
  if (expirePending(state, now)) writeJsonAtomic(file, state);
  const wanted = String(status || "").trim().toLowerCase();
  return state.approvals
    .filter((entry) => !wanted || entry.status === wanted)
    .map(copyApproval)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function getActionApproval({ targetRoot, approvalId, now = new Date(), env = process.env } = {}) {
  const file = actionApprovalPath(targetRoot, env);
  const state = readState(file);
  if (expirePending(state, now)) writeJsonAtomic(file, state);
  const item = state.approvals.find((entry) => entry.id === String(approvalId || "").trim());
  return item ? copyApproval(item) : null;
}

export function approveAction({ targetRoot, approvalId, approvedBy = "operator", now = new Date(), env = process.env } = {}) {
  return decideActionApproval({ targetRoot, approvalId, actor: approvedBy, status: "approved", now, env });
}

export function rejectAction({ targetRoot, approvalId, rejectedBy = "operator", now = new Date(), env = process.env } = {}) {
  return decideActionApproval({ targetRoot, approvalId, actor: rejectedBy, status: "rejected", now, env });
}

// A minimal host policy for the built-in queue. Give its requestApproval callback to
// createRoleGovernance(); the first request creates a pending record, while a retry after an
// operator decision claims the exact approved record once. The provider never sees an approval
// for different input, role, action, or connection.
export function createActionApprovalPolicy({ targetRoot, env = process.env, requestedBy = "agent", expiresInMs = DEFAULT_TTL_MS, now = () => new Date() } = {}) {
  if (!targetRoot) throw new Error("createActionApprovalPolicy requires targetRoot");

  function requestApproval(request = {}) {
    const action = String(request.action || request.toolName || "").trim();
    const role = String(request.role || "").trim();
    const connectionId = String(request.connectionId || "").trim();
    const input = request.input || {};
    const authorization = request.decision || request.authorization;
    const match = findMatchingApproval({ targetRoot, role, action, connectionId, input, authorization, now: now(), env });
    if (match?.status === "approved") {
      return claimActionApproval({ targetRoot, approvalId: match.id, role, action, connectionId, input, authorization, now: now(), env });
    }
    if (match) return match;
    return requestActionApproval({
      targetRoot,
      role,
      action,
      connectionId,
      input,
      summary: request.summary || action,
      requestedBy: request.requestedBy || requestedBy,
      authorization,
      expiresInMs,
      now: now(),
      env
    });
  }

  return Object.freeze({
    requestApproval,
    list: (options = {}) => listActionApprovals({ targetRoot, env, ...options }),
    approve: ({ approvalId, approvedBy = "operator" } = {}) => approveAction({ targetRoot, approvalId, approvedBy, now: now(), env }),
    reject: ({ approvalId, rejectedBy = "operator" } = {}) => rejectAction({ targetRoot, approvalId, rejectedBy, now: now(), env })
  });
}

// Claims one matching approval immediately before a host invokes the provider. A claimed record
// is single-use, so a model cannot replay an approval id against a different payload or connection.
// It returns the exact shape `createRoleGovernance().authorizeAction()` accepts.
export function claimActionApproval({ targetRoot, approvalId, role, action, connectionId = "", input = {}, authorization = null, now = new Date(), env = process.env } = {}) {
  const file = actionApprovalPath(targetRoot, env);
  const state = readState(file);
  const expired = expirePending(state, now);
  const entry = state.approvals.find((item) => item.id === String(approvalId || "").trim());
  if (!entry) throw new Error(`action approval ${approvalId || ""} was not found`);
  if (entry.status !== "approved") {
    if (expired) writeJsonAtomic(file, state);
    throw new Error(`action approval ${entry.id} is ${entry.status}`);
  }
  assertMatches(entry, { role, action, connectionId, input, authorization });
  entry.status = "used";
  entry.usedAt = iso(now);
  writeJsonAtomic(file, state);
  return Object.freeze({
    id: entry.id,
    approved_by: entry.decidedBy,
    status: "approved",
    decided_at: entry.decidedAt,
    authorization: safeAuthorization(entry.authorization)
  });
}

function decideActionApproval({ targetRoot, approvalId, actor, status, now, env }) {
  const file = actionApprovalPath(targetRoot, env);
  const state = readState(file);
  const expired = expirePending(state, now);
  const entry = state.approvals.find((item) => item.id === String(approvalId || "").trim());
  if (!entry) throw new Error(`action approval ${approvalId || ""} was not found`);
  if (entry.status !== "pending") {
    if (expired) writeJsonAtomic(file, state);
    throw new Error(`action approval ${entry.id} is already ${entry.status}`);
  }
  entry.status = status;
  entry.decidedAt = iso(now);
  entry.decidedBy = compact(actor, 120) || "operator";
  writeJsonAtomic(file, state);
  return copyApproval(entry);
}

function normalizeRequest({ role, action, connectionId, input, summary, requestedBy, authorization, expiresInMs, now, createId }) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const normalizedAction = String(action || "").trim();
  const normalizedConnection = String(connectionId || "").trim();
  if (!ROLE.test(normalizedRole)) throw new Error("approval role must be a lowercase role slug");
  if (!ACTION.test(normalizedAction)) throw new Error("approval action must be a connector action id");
  if (normalizedConnection && !CONNECTION.test(normalizedConnection)) throw new Error("approval connectionId is invalid");
  const ttl = Number(expiresInMs);
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > MAX_TTL_MS) throw new Error("approval expiry must be between 1 second and 7 days");
  const createdAt = iso(now);
  const createdMs = Date.parse(createdAt);
  return Object.freeze({
    id: `approval-${String(createId()).replace(/^approval-/, "")}`,
    status: "pending",
    role: normalizedRole,
    action: normalizedAction,
    connectionId: normalizedConnection || null,
    inputHash: digest(input),
    summary: compact(summary, 1_000),
    requestedBy: compact(requestedBy, 120) || "agent",
    authorization: safeAuthorization(authorization),
    createdAt,
    expiresAt: new Date(createdMs + ttl).toISOString(),
    decidedAt: null,
    decidedBy: null,
    usedAt: null
  });
}

function assertMatches(entry, { role, action, connectionId, input, authorization }) {
  const expectedRole = String(role || "").trim().toLowerCase();
  const expectedAction = String(action || "").trim();
  const expectedConnection = String(connectionId || "").trim() || null;
  if (entry.role !== expectedRole
    || entry.action !== expectedAction
    || entry.connectionId !== expectedConnection
    || entry.inputHash !== digest(input)
    || !matchingAuthorization(entry.authorization, authorization)) {
    throw new Error(`action approval ${entry.id} does not match this request`);
  }
}

function findMatchingApproval({ targetRoot, role, action, connectionId, input, authorization, now, env }) {
  const roleId = String(role || "").trim().toLowerCase();
  const actionId = String(action || "").trim();
  const connection = String(connectionId || "").trim() || null;
  const inputHash = digest(input);
  return listActionApprovals({ targetRoot, now, env }).find((entry) => entry.role === roleId
    && entry.action === actionId
    && entry.connectionId === connection
    && entry.inputHash === inputHash
    && matchingAuthorization(entry.authorization, authorization)
    && ["pending", "approved", "rejected"].includes(entry.status)) || null;
}

function matchingAuthorization(stored, requested) {
  const actual = safeAuthorization(stored);
  const expected = safeAuthorization(requested);
  if (!actual?.contract_fingerprint && !expected?.contract_fingerprint) return true;
  return actual?.contract_fingerprint === expected?.contract_fingerprint
    && actual.contract_version === expected.contract_version
    && actual.contract_revision === expected.contract_revision;
}

function expirePending(state, now) {
  const at = Date.parse(iso(now));
  let changed = false;
  for (const entry of state.approvals) {
    if (entry.status === "pending" || entry.status === "approved") {
      const expires = Date.parse(entry.expiresAt || "");
      if (Number.isFinite(expires) && expires <= at) {
        entry.status = "expired";
        changed = true;
      }
    }
  }
  return changed;
}

function readState(file) {
  const parsed = readJson(file, { version: 1, approvals: [] });
  const approvals = Array.isArray(parsed.approvals) ? parsed.approvals.filter(validStoredApproval) : [];
  return { version: 1, approvals };
}

function validStoredApproval(value) {
  return value && typeof value === "object" && STATUS.has(value.status) && typeof value.id === "string";
}

function safeAuthorization(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    decision: compact(value.decision, 40),
    contract_version: value.contract_version == null ? null : Number(value.contract_version),
    contract_revision: value.contract_revision == null ? null : Number(value.contract_revision),
    contract_fingerprint: compact(value.contract_fingerprint, 128)
  };
}

function copyApproval(value) { return structuredClone(value); }
function compact(value, length) { return value == null ? "" : String(value).trim().replace(/\s+/g, " ").slice(0, length); }
function iso(value) { const at = value instanceof Date ? value.getTime() : Date.parse(String(value || "")); return new Date(Number.isFinite(at) ? at : Date.now()).toISOString(); }
function digest(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function canonical(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
