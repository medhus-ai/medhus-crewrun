import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { crewHome } from "./crew-dirs.js";

// A role contract is intentionally small: it describes the authority the host gives a role,
// while the role prompt remains ordinary reviewed prose.  `version` is the schema version and
// `revision` is the reviewed revision of this role's contract.
export const ROLE_CONTRACT_VERSION = 1;
export const ACTION_IMPACTS = Object.freeze(["read", "internal-write", "external-write", "destructive", "financial"]);
export const HIGH_IMPACT_ACTIONS = Object.freeze(["external-write", "destructive", "financial"]);

const ROLE_SLUG = /^[a-z][a-z0-9-]{0,79}$/;
const TOOL_NAME = /^[a-z][A-Za-z0-9_.:-]{0,119}$/;
const DATA_SCOPE = /^[a-z][a-z0-9_.:/*-]{0,159}$/;
const MAX_LIST = 100;
const IMPACT_ORDER = new Map(ACTION_IMPACTS.map((impact, index) => [impact, index]));

// Normalizes a JSON-safe, reviewable role contract. `null` deliberately remains null: old role
// specs stay legacy until a host or user adds a contract, rather than silently receiving a broad
// default authority.
export function normalizeRoleContract(value, { role = "" } = {}) {
  if (value == null) return null;
  if (!isObject(value)) throw new Error("role contract must be an object");
  const normalizedRole = normalizeRole(role);
  const version = integer(value.version ?? ROLE_CONTRACT_VERSION, "role contract version", { min: 1, max: ROLE_CONTRACT_VERSION });
  if (version !== ROLE_CONTRACT_VERSION) throw new Error(`unsupported role contract version: ${version}`);
  const revision = integer(value.revision ?? 1, "role contract revision", { min: 1, max: 1_000_000_000 });
  const mandate = text(value.mandate, "role contract mandate", { max: 1_000 });
  const authority = normalizeAuthority(value.authority);
  const approvals = normalizeApprovals(value.approvals);
  const budget = normalizeBudget(value.budget);
  return freeze({
    version,
    revision,
    ...(normalizedRole ? { role: normalizedRole } : {}),
    mandate,
    authority,
    approvals,
    budget
  });
}

export function validateRoleContract(value, options = {}) {
  try {
    return { ok: true, value: normalizeRoleContract(value, options), error: "" };
  } catch (error) {
    return { ok: false, value: null, error: error?.message || String(error) };
  }
}

// Defaults are a shared floor. Tool/data/handoff authority is additive, approval requirements
// are additive, and a tighter budget wins. A role cannot weaken a default approval or budget.
export function mergeRoleContracts(defaults, roleContract, { role = "" } = {}) {
  if (defaults == null && roleContract == null) return null;
  const base = defaults == null ? null : normalizeRoleContract(defaults, { role });
  const own = roleContract == null ? null : normalizeRoleContract(roleContract, { role });
  const floor = base || normalizeRoleContract({}, { role });
  const addition = own || normalizeRoleContract({}, { role });
  const merged = {
    version: ROLE_CONTRACT_VERSION,
    revision: own?.revision ?? base?.revision ?? 1,
    mandate: own?.mandate || base?.mandate || "",
    authority: {
      tools: mergeTools(floor.authority.tools, addition.authority.tools),
      data: {
        read: union(floor.authority.data.read, addition.authority.data.read),
        write: union(floor.authority.data.write, addition.authority.data.write)
      },
      handoffs: {
        send: union(floor.authority.handoffs.send, addition.authority.handoffs.send),
        receive: union(floor.authority.handoffs.receive, addition.authority.handoffs.receive)
      }
    },
    approvals: { required_for: union(floor.approvals.required_for, addition.approvals.required_for) },
    budget: mergeBudget(floor.budget, addition.budget)
  };
  return normalizeRoleContract(merged, { role });
}

// This is deliberately shaped for a dashboard: it has only reviewable authority facts and no
// prompt or token material. A missing contract is made explicit instead of being presented as a
// governed role.
export function summarizeRoleContract(contract, { role = "" } = {}) {
  const normalized = contract == null ? null : normalizeRoleContract(contract, { role: role || contract.role });
  if (!normalized) {
    return freeze({
      role: normalizeRole(role),
      status: "legacy",
      version: null,
      revision: null,
      fingerprint: null,
      mandate: "",
      tool_count: 0,
      authority: { tools: [], data: { read: [], write: [] }, handoffs: { send: [], receive: [] } },
      approvals: { required_for: [] },
      budget: emptyBudget(),
      issues: ["No governed role contract"]
    });
  }
  const issues = [];
  if (!normalized.mandate) issues.push("Add a mandate");
  if (!normalized.authority.tools.length) issues.push("No tools are authorized");
  return freeze({
    role: normalized.role || normalizeRole(role),
    status: issues.length ? "incomplete" : "governed",
    version: normalized.version,
    revision: normalized.revision,
    fingerprint: roleContractFingerprint(normalized),
    mandate: normalized.mandate,
    tool_count: normalized.authority.tools.length,
    authority: normalized.authority,
    approvals: normalized.approvals,
    budget: normalized.budget,
    issues
  });
}

// A concise in-turn reminder complements the enforcement boundary. It deliberately includes
// only reviewable authority metadata (never host credentials, raw data, or approval records).
export function roleContractInstructions(contract, { role = "" } = {}) {
  if (!contract) return "";
  const normalized = normalizeRoleContract(contract, { role: role || contract.role });
  const tools = normalized.authority.tools.map((tool) => `${tool.name} (${tool.impact})`);
  const data = [
    ...normalized.authority.data.read.map((scope) => `read:${scope}`),
    ...normalized.authority.data.write.map((scope) => `write:${scope}`)
  ];
  const handoffs = [
    normalized.authority.handoffs.send.length ? `send → ${normalized.authority.handoffs.send.join(", ")}` : "",
    normalized.authority.handoffs.receive.length ? `receive ← ${normalized.authority.handoffs.receive.join(", ")}` : ""
  ].filter(Boolean);
  return [
    "## Governed role contract",
    `Contract v${normalized.version}, revision ${normalized.revision}.`,
    normalized.mandate ? `Mandate: ${normalized.mandate}` : "Mandate: follow the reviewed role configuration.",
    `Authorized tools: ${tools.join(", ") || "none"}.`,
    data.length ? `Authorized data: ${data.join(", ")}.` : "Authorized data: none declared.",
    handoffs.length ? `Auditable handoffs: ${handoffs.join("; ")}.` : "Auditable handoffs: none declared.",
    "Do not attempt actions, data access, or cross-role communication outside this contract. High-impact actions require host approval."
  ].join("\n");
}

export function roleContractFingerprint(contract) {
  const normalized = normalizeRoleContract(contract, { role: contract?.role || "" });
  return normalized ? sha256(canonicalJson(normalized)) : null;
}

// Evaluates the authority for one host action. A connector supplies an action's actual impact
// and data references; lowering either below a contract declaration never lowers the decision.
// `requireContract` lets a v0.6 host deny legacy roles while preserving the older opt-in host API.
export function evaluateRoleAction(contract, {
  toolName,
  impact,
  data,
  approval,
  requireContract = false
} = {}) {
  const name = normalizeToolName(toolName, { required: false });
  if (!contract) {
    return freeze({
      allowed: !requireContract,
      decision: requireContract ? "denied" : "legacy",
      reason: requireContract ? "a governed role contract is required" : "role has no governed contract",
      tool_name: name,
      impact: normalizeImpact(impact, { fallback: "external-write" }),
      approval_required: false,
      contract_version: null,
      contract_revision: null,
      contract_fingerprint: null,
      authority: null,
      data: emptyData()
    });
  }

  const normalized = normalizeRoleContract(contract, { role: contract.role || "" });
  if (!name) return decision(normalized, { allowed: false, reason: "tool name is required", toolName: "", impact, data });
  const tool = normalized.authority.tools.find((entry) => entry.name === name);
  if (!tool) return decision(normalized, { allowed: false, reason: `${name} is outside this role's authority`, toolName: name, impact, data });

  let requestedData;
  try {
    requestedData = normalizeData(data);
  } catch (error) {
    return decision(normalized, { allowed: false, reason: error.message, toolName: name, impact, data: emptyData() });
  }
  const effectiveImpact = higherImpact(tool.impact, normalizeImpact(impact, { fallback: tool.impact }));
  const effectiveData = mergeData(tool.data, requestedData);
  // Per-tool data scopes are optional. When present they narrow the role-wide data authority;
  // when absent the role-wide authority remains the single source of truth.
  if (hasDataScopes(tool.data) && !dataWithin(tool.data, requestedData)) {
    return decision(normalized, {
      allowed: false,
      reason: `${name} requested data outside its declared authority`,
      toolName: name,
      impact: effectiveImpact,
      data: effectiveData,
      tool
    });
  }
  if (!dataWithin(normalized.authority.data, effectiveData)) {
    return decision(normalized, {
      allowed: false,
      reason: `${name} requested data outside this role's authority`,
      toolName: name,
      impact: effectiveImpact,
      data: effectiveData,
      tool
    });
  }

  const approvalRequired = tool.approval_required || normalized.approvals.required_for.includes(effectiveImpact);
  if (approvalRequired && !isApprovalGranted(approval, normalized)) {
    return decision(normalized, {
      allowed: false,
      requiresApproval: true,
      reason: `${name} requires host approval`,
      toolName: name,
      impact: effectiveImpact,
      data: effectiveData,
      tool
    });
  }
  return decision(normalized, {
    allowed: true,
    reason: "within role authority",
    toolName: name,
    impact: effectiveImpact,
    data: effectiveData,
    tool,
    approvalRequired
  });
}

export function evaluateRoleHandoff(contract, {
  direction = "send",
  role,
  requireContract = false
} = {}) {
  const peer = normalizeRole(role);
  const side = String(direction || "send").trim().toLowerCase();
  if (side !== "send" && side !== "receive") throw new Error("handoff direction must be send or receive");
  if (!contract) {
    return freeze({
      allowed: !requireContract,
      decision: requireContract ? "denied" : "legacy",
      reason: requireContract ? "a governed role contract is required" : "role has no governed contract",
      direction: side,
      role: peer,
      contract_version: null,
      contract_revision: null,
      contract_fingerprint: null
    });
  }
  const normalized = normalizeRoleContract(contract, { role: contract.role || "" });
  const allowed = Boolean(peer) && scopeAllows(normalized.authority.handoffs[side], peer);
  return freeze({
    allowed,
    decision: allowed ? "allowed" : "denied",
    reason: allowed ? "within handoff authority" : `${peer || "role"} is outside this role's ${side} handoff authority`,
    direction: side,
    role: peer,
    contract_version: normalized.version,
    contract_revision: normalized.revision,
    contract_fingerprint: roleContractFingerprint(normalized)
  });
}

// A host-facing convenience facade. The registry and console can pass a `getContract(role)`
// callback that reads their project state; nothing here decides where contracts live.
export function createRoleGovernance({
  contracts = {},
  getContract = null,
  requireContracts = false,
  requestApproval = null,
  audit = null,
  targetRoot = "",
  env = process.env
} = {}) {
  const actionAudit = audit || (targetRoot ? createActionAuditLog({ targetRoot, env }) : null);
  const contractFor = (role) => {
    const raw = getContract ? getContract(role) : contracts?.[role];
    return raw == null ? null : normalizeRoleContract(raw, { role });
  };
  const authorizeAction = ({ role, ...action } = {}) => evaluateRoleAction(contractFor(role), {
    ...action,
    requireContract: action.requireContract ?? requireContracts
  });
  // `role` is always the acting role, matching authorizeAction. `peerRole` is the other end
  // of the handoff: use it as the recipient for send or the sender for receive.
  const authorizeHandoff = ({ role, peerRole, direction = "send", requireContract, ...handoff } = {}) => evaluateRoleHandoff(contractFor(role), {
    direction,
    role: peerRole ?? handoff.peer ?? (direction === "send" ? handoff.recipientRole : handoff.senderRole),
    requireContract: requireContract ?? requireContracts
  });
  const recordAction = (record = {}) => {
    if (!actionAudit) return null;
    const contract = record.contract ?? contractFor(record.role);
    return actionAudit.append({ ...record, contract });
  };
  return {
    contractFor,
    summaryForRole: (role) => summarizeRoleContract(contractFor(role), { role }),
    authorizeAction,
    authorizeHandoff,
    requestApproval: typeof requestApproval === "function" ? requestApproval : null,
    recordAction,
    audit: actionAudit
  };
}

// JSONL is append-only and tamper-evident: every record includes the previous record's hash.
// Hosts with multiple writers should serialize append operations through their host DB/queue,
// just as they do schedule claiming. No raw tool input or output is retained; only digests are.
export function actionAuditPath(targetRoot, env = process.env) {
  const key = createHash("sha1").update(path.resolve(targetRoot || process.cwd())).digest("hex").slice(0, 16);
  return path.join(crewHome(env), "audit", `${key}.jsonl`);
}

export function createActionAuditLog({ targetRoot, file, env = process.env, now = () => new Date(), createId = () => randomUUID() } = {}) {
  const auditFile = file || (targetRoot ? actionAuditPath(targetRoot, env) : "");
  if (!auditFile) throw new Error("createActionAuditLog requires targetRoot or file");

  function append(record = {}) {
    const previous = readLastAuditRecord(auditFile);
    const contract = record.contract == null ? null : normalizeRoleContract(record.contract, { role: record.role || record.contract.role || "" });
    const timestamp = isoTimestamp(now());
    const entry = {
      version: 1,
      id: `action-${String(createId()).replace(/^action-/, "")}`,
      ...((record.operation_id ?? record.operationId) ? { operation_id: compactText(record.operation_id ?? record.operationId, 160) } : {}),
      at: timestamp,
      role: normalizeRole(record.role || contract?.role),
      actor: compactText(record.actor, 120),
      action: compactText(record.action || "tool", 80),
      tool_name: normalizeToolName(record.toolName ?? record.tool_name, { required: false }),
      outcome: normalizeOutcome(record.outcome),
      authorization: summarizeAuthorization(record.decision, contract),
      runner: compactText(record.runner ?? record.runner_id, 160),
      model: compactText(record.model, 160),
      data: safeData(record.data),
      budget: contract?.budget || normalizeBudget(record.budget),
      approval: summarizeApproval(record.approval),
      ...(record.input !== undefined ? { input_hash: digestValue(record.input) } : {}),
      ...(record.output !== undefined ? { output_hash: digestValue(record.output) } : {}),
      ...(record.error ? { error: compactText(record.error, 500) } : {}),
      previous_hash: previous?.hash || null
    };
    entry.hash = auditHash(entry);
    mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 });
    appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    return freeze(entry);
  }

  function list({ limit = 100 } = {}) {
    const records = readAuditRecords(auditFile);
    const count = Math.max(1, Math.min(1_000, Number(limit) || 100));
    return records.slice(-count).map((entry) => freeze(entry));
  }

  function verify() {
    let records;
    try {
      records = readAuditRecords(auditFile);
    } catch {
      return { valid: false, records: 0, error: "audit log contains an invalid record" };
    }
    let previousHash = null;
    const ids = new Set();
    for (let index = 0; index < records.length; index += 1) {
      const entry = records[index];
      if (!entry?.hash || entry.previous_hash !== previousHash || entry.hash !== auditHash(entry) || ids.has(entry.id)) {
        return { valid: false, records: records.length, error: `audit chain failed at record ${index + 1}` };
      }
      ids.add(entry.id);
      previousHash = entry.hash;
    }
    return { valid: true, records: records.length, head: previousHash };
  }

  return { file: auditFile, append, list, verify };
}

function normalizeAuthority(value) {
  if (value == null) return freeze({ tools: [], data: emptyData(), handoffs: emptyHandoffs() });
  if (!isObject(value)) throw new Error("role contract authority must be an object");
  return freeze({
    tools: normalizeTools(value.tools),
    data: normalizeData(value.data),
    handoffs: normalizeHandoffs(value.handoffs)
  });
}

function normalizeTools(value) {
  if (value == null) return freeze([]);
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new Error(`role contract tools must contain at most ${MAX_LIST} entries`);
  const byName = new Map();
  for (const raw of value) {
    const item = typeof raw === "string" ? { name: raw } : raw;
    if (!isObject(item)) throw new Error("role contract tools must contain tool names or objects");
    const name = normalizeToolName(item.name ?? item.id);
    const tool = {
      name,
      impact: normalizeImpact(item.impact, { fallback: "external-write" }),
      approval_required: Boolean(item.approval_required ?? item.approvalRequired ?? false),
      data: normalizeData(item.data)
    };
    const previous = byName.get(name);
    byName.set(name, previous ? stricterTool(previous, tool) : tool);
  }
  return freeze([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

function normalizeData(value) {
  if (value == null) return emptyData();
  if (!isObject(value)) throw new Error("role contract data authority must be an object");
  return freeze({ read: normalizeScopes(value.read, "read data"), write: normalizeScopes(value.write, "write data") });
}

function normalizeHandoffs(value) {
  if (value == null) return emptyHandoffs();
  if (!isObject(value)) throw new Error("role contract handoffs must be an object");
  return freeze({ send: normalizeRoleScopes(value.send, "send handoffs"), receive: normalizeRoleScopes(value.receive, "receive handoffs") });
}

function normalizeApprovals(value) {
  if (value != null && !isObject(value)) throw new Error("role contract approvals must be an object");
  const requested = value?.required_for ?? value?.requiredFor;
  const requiredFor = [...new Set([...HIGH_IMPACT_ACTIONS, ...normalizeImpactList(requested, "approval required_for")])]
    .sort((a, b) => IMPACT_ORDER.get(a) - IMPACT_ORDER.get(b));
  return freeze({ required_for: requiredFor });
}

function normalizeBudget(value) {
  if (value == null) return emptyBudget();
  if (!isObject(value)) throw new Error("role contract budget must be an object");
  return freeze({
    max_usd_per_run: nonnegative(value.max_usd_per_run ?? value.maxUsdPerRun, "max_usd_per_run"),
    max_usd_per_month: nonnegative(value.max_usd_per_month ?? value.maxUsdPerMonth, "max_usd_per_month"),
    max_tokens_per_run: nonnegativeInteger(value.max_tokens_per_run ?? value.maxTokensPerRun, "max_tokens_per_run"),
    max_runs_per_day: nonnegativeInteger(value.max_runs_per_day ?? value.maxRunsPerDay, "max_runs_per_day")
  });
}

function decision(contract, { allowed, requiresApproval = false, reason, toolName, impact, data, tool = null, approvalRequired = false }) {
  return freeze({
    allowed: Boolean(allowed),
    decision: allowed ? "allowed" : requiresApproval ? "approval-required" : "denied",
    reason: String(reason || ""),
    tool_name: String(toolName || ""),
    impact: normalizeImpact(impact, { fallback: tool?.impact || "external-write" }),
    approval_required: Boolean(approvalRequired || requiresApproval),
    contract_version: contract.version,
    contract_revision: contract.revision,
    contract_fingerprint: roleContractFingerprint(contract),
    authority: tool ? freeze({ tool_name: tool.name, impact: tool.impact, data: tool.data }) : null,
    data: safeData(data)
  });
}

function mergeTools(first, second) {
  const byName = new Map();
  for (const tool of [...first, ...second]) {
    byName.set(tool.name, byName.has(tool.name) ? stricterTool(byName.get(tool.name), tool) : tool);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function stricterTool(first, second) {
  return {
    name: first.name,
    impact: higherImpact(first.impact, second.impact),
    approval_required: Boolean(first.approval_required || second.approval_required),
    data: mergeData(first.data, second.data)
  };
}

function mergeBudget(first, second) {
  const tighter = (a, b) => a == null ? b : b == null ? a : Math.min(a, b);
  return {
    max_usd_per_run: tighter(first.max_usd_per_run, second.max_usd_per_run),
    max_usd_per_month: tighter(first.max_usd_per_month, second.max_usd_per_month),
    max_tokens_per_run: tighter(first.max_tokens_per_run, second.max_tokens_per_run),
    max_runs_per_day: tighter(first.max_runs_per_day, second.max_runs_per_day)
  };
}

function mergeData(first, second) {
  return freeze({ read: union(first?.read, second?.read), write: union(first?.write, second?.write) });
}

function dataWithin(allowed, actual) {
  return actual.read.every((scope) => scopeAllows(allowed.read, scope))
    && actual.write.every((scope) => scopeAllows(allowed.write, scope));
}

function hasDataScopes(data) {
  return Boolean(data?.read?.length || data?.write?.length);
}

function scopeAllows(scopes, value) {
  return (scopes || []).some((scope) => scope === "*" || scope === value
    || ((scope.endsWith(".*") || scope.endsWith(":*")) && value.startsWith(scope.slice(0, -1))));
}

function normalizeScopes(value, label) {
  if (value == null) return freeze([]);
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new Error(`${label} must contain at most ${MAX_LIST} scopes`);
  const scopes = [...new Set(value.map((entry) => String(entry || "").trim().toLowerCase()))].sort();
  if (scopes.some((scope) => !DATA_SCOPE.test(scope))) throw new Error(`${label} contains an invalid scope`);
  return freeze(scopes);
}

function normalizeRoleScopes(value, label) {
  if (value == null) return freeze([]);
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new Error(`${label} must contain at most ${MAX_LIST} roles`);
  const scopes = [...new Set(value.map((entry) => String(entry || "").trim().toLowerCase()))].sort();
  if (scopes.some((scope) => scope !== "*" && !ROLE_SLUG.test(scope))) throw new Error(`${label} contains an invalid role`);
  return freeze(scopes);
}

function normalizeImpactList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > ACTION_IMPACTS.length) throw new Error(`${label} must be an impact list`);
  return [...new Set(value.map((entry) => normalizeImpact(entry)))].sort((a, b) => IMPACT_ORDER.get(a) - IMPACT_ORDER.get(b));
}

function normalizeImpact(value, { fallback } = {}) {
  const requested = value == null || String(value).trim() === "" ? fallback : value;
  const impact = String(requested ?? "").trim().toLowerCase();
  if (!IMPACT_ORDER.has(impact)) throw new Error(`invalid action impact: ${impact || "(empty)"}`);
  return impact;
}

function higherImpact(first, second) {
  return IMPACT_ORDER.get(first) >= IMPACT_ORDER.get(second) ? first : second;
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (!role) return "";
  if (!ROLE_SLUG.test(role)) throw new Error("role contract role must be a lowercase slug");
  return role;
}

function normalizeToolName(value, { required = true } = {}) {
  const name = String(value || "").trim();
  if (!name && !required) return "";
  if (!TOOL_NAME.test(name)) throw new Error("role contract tool name must be a dotted identifier beginning with a lowercase letter");
  return name;
}

function text(value, label, { max }) {
  if (value == null) return "";
  const result = String(value).trim().replace(/\s+/g, " ");
  if (result.length > max) throw new Error(`${label} must contain at most ${max} characters`);
  return result;
}

function compactText(value, max) {
  return value == null ? "" : String(value).trim().replace(/\s+/g, " ").slice(0, max);
}

function integer(value, label, { min, max }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return number;
}

function nonnegative(value, label) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000_000) throw new Error(`${label} must be a non-negative number`);
  return number;
}

function nonnegativeInteger(value, label) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 1_000_000_000) throw new Error(`${label} must be a non-negative integer`);
  return number;
}

function emptyData() { return freeze({ read: [], write: [] }); }
function emptyHandoffs() { return freeze({ send: [], receive: [] }); }
function emptyBudget() { return freeze({ max_usd_per_run: null, max_usd_per_month: null, max_tokens_per_run: null, max_runs_per_day: null }); }

function union(first = [], second = []) {
  return [...new Set([...first, ...second])].sort((a, b) => String(a).localeCompare(String(b)));
}

function isApprovalGranted(value, contract = null) {
  if (!isObject(value)) return false;
  const status = String(value.status ?? "approved").trim().toLowerCase();
  if (!compactText(value.id, 160) || !compactText(value.approved_by ?? value.approvedBy, 120) || status !== "approved") return false;
  const authorization = safeApprovalAuthorization(value.authorization ?? value);
  // Hosts that use their own approval store may keep only the approval id and operator. The
  // bundled queue carries this additional fingerprint, so an approval issued for an older
  // reviewed contract cannot authorize a later revision.
  if (!authorization.contract_fingerprint || !contract) return true;
  return authorization.contract_fingerprint === roleContractFingerprint(contract)
    && authorization.contract_version === contract.version
    && authorization.contract_revision === contract.revision;
}

function safeApprovalAuthorization(value) {
  if (!isObject(value)) return { contract_fingerprint: "", contract_version: null, contract_revision: null };
  return {
    contract_fingerprint: compactText(value.contract_fingerprint, 128),
    contract_version: value.contract_version == null ? null : Number(value.contract_version),
    contract_revision: value.contract_revision == null ? null : Number(value.contract_revision)
  };
}

function summarizeApproval(value) {
  if (!isObject(value)) return null;
  const id = compactText(value.id, 160);
  const approvedBy = compactText(value.approved_by ?? value.approvedBy, 120);
  if (!id || !approvedBy) return null;
  return freeze({ id, approved_by: approvedBy, status: String(value.status ?? "approved").trim().toLowerCase() });
}

function summarizeAuthorization(value, contract) {
  const fallback = contract
    ? { decision: "unknown", contract_version: contract.version, contract_revision: contract.revision, contract_fingerprint: roleContractFingerprint(contract) }
    : { decision: "unknown", contract_version: null, contract_revision: null, contract_fingerprint: null };
  if (!isObject(value)) return freeze(fallback);
  return freeze({
    decision: compactText(value.decision, 40) || fallback.decision,
    reason: compactText(value.reason, 300),
    approval_required: Boolean(value.approval_required),
    contract_version: value.contract_version ?? fallback.contract_version,
    contract_revision: value.contract_revision ?? fallback.contract_revision,
    contract_fingerprint: compactText(value.contract_fingerprint, 128) || fallback.contract_fingerprint,
    authority: value.authority ? {
      tool_name: compactText(value.authority.tool_name, 120),
      impact: compactText(value.authority.impact, 40),
      data: safeData(value.authority.data)
    } : null
  });
}

function safeData(value) {
  try { return normalizeData(value); } catch { return emptyData(); }
}

function normalizeOutcome(value) {
  const outcome = String(value || "recorded").trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,39}$/.test(outcome) ? outcome : "recorded";
}

function digestValue(value) {
  try { return sha256(canonicalJson(value)); } catch { return sha256(String(value)); }
}

function readLastAuditRecord(file) {
  const records = readAuditRecords(file);
  return records.at(-1) || null;
}

function readAuditRecords(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function auditHash(entry) {
  const { hash, ...withoutHash } = entry || {};
  return sha256(canonicalJson(withoutHash));
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalJson(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function isoTimestamp(value) {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return new Date(Number.isFinite(time) ? time : Date.now()).toISOString();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
