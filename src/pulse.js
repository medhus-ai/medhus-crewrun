import { listRoleSpecs } from "./role-spec.js";

// Agent heartbeat and lifecycle-hook settings; execution belongs to the durable runtime.
const UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2629800, y: 31557600 };
export const MIN_INTERVAL_S = 1;
export const MAX_INTERVAL_S = UNITS.y;

// "90s" | "30m" | "1h" | "2d" | "1w" | "1mo" | "1y" | bare seconds → seconds; null = off; NaN = invalid.
export function parseInterval(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || text === "off" || text === "false" || text === "0") return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w|mo|y)?$/);
  if (!match) return NaN;
  const seconds = Number(match[1]) * UNITS[match[2] || "s"];
  return Number.isFinite(seconds) ? Math.round(seconds) : NaN;
}

export function loadRoleSettings(targetRoot) {
  const settings = {};
  for (const [role, spec] of Object.entries(listRoleSpecs(targetRoot))) {
    const heartbeatRaw = spec.heartbeat?.interval;
    const intervalSeconds = parseInterval(heartbeatRaw);
    settings[role] = {
      role,
      heartbeat: Number.isFinite(intervalSeconds) && intervalSeconds !== null ? {
        intervalSeconds,
        prompt: spec.heartbeat.prompt || "",
        budgetUsdPerDay: spec.heartbeat.budget_usd_per_day != null ? Number(spec.heartbeat.budget_usd_per_day) : null
      } : null,
      hooks: spec.hooks,
      front: { runner: spec.runner, title: spec.title, ...(heartbeatRaw !== undefined && heartbeatRaw !== null ? { heartbeat: String(heartbeatRaw) } : {}) },
      spec
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
    const web = entry.spec?.web;
    if (web && !web.allow.length) warnings.push(`${entry.role}: web access is open (no allowlist) — add "web": { "allow": [...] } to restrict hosts`);
    if (knownEvents.length) {
      for (const event of entry.hooks) {
        if (!knownEvents.includes(event)) problems.push(`${entry.role}: unknown hook event "${event}" (known: ${knownEvents.join(", ")})`);
      }
    }
  }
  return { problems, warnings };
}
