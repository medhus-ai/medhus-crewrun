import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { agentFile } from "./agent-paths.js";
import { listRoleSpecs, roleScheduledEntries } from "./role-spec.js";
import { readWorkspace } from "./workspace-manifest.js";

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
export function nextRun(expression, from = new Date(), { timezone } = {}) {
  const cron = typeof expression === "string" ? parseCron(expression) : expression;
  if (timezone) {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" });
    let at = Math.floor(from.getTime() / 60000) * 60000 + 60000;
    const end = at + 366 * 86400000;
    while (at <= end) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(at)).map((p) => [p.type, p.value]));
      const local = { getMinutes: () => Number(parts.minute), getHours: () => Number(parts.hour), getMonth: () => Number(parts.month) - 1, getDate: () => Number(parts.day), getDay: () => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday) };
      if (cron.matches(local)) return new Date(at);
      const step = cron.matchesDay(local) ? 1 : Math.max(1, Math.min(60, 1440 - local.getHours() * 60 - local.getMinutes()));
      at += step * 60000;
    }
    return null;
  }
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

// Definitions live only in their owning agent JSON. Run state lives in SQLite.
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
  const timezone = readWorkspace(targetRoot || process.cwd())?.timezone;
  return timezone ? out.map((entry) => ({ ...entry, timezone })) : out;
}

export function scheduleRunsKey(schedule) {
  return `${schedule.role}:${schedule.id}`;
}

export function upsertSchedule({ targetRoot, schedule } = {}) {
  const next = normalizeSchedule(schedule);
  const specFile = roleSpecPath(targetRoot, next.role);
  if (!specFile) throw new Error(`Agent ${next.role} must have a JSON definition before adding scheduled tasks.`);
  const spec = JSON.parse(readFileSync(specFile, "utf8"));
  const scheduled = roleScheduledEntries(spec).filter((entry) => entry.id !== next.id);
  const { role, ...entry } = next;
  spec.scheduled = [...scheduled, entry];
  writeJsonAtomic(specFile, spec);
  return next;
}

function roleSpecPath(targetRoot, role) {
  const file = agentFile(targetRoot || process.cwd(), role);
  return existsSync(file) ? file : null;
}

export function removeSchedule({ targetRoot, id, role } = {}) {
  const match = listSchedules({ targetRoot }).find((entry) => entry.id === id && (!role || entry.role === role));
  if (!match) return false;
  const specFile = roleSpecPath(targetRoot, match.role);
  const spec = JSON.parse(readFileSync(specFile, "utf8"));
  spec.scheduled = roleScheduledEntries(spec).filter((entry) => entry.id !== id);
  writeJsonAtomic(specFile, spec);
  return true;
}

// Display helper: every schedule with its next fire time and last outcome.
export function scheduleOverview({ targetRoot, now = new Date() } = {}) {
  return listSchedules({ targetRoot }).map((schedule) => ({
    ...schedule,
    nextRunAt: schedule.enabled ? nextRun(schedule.cron, now, { timezone: schedule.timezone })?.toISOString() || null : null
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
