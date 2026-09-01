import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkItemSource, parseWorkItem } from "../src/work-items.js";

test("parses bullet fields, frontmatter fields, and the title", () => {
  const bullets = parseWorkItem("t1", "# Ship the brief\n\n- **Status:** open\n- **Owner:** CEO\n- **Due Date:** 2026-09-01\n\nBody.");
  assert.deepEqual(bullets, { id: "t1", title: "Ship the brief", fields: { status: "open", owner: "CEO", due_date: "2026-09-01" } });
  const front = parseWorkItem("t2", "---\ntitle: Fix login\nstatus: blocked\n---\n\n# Ignored heading\n- **Status:** open\n");
  assert.equal(front.title, "Fix login");
  assert.equal(front.fields.status, "blocked", "frontmatter wins over bullets");
});

test("source lists, filters, creates, and updates items in place", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crew-work-items-"));
  const source = createWorkItemSource({ dir });
  assert.deepEqual(source.list(), []);
  source.create("20260831-1000-ceo-brief", { title: "Daily brief", fields: { status: "open", owner: "CEO" }, body: "Summarise the inbox." });
  await writeFile(path.join(dir, "20260831-1100-ops-vendors.md"), "---\nstatus: review\nowner: OPS\n---\n\n# Vendor renewals\n", "utf8");
  await writeFile(path.join(dir, "notes.txt"), "ignored", "utf8");

  assert.deepEqual(source.list().map((item) => item.id), ["20260831-1000-ceo-brief", "20260831-1100-ops-vendors"]);
  assert.deepEqual(source.list({ status: "open" }).map((item) => item.title), ["Daily brief"]);
  assert.equal(source.get("missing"), null);
  assert.throws(() => source.get("../escape"), /invalid work item id/);
  assert.throws(() => source.create("20260831-1000-ceo-brief", {}), /already exists/);

  const updated = source.update("20260831-1000-ceo-brief", { status: "in-progress", updated: "2026-08-31" });
  assert.equal(updated.fields.status, "in-progress");
  assert.equal(updated.fields.updated, "2026-08-31");
  const text = await readFile(path.join(dir, "20260831-1000-ceo-brief.md"), "utf8");
  assert.match(text, /^# Daily brief\n\n- \*\*Status:\*\* in-progress\n- \*\*Owner:\*\* CEO\n- \*\*Updated:\*\* 2026-08-31\n\nSummarise the inbox\.\n$/);

  const front = source.update("20260831-1100-ops-vendors", { status: "done" });
  assert.equal(front.fields.status, "done");
  assert.match(await readFile(path.join(dir, "20260831-1100-ops-vendors.md"), "utf8"), /^---\nstatus: done\nowner: OPS\n---/);
});
