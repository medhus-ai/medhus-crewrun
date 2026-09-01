import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createScheduler, dueSchedules, listSchedules, nextRun, parseCron, removeSchedule, scheduleOverview, scheduleStatePath, setScheduleEnabled, upsertSchedule } from "../src/schedules.js";

test("parseCron handles stars, ranges, steps, lists, and both day fields; rejects bad input", () => {
  const at = (iso) => new Date(iso); // local time; the fixtures below use times that are the same in any zone offset of whole hours
  const daily = parseCron("0 6 * * *");
  const d = new Date(2026, 8, 1, 6, 0); // Sept 1 2026 06:00 local
  assert.equal(daily.matches(d), true);
  assert.equal(daily.matches(new Date(2026, 8, 1, 6, 1)), false);
  assert.equal(parseCron("*/15 9-17 * * 1-5").matches(new Date(2026, 8, 1, 9, 45)), true); // Tuesday
  assert.equal(parseCron("*/15 9-17 * * 1-5").matches(new Date(2026, 8, 6, 9, 45)), false); // Sunday
  assert.equal(parseCron("0 0 1,15 * *").matches(new Date(2026, 8, 15, 0, 0)), true);
  assert.equal(parseCron("0 0 * * 7").matches(new Date(2026, 8, 6, 0, 0)), true, "7 is Sunday");
  assert.equal(parseCron("0 0 13 * 5").matches(new Date(2026, 8, 13, 0, 0)), true, "either day field fires when both are restricted");
  assert.equal(parseCron("5 4 * * *").expression, "5 4 * * *");
  for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "1-0 * * * *", "*/0 * * * *", "a * * * *"]) assert.throws(() => parseCron(bad), /cron/);
  void at;
});

test("nextRun finds the next matching minute and skips non-matching days quickly", () => {
  const from = new Date(2026, 8, 1, 6, 0, 30); // Tue Sept 1 06:00:30
  assert.equal(nextRun("0 6 * * *", from).getTime(), new Date(2026, 8, 2, 6, 0).getTime(), "same minute is not 'next'");
  assert.equal(nextRun("30 6 * * *", from).getTime(), new Date(2026, 8, 1, 6, 30).getTime());
  assert.equal(nextRun("0 9 * * 1", from).getTime(), new Date(2026, 8, 7, 9, 0).getTime(), "next Monday");
  assert.equal(nextRun("0 0 31 2 *", from), null, "never matches within a year");
});

test("schedules persist in the project file and state lives in the crew home", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "crew-schedules-"));
  const root = path.join(base, "repo");
  const env = { CREW_HOME: path.join(base, "home") };
  assert.deepEqual(listSchedules({ targetRoot: root }), []);
  upsertSchedule({ targetRoot: root, schedule: { id: "morning-brief", role: "ceo", cron: "0 6 * * 1-5", prompt: "Write the brief.", title: "Morning brief" } });
  upsertSchedule({ targetRoot: root, schedule: { id: "stale-digest", role: "ops", cron: "0 9 * * 1", prompt: "List stale items." } });
  assert.deepEqual(listSchedules({ targetRoot: root }).map((s) => [s.id, s.enabled, s.title]), [["morning-brief", true, "Morning brief"], ["stale-digest", true, "stale-digest"]]);
  setScheduleEnabled({ targetRoot: root, id: "stale-digest", enabled: false });
  assert.equal(listSchedules({ targetRoot: root }).find((s) => s.id === "stale-digest").enabled, false);
  assert.throws(() => upsertSchedule({ targetRoot: root, schedule: { id: "x", role: "ceo", cron: "bad", prompt: "p" } }), /cron/);
  assert.throws(() => upsertSchedule({ targetRoot: root, schedule: { id: "Bad", role: "ceo", cron: "* * * * *", prompt: "p" } }), /lowercase slug/);
  assert.equal(removeSchedule({ targetRoot: root, id: "nope" }), false);
  assert.equal(removeSchedule({ targetRoot: root, id: "stale-digest" }), true);
  assert.ok(scheduleStatePath(root, env).startsWith(path.join(env.CREW_HOME, "schedules")));
  assert.equal(existsSync(path.join(root, ".crew", "schedules.json")) || existsSync(path.join(root, process.env.CREW_DIR_NAME || ".crew", "schedules.json")), true);
});

test("the scheduler runs due schedules once, records outcomes, and never double-fires", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "crew-scheduler-"));
  const root = path.join(base, "repo");
  const env = { CREW_HOME: path.join(base, "home") };
  upsertSchedule({ targetRoot: root, schedule: { id: "every-minute", role: "ceo", cron: "* * * * *", prompt: "tick" } });
  upsertSchedule({ targetRoot: root, schedule: { id: "never-soon", role: "ceo", cron: "0 0 31 2 *", prompt: "never" } });
  const runs = [];
  let clock = new Date(2026, 8, 1, 6, 0, 5);
  const scheduler = createScheduler({ targetRoot: root, env, now: () => clock, run: async (schedule) => { runs.push(schedule.id); return runs.length === 2 ? { ok: false, reason: "runner busy" } : { ok: true, text: "done" }; } });

  assert.deepEqual((await scheduler.tick()).map((o) => [o.id, o.lastStatus]), [["every-minute", "ok"]]);
  assert.deepEqual(await scheduler.tick(), [], "same minute does not fire twice");
  clock = new Date(2026, 8, 1, 6, 1, 2);
  assert.deepEqual((await scheduler.tick()).map((o) => [o.id, o.lastStatus, o.lastError]), [["every-minute", "failed", "runner busy"]]);
  clock = new Date(2026, 8, 1, 6, 10, 0);
  assert.equal((await scheduler.tick()).length, 1, "several missed minutes fire once");
  assert.deepEqual(runs, ["every-minute", "every-minute", "every-minute"]);

  const overview = scheduleOverview({ targetRoot: root, now: clock, env });
  const every = overview.find((s) => s.id === "every-minute");
  assert.equal(every.lastStatus, "ok");
  assert.equal(every.nextRunAt, new Date(2026, 8, 1, 6, 11).toISOString());
  assert.equal(overview.find((s) => s.id === "never-soon").nextRunAt, null);
  assert.equal((await scheduler.runNow("never-soon")).lastStatus, "ok");
  assert.deepEqual(dueSchedules({ targetRoot: root, now: clock, state: { runs: {} } }).map((s) => s.id), ["every-minute"]);
  await assert.rejects(scheduler.runNow("missing"), /not found/);
});

test("a crashed run goes stale instead of blocking the schedule forever", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "crew-scheduler-stale-"));
  const root = path.join(base, "repo");
  upsertSchedule({ targetRoot: root, schedule: { id: "job", role: "ceo", cron: "* * * * *", prompt: "go" } });
  const started = new Date(2026, 8, 1, 6, 0, 0);
  const crashed = { runs: { job: { lastStartedAt: started.toISOString() } } }; // no lastRunAt ever written
  assert.deepEqual(dueSchedules({ targetRoot: root, now: new Date(started.getTime() + 10 * 60_000), state: crashed }), [], "recent start counts as running");
  assert.deepEqual(dueSchedules({ targetRoot: root, now: new Date(started.getTime() + 61 * 60_000), state: crashed }).map((s) => s.id), ["job"], "a stale start is released");
  assert.deepEqual(dueSchedules({ targetRoot: root, now: new Date(started.getTime() + 2 * 60_000), state: crashed, staleAfterMs: 60_000 }).map((s) => s.id), ["job"], "threshold is configurable");
});
