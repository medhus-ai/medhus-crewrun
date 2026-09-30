import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { agentDirectories, agentFile } from "./agent-paths.js";
import { mergeRoleContracts, summarizeRoleContract } from "./role-contract.js";
import { normalizeWeb } from "./web.js";

// Versioned JSON agent definitions inherit a shared defaults floor. Markdown
// instructions are loaded only through explicit memory pointers.
const ROLE_SLUG = /^[a-z][a-z0-9-]{0,79}$/;

function readJson(file) {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Agent definition must be a JSON object: ${file}`);
  roleScheduledEntries(parsed);
  return parsed;
}

export function readRoleDefaults(targetRoot) {
  return readJson(agentFile(targetRoot, "_defaults")) || {};
}

// Raw spec file for one role, or null when the role has no .json.
export function readRoleSpecFile(targetRoot, role) {
  if (!ROLE_SLUG.test(String(role || ""))) return null;
  return readJson(agentFile(targetRoot, role));
}

export function readAgentSpecForEditing(targetRoot, agent) {
  return readRoleSpecFile(targetRoot, agent) || {};
}

export function roleScheduledEntries(spec) {
  if (spec && Object.hasOwn(spec, "schedules")) throw new Error('v6 uses "scheduled", not "schedules"; migrate the agent definition.');
  if (spec?.scheduled != null && !Array.isArray(spec.scheduled)) throw new Error('"scheduled" must be an array');
  return spec?.scheduled || [];
}

// Heartbeat accepts "30m" shorthand or { interval, prompt, budget_usd_per_day }.
export function normalizeHeartbeat(value) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return { interval: String(value) };
  if (typeof value === "object") {
    return {
      interval: String(value.interval ?? "off"),
      ...(value.prompt ? { prompt: String(value.prompt) } : {}),
      ...(value.budget_usd_per_day != null ? { budget_usd_per_day: Number(value.budget_usd_per_day) } : {})
    };
  }
  return null;
}

// Merge the shared floor with one explicitly declared agent.
export function loadRoleSpec(targetRoot, role) {
  if (!ROLE_SLUG.test(String(role || ""))) return null;
  const defaults = readRoleDefaults(targetRoot);
  const specFile = readRoleSpecFile(targetRoot, role);
  const own = specFile;
  if (!own) return null;

  const defaultPointers = Array.isArray(defaults.memory_pointers) ? defaults.memory_pointers.map(String) : [];
  const ownPointers = Array.isArray(own?.memory_pointers) ? own.memory_pointers.map(String) : [];
  const reflectionSetting = own?.reflections ?? defaults.reflections;
  const reflections = (reflectionSetting === false || reflectionSetting == null)
    ? false
    : { limit: Math.max(1, Math.min(Number(own?.reflections?.limit ?? defaults.reflections?.limit ?? 10) || 10, 100)) };
  // The contract stays alongside the ordinary role spec so it is versioned and code-reviewed
  // with the role. Defaults may add a shared floor, but cannot weaken approval or budget limits.
  const contract = mergeRoleContracts(defaults.contract, own?.contract, { role });

  return {
    role,
    source: "spec",
    instructions: String(own?.instructions || ""),
    title: String(own?.title || defaults.title || ""),
    runner: String(own?.runner || defaults.runner || "").trim(),
    memory_pointers: [...defaultPointers, ...ownPointers.filter((p) => !defaultPointers.includes(p))],
    reflections,
    hooks: Array.isArray(own?.hooks) ? own.hooks.map(String) : Array.isArray(defaults.hooks) ? defaults.hooks.map(String) : [],
    heartbeat: normalizeHeartbeat(own?.heartbeat ?? defaults.heartbeat ?? null),
    // Web access is off unless the role (or the defaults floor) opts in — see web.js.
    web: normalizeWeb(own?.web ?? defaults.web ?? false),
    schedules: roleScheduledEntries(own).map((entry) => ({ ...entry, role })),
    contract,
    contractSummary: summarizeRoleContract(contract, { role }),
    hasSpecFile: true
  };
}

// Only JSON definitions declare agents; underscore files are shared settings.
export function listRoleNames(targetRoot) {
  const names = new Set();
  for (const dir of agentDirectories(targetRoot)) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.startsWith("_")) continue;
      if (name.endsWith(".json")) names.add(name.slice(0, -5));
    }
  }
  return [...names].filter((name) => ROLE_SLUG.test(name)).sort();
}

export function listRoleSpecs(targetRoot) {
  const specs = {};
  for (const role of listRoleNames(targetRoot)) {
    const spec = loadRoleSpec(targetRoot, role);
    if (spec) specs[role] = spec;
  }
  return specs;
}

// Agent-facing names share the contract implementation.
export { readRoleDefaults as readAgentDefaults, readRoleSpecFile as readAgentSpecFile, loadRoleSpec as loadAgentSpec, listRoleNames as listAgentNames, listRoleSpecs as listAgentSpecs, roleScheduledEntries as agentScheduledEntries };
