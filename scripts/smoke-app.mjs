import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const artifact = path.resolve(process.argv[2] || "dist/payload");
const manifest = JSON.parse(readFileSync(path.join(artifact, "manifest.json")));
assert.equal(manifest.platform, process.platform); assert.equal(manifest.arch, process.arch);
const node = path.join(artifact, "runtime", process.platform === "win32" ? "node.exe" : "node");
const entry = path.join(artifact, "app/node_modules/medhus-crewrun/bin/crewrun-app.js");
const home = mkdtempSync(path.join(os.tmpdir(), "crew packaged ü "));
// Deliberately remove PATH on POSIX: no system Node/npm can rescue the artifact.
// Windows retains system utilities for owner ACL setup, but not the developer Node path.
const env = { ...process.env, CREW_HOME: home, CREWRUN_PUBLIC_BASE_URL: "", NODE_PATH: "", NODE_OPTIONS: "",
  PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0` : "" };
const run = async (command) => JSON.parse((await promisify(execFile)(node, [entry, command], { env, timeout: 30000 })).stdout);
try {
  assert.equal((await run("doctor")).platform.platform, process.platform);
  const first = await run("ensure"), second = await run("ensure");
  assert.equal(first.url, second.url);
  const response = await fetch(first.url, { headers: { cookie: `${first.cookie.name}=${first.cookie.value}` } });
  assert.match(await response.text(), /Inbox/);
  await run("stop");
  for (let i = 0; i < 100; i++) {
    try { await run("status"); } catch { break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log("Packaged runtime: doctor, native SQLite, workspace setup, shared runner, authenticated console and stop passed without system Node/npm.");
} finally {
  try { await run("stop"); } catch { /* already stopped */ }
  rmSync(home, { recursive: true, force: true });
}
