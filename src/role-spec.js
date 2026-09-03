import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { crewDir } from "./crew-dirs.js";
import { parseFrontmatter, parseInlineList } from "./frontmatter.js";
import { normalizeWeb } from "./web.js";

// The role spec: <crew>/roles/<role>.json holds everything about how one role runs —
// runner, title, memory_pointers, reflections knob, hooks, heartbeat, web access, and that
// role's schedules. <crew>/roles/_defaults.json supplies values every role inherits (its
// memory_pointers PREPEND — the shared floor loads first; scalar values are overridden).
// A role's .md is pure prompt prose, read only when a spec's memory_pointers lists it.
// Roles without a .json fall back to legacy .md frontmatter so existing projects keep working.

const ROLE_SLUG = /^[a-z][a-z0-9-]{0,79}$/;

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rolesDir(targetRoot) {
  return path.join(path.resolve(targetRoot), crewDir(), "roles");
}

export function readRoleDefaults(targetRoot) {
  return readJson(path.join(rolesDir(targetRoot), "_defaults.json")) || {};
}

// Raw spec file for one role, or null when the role has no .json.
export function readRoleSpecFile(targetRoot, role) {
  if (!ROLE_SLUG.test(String(role || ""))) return null;
  return readJson(path.join(rolesDir(targetRoot), `${role}.json`));
}

function legacySpecFromFrontmatter(targetRoot, role) {
  try {
    const front = parseFrontmatter(readFileSync(path.join(rolesDir(targetRoot), `${role}.md`), "utf8"));
    const spec = {};
    if (front.runner) spec.runner = front.runner;
    if (front.title) spec.title = front.title;
    if (front.heartbeat !== undefined) {
      spec.heartbeat = {
        interval: front.heartbeat,
        ...(front.heartbeat_prompt ? { prompt: front.heartbeat_prompt } : {}),
        ...(front.heartbeat_budget_usd_per_day ? { budget_usd_per_day: Number(front.heartbeat_budget_usd_per_day) } : {})
      };
    }
    const hooks = parseInlineList(front.hooks);
    if (hooks.length) spec.hooks = hooks;
    return Object.keys(spec).length ? spec : null;
  } catch {
    return null;
  }
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

// The merged, normalized spec: defaults + (role .json, else legacy .md frontmatter).
// `source` says which layer defined the role ("spec" | "frontmatter" | "defaults-only").
export function loadRoleSpec(targetRoot, role) {
  if (!ROLE_SLUG.test(String(role || ""))) return null;
  const defaults = readRoleDefaults(targetRoot);
  const specFile = readRoleSpecFile(targetRoot, role);
  const legacy = specFile ? null : legacySpecFromFrontmatter(targetRoot, role);
  const own = specFile || legacy;
  const hasMd = existsSync(path.join(rolesDir(targetRoot), `${role}.md`));
  if (!own && !hasMd && !Object.keys(defaults).length) return null;

  const defaultPointers = Array.isArray(defaults.memory_pointers) ? defaults.memory_pointers.map(String) : [];
  const ownPointers = Array.isArray(own?.memory_pointers) ? own.memory_pointers.map(String) : [];
  const reflections = own?.reflections === false
    ? false
    : { limit: Math.max(1, Math.min(Number(own?.reflections?.limit ?? defaults.reflections?.limit ?? 10) || 10, 100)) };

  return {
    role,
    source: specFile ? "spec" : legacy ? "frontmatter" : "defaults-only",
    title: String(own?.title || defaults.title || ""),
    runner: String(own?.runner || defaults.runner || "").trim(),
    memory_pointers: [...defaultPointers, ...ownPointers.filter((p) => !defaultPointers.includes(p))],
    reflections,
    hooks: Array.isArray(own?.hooks) ? own.hooks.map(String) : Array.isArray(defaults.hooks) ? defaults.hooks.map(String) : [],
    heartbeat: normalizeHeartbeat(own?.heartbeat ?? defaults.heartbeat ?? null),
    // Web access is off unless the role (or the defaults floor) opts in — see web.js.
    web: normalizeWeb(own?.web ?? defaults.web ?? false),
    schedules: (Array.isArray(own?.schedules) ? own.schedules : []).map((entry) => ({ ...entry, role })),
    hasSpecFile: Boolean(specFile),
    hasMd
  };
}

// Every role the project declares: any roles/<role>.json or roles/<role>.md (underscore files skipped).
export function listRoleNames(targetRoot) {
  const dir = rolesDir(targetRoot);
  if (!existsSync(dir)) return [];
  const names = new Set();
  for (const name of readdirSync(dir)) {
    if (name.startsWith("_")) continue;
    if (name.endsWith(".json")) names.add(name.slice(0, -5));
    else if (name.endsWith(".md")) names.add(name.slice(0, -3));
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
