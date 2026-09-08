import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseInterval, MAX_INTERVAL_S } from "../src/pulse.js";

async function projectWith(roleFrontmatter) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-pulse-"));
  const root = path.join(parent, "repo");
  const roles = path.join(root, ".crew", "agents");
  await mkdir(roles, { recursive: true });
  await writeFile(path.join(roles, "ops.md"), `---\nname: ops\n${roleFrontmatter}\n---\n# Ops\n`, "utf8");
  return { parent, root };
}

test("parseInterval covers 1s to 1y, off states, and rejects garbage", () => {
  assert.equal(parseInterval("1s"), 1);
  assert.equal(parseInterval("90s"), 90);
  assert.equal(parseInterval("30m"), 1800);
  assert.equal(parseInterval("1h"), 3600);
  assert.equal(parseInterval("2d"), 172800);
  assert.equal(parseInterval("1mo"), 2629800);
  assert.equal(parseInterval("1y"), MAX_INTERVAL_S);
  assert.equal(parseInterval("45"), 45);
  assert.equal(parseInterval("off"), null);
  assert.equal(parseInterval(""), null);
  assert.ok(Number.isNaN(parseInterval("soon")));
  assert.ok(Number.isNaN(parseInterval("5 fortnights")));
});
