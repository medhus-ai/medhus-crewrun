import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const WORKSPACE_VERSION = 1;
export const WORKSPACE_FILE = ".crew/workspace.json";
export const LIFECYCLE_EVENTS = Object.freeze(["approval.approved", "approval.rejected", "schedule.failed", "run.finished", "run.accept", "run.request_changes", "question.answered", "workspace.applied"]);

export function normalizeWorkspace(value) {
  if (!value || value.version !== WORKSPACE_VERSION) throw new Error("Unsupported workspace manifest version.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$/.test(value.id || "")) throw new Error("Workspace needs a stable id of 8–80 characters.");
  if (value.policy?.governed === false) throw new Error("Workspace governance cannot be disabled.");
  const timezone = value.timezone || "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new Error("Choose a valid workspace timezone."); }
  const paths = (items) => {
    if (!Array.isArray(items) || items.length > 100) throw new Error("Workspace paths must be a list of at most 100 entries.");
    return [...new Set(items.map(relativeWorkspacePath))];
  };
  const rules = value.rules || [];
  if (!Array.isArray(rules) || rules.length > 100 || rules.some((r) => !/^[a-z][a-z0-9-]{0,79}$/.test(r.id || "") || !/^[a-z][a-z0-9-]{0,79}$/.test(r.agent || "") || !LIFECYCLE_EVENTS.includes(r.event) || typeof r.enabled !== "boolean") || new Set(rules.map((r) => r.id)).size !== rules.length) throw new Error("Lifecycle rules need unique ids, a known event, an agent, and an explicit enabled flag.");
  const integrationRules = value.integrationRules || [];
  if (value.shellAgent != null && (!/^[a-z][a-z0-9-]{0,79}$/.test(value.shellAgent) || value.shellAgent === "crew-helper")) throw new Error("Choose one ordinary agent for shell access, or null to disable it.");
  if (value.shellRevision != null && (!Number.isSafeInteger(value.shellRevision) || value.shellRevision < 0)) throw new Error("Shell revision must be a nonnegative integer.");
  if (!Array.isArray(integrationRules) || integrationRules.length > 100 || integrationRules.some((r) => !/^[a-z][a-z0-9-]{0,127}$/.test(r.connectionId || "") || !/^[a-z][a-z0-9-]{0,79}$/.test(r.role || "") || !/^[a-z][A-Za-z0-9.-]{0,159}$/.test(r.eventType || "") || typeof r.enabled !== "boolean") || new Set(integrationRules.map((r) => `${r.connectionId}:${r.eventType}:${r.role}`)).size !== integrationRules.length) throw new Error("Integration rules need a connection, event, role, and explicit enabled flag without duplicates.");
  return {
    version: WORKSPACE_VERSION, id: value.id, name: String(value.name || "Workspace").slice(0, 160), timezone,
    shellAgent: value.shellAgent || null,
    shellRevision: value.shellRevision || 0,
    context: paths(value.context || []),
    rules: rules.map(({ id, event, agent, enabled }) => ({ id, event, agent, enabled })),
    integrationRules: integrationRules.map(({ connectionId, eventType, role, enabled }) => ({ connectionId, eventType, role, enabled })),
    policy: { drafts: paths(value.policy?.drafts || ["drafts", "outputs"]), review: "durable-changes", governed: true },
    limits: { depth: bounded(value.limits?.depth, 4, 1, 16), chainRuns: bounded(value.limits?.chainRuns, 20, 1, 100), attempts: bounded(value.limits?.attempts, 5, 1, 20) }
  };
}

export function readWorkspace(root) {
  if (!existsSync(path.join(path.resolve(root), WORKSPACE_FILE))) return null;
  const file = resolveWorkspacePath(root, WORKSPACE_FILE);
  return existsSync(file) ? normalizeWorkspace(JSON.parse(readFileSync(file, "utf8"))) : null;
}

export function workspaceIdentity(root) {
  const manifest = readWorkspace(root);
  return manifest ? `workspace:${manifest.id}` : path.resolve(root);
}

export function requireWorkspace(root) {
  const manifest = readWorkspace(root);
  if (!manifest) throw new Error("v6 requires .crew/workspace.json; run crewrun init or follow docs/v6-migration.md for an existing workspace.");
  for (const legacy of [".crew/roles", ".crew/schedules.json"]) {
    const file = path.join(path.resolve(root), legacy);
    if (!existsSync(file)) continue;
    const info = lstatSync(file);
    if (info.isDirectory() && !readdirSync(file).length) continue;
    throw new Error(`v6 no longer reads ${legacy}; migrate it before starting (docs/v6-migration.md).`);
  }
  return manifest;
}

export function relativeWorkspacePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || path.isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === "..") || value.split("/").includes(".git")) throw new Error("Use a relative workspace path without traversal or .git.");
  return value;
}

// Reject symlinks, including parent directories of not-yet-created files. The root itself may
// have a canonical alias; no path selected by an agent can escape that canonical root.
export function resolveWorkspacePath(root, relative) {
  relativeWorkspacePath(relative);
  const base = realpathSync(root);
  let file = base;
  for (const part of relative.split("/")) {
    file = path.join(file, part);
    try { if (lstatSync(file).isSymbolicLink()) throw new Error("Workspace symlinks are not accessible."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return file;
}

function bounded(value, fallback, min, max) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Workspace limit must be an integer from ${min} to ${max}.`);
  return value;
}
