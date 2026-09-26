import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const executable = path.resolve(process.argv[2]);
const home = mkdtempSync(path.join(os.tmpdir(), "crew native ü "));
const env = { ...process.env, CREW_HOME: home, CREWRUN_PUBLIC_BASE_URL: "", DISPLAY: "", WAYLAND_DISPLAY: "", NODE_OPTIONS: "", NODE_PATH: "",
  PATH: process.platform === "win32" ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0` : "" };
const run = async (flag) => JSON.parse((await promisify(execFile)(executable, [flag], { env, timeout: 15000 })).stdout);
const child = spawn(executable, ["--headless"], { env, stdio: ["ignore", "ignore", "pipe"] });
let startupError = "";
child.stderr.on("data", (chunk) => { startupError = (startupError + chunk).slice(-4000); });
const exited = new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
try {
  let status;
  for (let i = 0; i < 100; i++) {
    try { status = await run("--status"); break; } catch {
      if (child.exitCode !== null) throw new Error(`Headless launcher exited (${child.exitCode}): ${startupError}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(status, "headless app becomes ready without display or system Node/npm");
  const { code, url } = await run("--login");
  const response = await fetch(new URL("/_crew/login", url), { method: "POST", body: new URLSearchParams({ code }), redirect: "manual" });
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.match(await (await fetch(url, { headers: { cookie } })).text(), /Dashboard/);
  await run("--stop");
  let timer;
  try {
    assert.equal(await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("native launcher did not stop")), 10000); })]), 0);
  } finally { clearTimeout(timer); }
  console.log("Native executable: display-free start, browser login, shared console and graceful stop passed.");
} finally {
  try { await run("--stop"); } catch { /* already stopped */ }
  if (child.exitCode === null) child.kill();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
