import assert from "node:assert/strict";
import { test } from "node:test";

import { runProcess } from "../src/process.js";

test("runProcess captures an attached command asynchronously", async () => {
  const pending = runProcess("git", ["--version"], { timeout: 10000 });
  assert.equal(typeof pending?.then, "function");
  const result = await pending;
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /^git version /i);
});
