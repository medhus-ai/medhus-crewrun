import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const executable = path.resolve(process.argv[2]);
const home = mkdtempSync(path.join(os.tmpdir(), "crew window ü "));
const env = { ...process.env, CREW_HOME: home, CREWRUN_PUBLIC_BASE_URL: "" };
const run = (flag) => promisify(execFile)(executable, [flag], { env, timeout: 30000 });
try {
  const result = await run("--smoke-window");
  assert.match(result.stdout, /rendered authenticated Dashboard/);
  const status = JSON.parse((await run("--status")).stdout);
  assert.ok(status.pid, "closing the window leaves the shared runner alive");
  console.log("Native webview: authenticated Dashboard rendered; window exit preserved the runner.");
} finally {
  try { await run("--stop"); } catch { /* failed startup or already stopped */ }
  // Wait for SQLite and Windows file handles to close before deleting this test's home.
  for (let i = 0; i < 100; i++) {
    try { await run("--status"); } catch { break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
