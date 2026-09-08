import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cronFromRecurrence, describeScheduleRecurrence, nextRun, parseCron, recurrenceFromCron } from "../src/schedules.js";

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

test("schedule recurrence helpers translate friendly controls without changing stored cron", () => {
  assert.equal(cronFromRecurrence({ cadence: "daily", time: "09:00" }), "0 9 * * *");
  assert.equal(cronFromRecurrence({ cadence: "weekdays", time: "08:30" }), "30 8 * * 1-5");
  assert.equal(cronFromRecurrence({ cadence: "weekly", time: "13:05", weekday: "4" }), "5 13 * * 4");
  assert.equal(cronFromRecurrence({ cadence: "monthly", time: "10:00", dayOfMonth: "1" }), "0 10 1 * *");
  assert.equal(cronFromRecurrence({ cadence: "every-days", time: "09:00", intervalDays: "4" }), "0 9 */4 * *");
  assert.equal(describeScheduleRecurrence("30 8 * * 1-5"), "Weekdays at 8:30 AM");
  assert.equal(describeScheduleRecurrence("0 9 */4 * *"), "Every 4 days at 9:00 AM");
  assert.equal(recurrenceFromCron("*/15 9-17 * * 1-5").cadence, "advanced");
  assert.equal(cronFromRecurrence({ cadence: "advanced", existingCron: "*/15 9-17 * * 1-5" }), "*/15 9-17 * * 1-5");
  assert.throws(() => cronFromRecurrence({ cadence: "daily", time: "25:00" }), /valid time/);
});

test("nextRun finds the next matching minute and skips non-matching days quickly", () => {
  const from = new Date(2026, 8, 1, 6, 0, 30); // Tue Sept 1 06:00:30
  assert.equal(nextRun("0 6 * * *", from).getTime(), new Date(2026, 8, 2, 6, 0).getTime(), "same minute is not 'next'");
  assert.equal(nextRun("30 6 * * *", from).getTime(), new Date(2026, 8, 1, 6, 30).getTime());
  assert.equal(nextRun("0 9 * * 1", from).getTime(), new Date(2026, 8, 7, 9, 0).getTime(), "next Monday");
  assert.equal(nextRun("0 0 31 2 *", from), null, "never matches within a year");
});
