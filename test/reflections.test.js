import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { crewDir } from "../src/crew-dirs.js";
import { appendReflection, readReflections, reflectionsPath, reflectionsPrompt } from "../src/reflections.js";

test("reflections append to a per-role journal, read back bounded, and render as a prompt section", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-reflections-"));
  assert.equal(reflectionsPath(root, "ceo"), path.join(root, crewDir(), "memory", "reflections", "ceo.md"));
  appendReflection({ targetRoot: root, role: "ceo", text: "Lead with the blocker, not the summary.", ref: "i7" });
  appendReflection({ targetRoot: root, role: "ceo", text: "Founder prefers three bullets.\nNo tables." });
  appendReflection({ targetRoot: root, role: "ops", text: "Vendor list lives in registries.md." });

  const file = readFileSync(reflectionsPath(root, "ceo"), "utf8");
  assert.match(file, /^# Reflections — ceo\n/);
  assert.match(file, /\n## \S+ — i7 — ceo\n\nLead with the blocker/);
  assert.match(file, /\n## \S+ — general — ceo\n\nFounder prefers three bullets\.\nNo tables\.\n$/);

  const all = readReflections({ targetRoot: root, role: "ceo" });
  assert.deepEqual(all.map((e) => [e.ref, e.text]), [["i7", "Lead with the blocker, not the summary."], ["", "Founder prefers three bullets.\nNo tables."]]);
  assert.deepEqual(readReflections({ targetRoot: root, role: "ceo", limit: 1 }).map((e) => e.ref), [""], "newest kept when bounded");
  assert.deepEqual(readReflections({ targetRoot: root, role: "gtm" }), []);

  const prompt = reflectionsPrompt(all, { role: "ceo" });
  assert.match(prompt, /^## Reflections \(ceo\)\n.*Current instructions win/);
  assert.match(prompt, /- \d{4}-\d{2}-\d{2} \(i7\): Lead with the blocker, not the summary\.\n- \d{4}-\d{2}-\d{2}: Founder prefers three bullets\. No tables\./);
  assert.equal(reflectionsPrompt([]), "");
});

test("reflection input is validated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-reflections-bad-"));
  assert.throws(() => appendReflection({ targetRoot: root, role: "CEO", text: "x" }), /lowercase slug/);
  assert.throws(() => appendReflection({ targetRoot: root, role: "ceo", text: "" }), /1 to 2000/);
  assert.throws(() => appendReflection({ targetRoot: root, role: "ceo", text: "## sneaky heading" }), /headings/);
  assert.throws(() => appendReflection({ targetRoot: root, role: "ceo", text: "x".repeat(2001) }), /1 to 2000/);
});
