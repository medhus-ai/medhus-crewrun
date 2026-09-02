import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { crewDir, crewHome } from "./crew-dirs.js";
import { parseFrontmatter, parseInlineList } from "./frontmatter.js";
import { readRoleRegistry } from "./runner.js";

// Heartbeats and event hooks for roles, declared in the same role frontmatter the runner
// already reads. Flat keys, absent = off, so every existing role file keeps its behavior:
//
//   heartbeat: 30m                      # off | 1s … 1y — a duration enables the pulse
//   heartbeat_prompt: optional override
//   heartbeat_budget_usd_per_day: 2     # optional daily cap, enforced via the host's spentToday
//   hooks: [task.assigned, run.failed]  # event names are the host's; the kernel just routes
//
// A heartbeat is a periodic autonomous turn; missed windows fire once, a pulse never overlaps
// itself, and run state lives under the crew home so the repository never churns. A hook firing
// is delivered through the host's enqueue (normally the handoff queue), with a debounced
// externalId so retries and duplicate events coalesce.

const UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2629800, y: 31557600 };
export const MIN_INTERVAL_S = 1;
export const MAX_INTERVAL_S = UNITS.y;
const DEBOUNCE_BUCKET_MS = 5 * 60 * 1000;

// "90s" | "30m" | "1h" | "2d" | "1w" | "1mo" | "1y" | bare seconds → seconds; null = off; NaN = invalid.
export function parseInterval(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || text === "off" || text === "false" || text === "0") return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w|mo|y)?$/);
  if (!match) return NaN;
  const seconds = Number(match[1]) * UNITS[match[2] || "s"];
  return Number.isFinite(seconds) ? Math.round(seconds) : NaN;
}

// A role's settings come from the registry entry (<crew>/roles/runners.json) merged over its
// optional .md frontmatter — registry wins where both speak.
export function loadRoleSettings(targetRoot) {
  const dir = path.join(path.resolve(targetRoot), crewDir(), "roles");
  const registry = readRoleRegistry(targetRoot);
  const settings = {};
  const fronts = {};
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md") || name.startsWith("_")) continue;
      fronts[name.slice(0, -3)] = parseFrontmatter(readFileSync(path.join(dir, name), "utf8"));
    }
  }
  for (const role of new Set([...Object.keys(registry), ...Object.keys(fronts)])) {
    const entry = registry[role] && typeof registry[role] === "object" ? registry[role] : {};
    const front = { ...(fronts[role] || {}) };
    for (const key of ["runner", "heartbeat", "heartbeat_prompt", "heartbeat_budget_usd_per_day"]) {
      if (entry[key] !== undefined) front[key] = String(entry[key]);
    }
    const hooks = Array.isArray(entry.hooks) ? entry.hooks.map(String) : parseInlineList(front.hooks);
    const intervalSeconds = parseInterval(front.heartbeat);
    settings[role] = {
      role,
      heartbeat: Number.isFinite(intervalSeconds) && intervalSeconds !== null ? {
        intervalSeconds,
        prompt: front.heartbeat_prompt || "",
        budgetUsdPerDay: front.heartbeat_budget_usd_per_day ? Number(front.heartbeat_budget_usd_per_day) : null
      } : null,
      hooks,
      front
    };
  }
  return settings;
}

export function validateRoleSettings(settings, { knownEvents = [] } = {}) {
  const problems = [];
  const warnings = [];
  for (const entry of Object.values(settings)) {
    const raw = entry.front.heartbeat;
    if (raw !== undefined) {
      const seconds = parseInterval(raw);
      if (Number.isNaN(seconds)) problems.push(`${entry.role}: heartbeat "${raw}" is not a duration (1s…1y as s|m|h|d|w|mo|y, or "off")`);
      else if (seconds !== null && (seconds < MIN_INTERVAL_S || seconds > MAX_INTERVAL_S)) problems.push(`${entry.role}: heartbeat must be between 1s and 1y`);
      else if (seconds !== null && seconds < 60) warnings.push(`${entry.role}: a sub-minute heartbeat (${seconds}s) spends real money fast — set heartbeat_budget_usd_per_day`);
    }
    if (knownEvents.length) {
      for (const event of entry.hooks) {
        if (!knownEvents.includes(event)) problems.push(`${entry.role}: unknown hook event "${event}" (known: ${knownEvents.join(", ")})`);
      }
    }
  }
  return { problems, warnings };
}

export function heartbeatStatePath(targetRoot, env = process.env) {
  const key = createHash("sha1").update(path.resolve(targetRoot)).digest("hex").slice(0, 16);
  return path.join(crewHome(env), "heartbeats", `${key}.json`);
}

export function readHeartbeatState(targetRoot, env = process.env) {
  try { return JSON.parse(readFileSync(heartbeatStatePath(targetRoot, env), "utf8")); } catch { return { roles: {} }; }
}

function writeHeartbeatState(targetRoot, state, env = process.env) {
  const file = heartbeatStatePath(targetRoot, env);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state));
}

// Due when now >= lastRun + interval; a never-run heartbeat is due immediately.
export function heartbeatDue({ intervalSeconds, lastRunAt, now = new Date() }) {
  const last = Date.parse(lastRunAt || "");
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= intervalSeconds * 1000;
}

// Identical events for a role coalesce within a bucket, so retries and bursts enqueue once.
export function hookExternalId(event, role, key, now = new Date()) {
  const bucket = Math.floor(now.getTime() / DEBOUNCE_BUCKET_MS);
  return `hook:${event}:${role}:${key || "-"}:${bucket}`;
}

// Host contract: runTurn(role, prompt) performs the recorded turn; enqueue({role, body,
// externalId}) delivers a hook (returns { created }); routeEvent(event, payload, settings)
// picks target roles; renderEvent(event, payload) writes the hook prompt; spentToday(role)
// backs the optional heartbeat budget cap.
export function createPulse({
  targetRoot,
  runTurn,
  enqueue,
  routeEvent,
  renderEvent = (event, payload) => `[event: ${event}]\n\n${JSON.stringify(payload)}`,
  spentToday = () => 0,
  defaultHeartbeatPrompt = "Heartbeat pulse. Check your responsibilities with your tools and act only if something needs you; if nothing does, reply with one line and stop.",
  settingsTtlMs = 60_000,
  log = () => {},
  env = process.env,
  now = () => new Date()
} = {}) {
  if (typeof runTurn !== "function") throw new Error("createPulse requires runTurn(role, prompt)");
  if (typeof enqueue !== "function") throw new Error("createPulse requires enqueue({ role, body, externalId })");
  if (typeof routeEvent !== "function") throw new Error("createPulse requires routeEvent(event, payload, settings)");
  let settings = loadRoleSettings(targetRoot);
  let loadedAt = Date.now();
  const running = new Set();

  function freshSettings() {
    if (Date.now() - loadedAt > settingsTtlMs) {
      settings = loadRoleSettings(targetRoot);
      loadedAt = Date.now();
    }
    return settings;
  }

  function emit(event, payload = {}) {
    for (const role of routeEvent(event, payload, freshSettings())) {
      try {
        const { created } = enqueue({ role, body: renderEvent(event, payload), externalId: hookExternalId(event, role, payload.id || payload.title || "", now()) });
        log(`[hook] ${event} → ${role}${created ? "" : " (debounced)"}`);
      } catch (error) {
        log(`[hook] ${event} → ${role} failed: ${error.message}`);
      }
    }
  }

  async function tickHeartbeats() {
    const state = readHeartbeatState(targetRoot, env);
    for (const entry of Object.values(freshSettings())) {
      if (!entry.heartbeat || running.has(entry.role)) continue;
      const roleState = state.roles[entry.role] || {};
      if (!heartbeatDue({ intervalSeconds: entry.heartbeat.intervalSeconds, lastRunAt: roleState.lastRunAt, now: now() })) continue;
      const cap = entry.heartbeat.budgetUsdPerDay;
      const today = now().toISOString().slice(0, 10);
      if (cap != null && spentToday(entry.role) >= cap) {
        if (roleState.lastSkip !== today) {
          log(`[heartbeat] ${entry.role}: daily budget cap $${cap} reached; skipping until tomorrow`);
          state.roles[entry.role] = { ...roleState, lastSkip: today };
          writeHeartbeatState(targetRoot, state, env);
        }
        continue;
      }
      running.add(entry.role);
      state.roles[entry.role] = { ...roleState, lastRunAt: now().toISOString() };
      writeHeartbeatState(targetRoot, state, env);
      void Promise.resolve(runTurn(entry.role, entry.heartbeat.prompt || defaultHeartbeatPrompt))
        .catch((error) => log(`[heartbeat] ${entry.role}: ${error.message}`))
        .finally(() => running.delete(entry.role));
    }
  }

  return { emit, tickHeartbeats, freshSettings };
}
