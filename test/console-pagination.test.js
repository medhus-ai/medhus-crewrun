import assert from "node:assert/strict";
import test from "node:test";
import { paginate, upcomingOccurrences } from "../src/console/views.js";
import { renderPartial } from "../src/console/pages.js";

function models() {
  const runs = Array.from({ length: 23 }, (_, index) => ({
    id: `run-${index}`, agent: "ops", prompt: `Work ${index}`, workflow: "manual", desired: "active",
    status: "completed", created_at: 1_700_000_000_000, actions: [], timeline: [], artifacts: [], dependencies: []
  }));
  return {
    specs: {}, schedules: [], skillProposals: [], prefProposals: [], reflectionProposals: [], proposalHistory: [],
    operations: { runs, approvals: [], events: [], audit: [], connectors: [], eventRoutes: [] }
  };
}

test("pagination retains filters, clamps stale page numbers, and escapes query strings", () => {
  const items = Array.from({ length: 23 }, (_, index) => index);
  const middle = paginate(items, { page: 2, base: "/activity", params: { tab: "events", q: 'mail"<tag>' } });
  assert.deepEqual(middle.items, items.slice(10, 20));
  assert.match(middle.html, /tab=events&amp;q=mail%22%3Ctag%3E&amp;page=3/);
  assert.deepEqual(paginate(items, { page: 999, base: "/tasks" }).items, [20, 21, 22]);
  assert.equal(paginate([], { base: "/tasks" }).html, "");
});

test("Tasks defaults to attention and paginates after filtering; result reviews use the same pages", () => {
  const data = models();
  data.operations.runs.unshift({ ...data.operations.runs[0], id: "active", status: "running", prompt: "Working now" });
  const first = renderPartial("tasks", data);
  assert.match(first, /aria-current="page" href="\/tasks\?tab=attention"/);
  assert.equal((first.match(/<section class="card">/g) || []).length, 10);
  assert.doesNotMatch(first, /Working now|<strong>Work 10<\/strong>/);
  const second = renderPartial("tasks", data, { page: 2 });
  assert.match(second, /<strong>Work 10<\/strong>/);
  assert.doesNotMatch(second, /<strong>Work 0<\/strong>/);
  const reviews = renderPartial("reviews", data, { tab: "results", page: 3 });
  assert.equal((reviews.match(/<section class="card">/g) || []).length, 3);
  assert.match(reviews, /21–23 of 23/);
});

test("Scheduled defaults to recurring calendar occurrences, with count selection and stable next pages", () => {
  const data = models();
  data.schedules = [{ id: "brief", title: "Daily brief", role: "ops", cron: "0 9 * * *", enabled: true }];
  const from = "2026-09-08T00:00:00";
  const occurrences = upcomingOccurrences(data.schedules, { from: new Date(from), limit: 6 });
  assert.equal(occurrences.length, 6);
  assert.ok(occurrences.every((entry, index) => index === 0 || entry.nextRunAt > occurrences[index - 1].nextRunAt));
  const first = renderPartial("scheduled", data, { calendarFrom: from });
  assert.equal((first.match(/class="calendar-event"/g) || []).length, 3);
  assert.match(first, /count=3&amp;from=.*&amp;page=2/);
  assert.ok(first.indexOf(">Calendar</a>") < first.indexOf(">List</a>"));
  for (const count of [5, 10, 25]) {
    const html = renderPartial("scheduled", data, { calendarCount: count, calendarFrom: from });
    assert.equal((html.match(/class="calendar-event"/g) || []).length, count);
  }
  const second = renderPartial("scheduled", data, { calendarFrom: from, page: 2 });
  assert.doesNotMatch(second, /Tue, Sep 8/);
  data.schedules[0].enabled = false;
  assert.doesNotMatch(renderPartial("scheduled", data), /class="calendar-event"/);
});

test("scheduled lists, action reviews, learning and activity each render ten records per page", () => {
  const data = models();
  data.schedules = data.operations.runs.map((run, index) => ({ id: `task-${index}`, role: "ops", cron: "0 9 * * *", enabled: true }));
  data.operations.approvals = data.operations.runs.map((run) => ({ id: run.id, title: run.prompt, status: "pending" }));
  data.skillProposals = data.operations.runs.map((run) => ({ id: run.id, skillId: run.id, description: run.prompt }));
  data.operations.events = data.operations.runs.map((run) => ({ type: "mail.received", connectionId: "mail", providerEventId: run.id, status: "received" }));
  const rows = (html) => (html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr>/g) || []).length;
  const list = renderPartial("scheduled", data, { tab: "list", page: 2, canRunNow: true });
  assert.equal(rows(list), 10);
  assert.equal((list.match(/role="switch"/g) || []).length, 10);
  assert.doesNotMatch(list, />(?:Delete task|Disable task|Enable task)<\/button>/);
  assert.match(list, /name="return_to" value="\/scheduled\?tab=list&amp;page=2"/);
  assert.equal(rows(renderPartial("reviews", data, { tab: "actions" })), 10);
  assert.equal(rows(renderPartial("reviews", data, { tab: "learning", page: 3 })), 3);
  const activity = renderPartial("activity", data, { tab: "events", page: 2, search: "mail" });
  assert.equal(rows(activity), 10);
  assert.match(activity, /tab=events&amp;q=mail&amp;page=3/);
});
