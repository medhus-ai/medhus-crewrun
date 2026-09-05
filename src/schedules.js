import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { agentFile } from "./agent-paths.js";
import { crewDir, crewHome } from "./crew-dirs.js";
import { listRoleSpecs, roleScheduledEntries } from "./role-spec.js";

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

export const SCHEDULE_WEEKDAYS = Object.freeze([
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" }
]);

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

// The persisted format remains standard five-field cron. The console uses
// these helpers to offer normal people a cadence and time instead of a code
// expression, while still preserving an older advanced expression unchanged.
export function recurrenceFromCron(expression) {
  const cron = parseCron(expression).expression;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(" ");
  const validClock = isClockField(hour, 0, 23) && isClockField(minute, 0, 59);
  const base = {
    time: validClock ? toTime(hour, minute) : "09:00",
    weekday: "1",
    dayOfMonth: "1",
    intervalDays: "2",
    existingCron: cron
  };
  if (!validClock || month !== "*") return { ...base, cadence: "advanced" };
  if (dayOfMonth === "*" && dayOfWeek === "*") return { ...base, cadence: "daily" };
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return { ...base, cadence: "weekdays" };
  if (dayOfMonth === "*" && /^(?:0|[1-6]|7)$/.test(dayOfWeek)) return { ...base, cadence: "weekly", weekday: dayOfWeek === "7" ? "0" : dayOfWeek };
  if (dayOfWeek === "*" && /^(?:[1-9]|[12]\d|3[01])$/.test(dayOfMonth)) return { ...base, cadence: "monthly", dayOfMonth };
  const everyDays = dayOfMonth.match(/^\*\/([2-9]|[12]\d|3[01])$/);
  if (dayOfWeek === "*" && everyDays) return { ...base, cadence: "every-days", intervalDays: everyDays[1] };
  return { ...base, cadence: "advanced" };
}

export function cronFromRecurrence({ cadence, time, weekday, dayOfMonth, intervalDays, existingCron } = {}) {
  const choice = String(cadence || "").trim();
  if (choice === "advanced") {
    if (!existingCron) throw new Error("choose a standard repeat rule for a new schedule");
    return parseCron(existingCron).expression;
  }
  const { hour, minute } = parseScheduleTime(time);
  let cron;
  if (choice === "daily") cron = `${minute} ${hour} * * *`;
  else if (choice === "weekdays") cron = `${minute} ${hour} * * 1-5`;
  else if (choice === "weekly") cron = `${minute} ${hour} * * ${weekdayValue(weekday)}`;
  else if (choice === "monthly") cron = `${minute} ${hour} ${monthDayValue(dayOfMonth)} * *`;
  else if (choice === "every-days") cron = `${minute} ${hour} */${intervalValue(intervalDays)} * *`;
  else throw new Error("choose when this schedule should run");
  return parseCron(cron).expression;
}

export function describeScheduleRecurrence(expression) {
  const recurrence = recurrenceFromCron(expression);
  const at = formatTime(recurrence.time);
  if (recurrence.cadence === "daily") return `Every day at ${at}`;
  if (recurrence.cadence === "weekdays") return `Weekdays at ${at}`;
  if (recurrence.cadence === "weekly") return `Every ${weekdayLabel(recurrence.weekday)} at ${at}`;
  if (recurrence.cadence === "monthly") return `Monthly on day ${recurrence.dayOfMonth} at ${at}`;
  if (recurrence.cadence === "every-days") return `Every ${recurrence.intervalDays} days at ${at}`;
  return "Advanced schedule";
}

function isClockField(value, min, max) {
  return /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max;
}

function toTime(hour, minute) {
  return `${String(Number(hour)).padStart(2, "0")}:${String(Number(minute)).padStart(2, "0")}`;
}

function parseScheduleTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("choose a valid time");
  return { hour, minute };
}

function weekdayValue(value) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error("choose a valid weekday");
  return day;
}

function monthDayValue(value) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("choose a day between 1 and 31");
  return day;
}

function intervalValue(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 2 || days > 31) throw new Error("choose an interval between 2 and 31 days");
  return days;
}

function weekdayLabel(value) {
  return SCHEDULE_WEEKDAYS.find((day) => day.value === String(value))?.label || "selected day";
}

function formatTime(value) {
  const { hour, minute } = parseScheduleTime(value);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
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

// Legacy global file; new projects keep scheduled tasks inside each role's spec instead.
export function schedulesPath(targetRoot) {
  return path.join(path.resolve(targetRoot || process.cwd()), crewDir(), "schedules.json");
}

// Scheduled tasks come from every role's spec (roles/<role>.json "scheduled": [...]) plus
// the legacy global file; IDs are unique per role, and run-state keys are "role:id".
export function listSchedules({ targetRoot } = {}) {
  const out = [];
  const seen = new Set();
  for (const spec of Object.values(listRoleSpecs(targetRoot || process.cwd()))) {
    for (const entry of spec.schedules) {
      const schedule = normalizeSchedule(entry);
      const key = `${schedule.role}:${schedule.id}`;
      if (seen.has(key)) throw new Error(`duplicate schedule id for ${schedule.role}: ${schedule.id}`);
      seen.add(key);
      out.push(schedule);
    }
  }
  const file = schedulesPath(targetRoot);
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    for (const entry of (Array.isArray(parsed?.schedules) ? parsed.schedules : [])) {
      const schedule = normalizeSchedule(entry);
      if (!seen.has(`${schedule.role}:${schedule.id}`)) out.push(schedule);
    }
  }
  return out;
}

export function scheduleRunsKey(schedule) {
  return `${schedule.role}:${schedule.id}`;
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

// Writes land in the owning role's spec as `scheduled` when it exists; otherwise the legacy
// global file keeps its established `schedules` format.
export function upsertSchedule({ targetRoot, schedule } = {}) {
  const next = normalizeSchedule(schedule);
  const specFile = roleSpecPath(targetRoot, next.role);
  if (specFile) {
    const spec = JSON.parse(readFileSync(specFile, "utf8"));
    const scheduled = roleScheduledEntries(spec).filter((entry) => entry.id !== next.id);
    const { role, ...entry } = next;
    spec.scheduled = [...scheduled, entry];
    delete spec.schedules;
    writeJsonAtomic(specFile, spec);
    return next;
  }
  const current = legacySchedules(targetRoot).filter((entry) => !(entry.id === next.id && entry.role === next.role));
  saveSchedules({ targetRoot, schedules: [...current, next] });
  return next;
}

function roleSpecPath(targetRoot, role) {
  const file = agentFile(targetRoot || process.cwd(), role);
  return existsSync(file) ? file : null;
}

function legacySchedules(targetRoot) {
  const file = schedulesPath(targetRoot);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return (Array.isArray(parsed?.schedules) ? parsed.schedules : []).map(normalizeSchedule);
}

export function removeSchedule({ targetRoot, id, role } = {}) {
  const match = listSchedules({ targetRoot }).find((entry) => entry.id === id && (!role || entry.role === role));
  if (!match) return false;
  const specFile = roleSpecPath(targetRoot, match.role);
  if (specFile) {
    const spec = JSON.parse(readFileSync(specFile, "utf8"));
    spec.scheduled = roleScheduledEntries(spec).filter((entry) => entry.id !== id);
    delete spec.schedules;
    writeJsonAtomic(specFile, spec);
    return true;
  }
  const remaining = legacySchedules(targetRoot).filter((entry) => !(entry.id === id && entry.role === match.role));
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
// A run is considered in progress from lastStartedAt until lastRunAt is written; if a process
// dies in between, the start goes stale after `staleAfterMs` and the schedule becomes due again.
export const DEFAULT_STALE_RUN_MS = 60 * 60 * 1000;

export function dueSchedules({ targetRoot, now = new Date(), state = readScheduleState({ targetRoot }), since, staleAfterMs = DEFAULT_STALE_RUN_MS } = {}) {
  const due = [];
  for (const schedule of listSchedules({ targetRoot })) {
    if (!schedule.enabled) continue;
    const run = state.runs?.[scheduleRunsKey(schedule)] || state.runs?.[schedule.id] || {};
    const lastStarted = Date.parse(run.lastStartedAt || "");
    const lastFinished = Date.parse(run.lastRunAt || "");
    const inProgress = Number.isFinite(lastStarted) && !(Number.isFinite(lastFinished) && lastFinished >= lastStarted);
    if (inProgress && now.getTime() - lastStarted < staleAfterMs) continue;
    const from = Number.isFinite(lastFinished) ? new Date(lastFinished) : since ? new Date(since) : new Date(now.getTime() - 60_000);
    const next = nextRun(schedule.cron, from);
    if (next && next.getTime() <= now.getTime()) due.push({ ...schedule, dueAt: next.toISOString() });
  }
  return due;
}

// Ticks on an interval; `run(schedule)` performs the role turn and resolves to { ok, text?, reason? }.
// One scheduler per project: the JSON run state is not a cross-process lock.
export function createScheduler({ targetRoot, run, intervalMs = 30_000, staleAfterMs = DEFAULT_STALE_RUN_MS, now = () => new Date(), env = process.env, log = () => {}, error = () => {} } = {}) {
  if (typeof run !== "function") throw new Error("createScheduler requires run(schedule)");
  let timer = null;
  let ticking = false;

  async function execute(schedule, startedAt) {
    const state = readScheduleState({ targetRoot, env });
    const runsKey = scheduleRunsKey(schedule);
    state.runs[runsKey] = { ...(state.runs[runsKey] || state.runs[schedule.id] || {}), lastStartedAt: startedAt.toISOString() };
    writeScheduleState({ targetRoot, env, state });
    const began = Date.now();
    let result;
    try {
      result = await run(schedule);
    } catch (err) {
      result = { ok: false, reason: err?.message || String(err) };
    }
    const finished = readScheduleState({ targetRoot, env });
    finished.runs[runsKey] = {
      lastStartedAt: startedAt.toISOString(),
      lastRunAt: new Date(Math.max(now().getTime(), startedAt.getTime())).toISOString(),
      lastStatus: result?.ok === false ? "failed" : "ok",
      lastError: result?.ok === false ? String(result.reason || "").slice(0, 500) : "",
      lastDurationMs: Date.now() - began
    };
    writeScheduleState({ targetRoot, env, state: finished });
    (result?.ok === false ? error : log)(`[schedule] ${schedule.id} (${schedule.role}) ${finished.runs[runsKey].lastStatus}${result?.ok === false ? `: ${result.reason || ""}` : ""}`);
    return finished.runs[runsKey];
  }

  async function tick() {
    if (ticking) return [];
    ticking = true;
    try {
      const at = now();
      const outcomes = [];
      for (const schedule of dueSchedules({ targetRoot, now: at, state: readScheduleState({ targetRoot, env }), staleAfterMs })) {
        outcomes.push({ id: schedule.id, ...(await execute(schedule, at)) });
      }
      return outcomes;
    } finally {
      ticking = false;
    }
  }

  async function runNow(request) {
    const input = typeof request === "string" ? { id: request } : request || {};
    const id = String(input.id || "");
    const role = String(input.role || "");
    const schedule = listSchedules({ targetRoot }).find((entry) => entry.id === id && (!role || entry.role === role));
    if (!schedule) throw new Error(`schedule ${role ? `${role}:` : ""}${id} was not found`);
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
    ...(state.runs[scheduleRunsKey(schedule)] || state.runs[schedule.id] || {})
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
