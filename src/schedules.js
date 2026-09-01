import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { crewDir, crewHome } from "./crew-dirs.js";

// Cron-scheduled role turns. Definitions live in the project (`<crew dir>/schedules.json`,
// versioned like roles); run state lives in the crew home so a repository never churns with
// timestamps. Cron is the standard five-field form evaluated in the process's local time.

const ID = /^[a-z][a-z0-9-]{0,79}$/;
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 } // 7 is Sunday, like 0
];

export function parseCron(expression) {
  const parts = String(expression || "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron expression needs five fields: minute hour day-of-month month day-of-week");
  const sets = parts.map((part, index) => parseField(part, FIELDS[index]));
  const [minutes, hours, days, months, weekdays] = sets;
  if (weekdays.has(7)) weekdays.add(0);
  const anyDay = parts[2] === "*";
  const anyWeekday = parts[4] === "*";
  // Standard cron: when both day fields are restricted, either one matching fires the job.
  const dayMatches = (date) => {
    const dom = days.has(date.getDate());
    const dow = weekdays.has(date.getDay());
    if (anyDay && anyWeekday) return true;
    if (anyDay) return dow;
    if (anyWeekday) return dom;
    return dom || dow;
  };
  return {
    expression: parts.join(" "),
    matches(date) {
      return minutes.has(date.getMinutes()) && hours.has(date.getHours()) && months.has(date.getMonth() + 1) && dayMatches(date);
    },
    matchesDay: (date) => months.has(date.getMonth() + 1) && dayMatches(date)
  };
}

// First matching minute strictly after `from`, or null if none within a year.
export function nextRun(expression, from = new Date()) {
  const cron = typeof expression === "string" ? parseCron(expression) : expression;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = cursor.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limit) {
    if (!cron.matchesDay(cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (cron.matches(cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export function schedulesPath(targetRoot) {
  return path.join(path.resolve(targetRoot || process.cwd()), crewDir(), "schedules.json");
}

export function listSchedules({ targetRoot } = {}) {
  const file = schedulesPath(targetRoot);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return (Array.isArray(parsed?.schedules) ? parsed.schedules : []).map(normalizeSchedule);
}

export function saveSchedules({ targetRoot, schedules = [] } = {}) {
  const normalized = schedules.map(normalizeSchedule);
  const seen = new Set();
  for (const schedule of normalized) {
    if (seen.has(schedule.id)) throw new Error(`duplicate schedule id: ${schedule.id}`);
    seen.add(schedule.id);
  }
  writeJsonAtomic(schedulesPath(targetRoot), { version: 1, schedules: normalized });
  return normalized;
}

export function upsertSchedule({ targetRoot, schedule } = {}) {
  const next = normalizeSchedule(schedule);
  const current = listSchedules({ targetRoot }).filter((entry) => entry.id !== next.id);
  saveSchedules({ targetRoot, schedules: [...current, next] });
  return next;
}

export function removeSchedule({ targetRoot, id } = {}) {
  const current = listSchedules({ targetRoot });
  const remaining = current.filter((entry) => entry.id !== id);
  if (remaining.length === current.length) return false;
  saveSchedules({ targetRoot, schedules: remaining });
  return true;
}

export function setScheduleEnabled({ targetRoot, id, enabled } = {}) {
  const schedule = listSchedules({ targetRoot }).find((entry) => entry.id === id);
  if (!schedule) throw new Error(`schedule ${id} was not found`);
  return upsertSchedule({ targetRoot, schedule: { ...schedule, enabled: Boolean(enabled) } });
}

// Run state per project, keyed by the resolved root; { runs: { [id]: { lastRunAt, lastStartedAt, lastStatus, lastError, lastDurationMs } } }.
export function scheduleStatePath(targetRoot, env = process.env) {
  const key = createHash("sha1").update(path.resolve(targetRoot || process.cwd())).digest("hex").slice(0, 16);
  return path.join(crewHome(env), "schedules", `${key}.json`);
}

export function readScheduleState({ targetRoot, env = process.env } = {}) {
  const file = scheduleStatePath(targetRoot, env);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { version: 1, runs: parsed?.runs && typeof parsed.runs === "object" ? parsed.runs : {} };
  } catch {
    return { version: 1, runs: {} };
  }
}

function writeScheduleState({ targetRoot, env = process.env, state }) {
  writeJsonAtomic(scheduleStatePath(targetRoot, env), state);
}

// Enabled schedules whose next fire time since their last run (or since `since`, by default one
// minute ago for a never-run schedule) is not in the future. A schedule that missed several
// windows while nothing was running fires once, not once per missed window.
export function dueSchedules({ targetRoot, now = new Date(), state = readScheduleState({ targetRoot }), since } = {}) {
  const due = [];
  for (const schedule of listSchedules({ targetRoot })) {
    if (!schedule.enabled) continue;
    const run = state.runs?.[schedule.id] || {};
    const lastStarted = Date.parse(run.lastStartedAt || "");
    const lastFinished = Date.parse(run.lastRunAt || "");
    if (Number.isFinite(lastStarted) && !(Number.isFinite(lastFinished) && lastFinished >= lastStarted)) continue; // running
    const from = Number.isFinite(lastFinished) ? new Date(lastFinished) : since ? new Date(since) : new Date(now.getTime() - 60_000);
    const next = nextRun(schedule.cron, from);
    if (next && next.getTime() <= now.getTime()) due.push({ ...schedule, dueAt: next.toISOString() });
  }
  return due;
}

// Ticks on an interval; `run(schedule)` performs the role turn and resolves to { ok, text?, reason? }.
export function createScheduler({ targetRoot, run, intervalMs = 30_000, now = () => new Date(), env = process.env, log = () => {}, error = () => {} } = {}) {
  if (typeof run !== "function") throw new Error("createScheduler requires run(schedule)");
  let timer = null;
  let ticking = false;

  async function execute(schedule, startedAt) {
    const state = readScheduleState({ targetRoot, env });
    state.runs[schedule.id] = { ...(state.runs[schedule.id] || {}), lastStartedAt: startedAt.toISOString() };
    writeScheduleState({ targetRoot, env, state });
    const began = Date.now();
    let result;
    try {
      result = await run(schedule);
    } catch (err) {
      result = { ok: false, reason: err?.message || String(err) };
    }
    const finished = readScheduleState({ targetRoot, env });
    finished.runs[schedule.id] = {
      lastStartedAt: startedAt.toISOString(),
      lastRunAt: new Date(Math.max(Date.now(), startedAt.getTime())).toISOString(),
      lastStatus: result?.ok === false ? "failed" : "ok",
      lastError: result?.ok === false ? String(result.reason || "").slice(0, 500) : "",
      lastDurationMs: Date.now() - began
    };
    writeScheduleState({ targetRoot, env, state: finished });
    (result?.ok === false ? error : log)(`[schedule] ${schedule.id} (${schedule.role}) ${finished.runs[schedule.id].lastStatus}${result?.ok === false ? `: ${result.reason || ""}` : ""}`);
    return finished.runs[schedule.id];
  }

  async function tick() {
    if (ticking) return [];
    ticking = true;
    try {
      const at = now();
      const outcomes = [];
      for (const schedule of dueSchedules({ targetRoot, now: at, state: readScheduleState({ targetRoot, env }) })) {
        outcomes.push({ id: schedule.id, ...(await execute(schedule, at)) });
      }
      return outcomes;
    } finally {
      ticking = false;
    }
  }

  async function runNow(id) {
    const schedule = listSchedules({ targetRoot }).find((entry) => entry.id === id);
    if (!schedule) throw new Error(`schedule ${id} was not found`);
    return { id, ...(await execute(schedule, now())) };
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick().catch((err) => error(`[schedule] ${err?.message || err}`)); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    runNow
  };
}

// Display helper: every schedule with its next fire time and last outcome.
export function scheduleOverview({ targetRoot, now = new Date(), env = process.env } = {}) {
  const state = readScheduleState({ targetRoot, env });
  return listSchedules({ targetRoot }).map((schedule) => ({
    ...schedule,
    nextRunAt: schedule.enabled ? nextRun(schedule.cron, now)?.toISOString() || null : null,
    ...(state.runs[schedule.id] || {})
  }));
}

export function normalizeSchedule(value = {}) {
  const id = String(value.id || "").trim();
  const role = String(value.role || "").trim();
  const prompt = String(value.prompt || "").trim();
  if (!ID.test(id)) throw new Error("schedule id must be a lowercase slug");
  if (!ID.test(role)) throw new Error("schedule role must be a lowercase slug");
  if (!prompt || prompt.length > 20_000) throw new Error("schedule prompt must contain 1 to 20000 characters");
  const cron = parseCron(value.cron).expression;
  return {
    id,
    role,
    cron,
    prompt,
    title: String(value.title || "").trim().slice(0, 120) || id,
    enabled: value.enabled !== false
  };
}

function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const item of String(text).split(",")) {
    const match = item.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!match) throw new Error(`invalid cron ${name} field: ${text}`);
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron ${name} step: ${text}`);
    let start = min;
    let end = max;
    if (match[1] !== "*") {
      const [a, b] = match[1].split("-").map(Number);
      start = a;
      end = b === undefined ? (match[2] === undefined ? a : max) : b;
    }
    if (start < min || end > max || start > end) throw new Error(`cron ${name} out of range: ${text}`);
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}
