import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { initializeWorkspace } from "../src/workspace-setup.js";
import { serveApp, readRunner, runnerRequest, appWorkspace } from "../src/app/runtime.js";
import { acquireRunnerLock } from "../src/app/runner-lock.js";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "crew app ü "));
  const env = { ...process.env, CREW_HOME: path.join(dir, "private"), CREWRUN_PUBLIC_BASE_URL: "" };
  const root = path.join(dir, "workspace spaces"); initializeWorkspace(root);
  t.after(async () => {
    const runner = readRunner(root, env);
    if (runner) {
      try { await runnerRequest(runner, "stop"); } catch { /* process already gone */ }
      for (let i = 0; i < 100 && readRunner(root, env); i++) await new Promise((r) => setTimeout(r, 50));
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, env, root };
}

test("app reuses the console but requires sessions, rejects spoofed requests and consumes login codes once", async (t) => {
  const f = fixture(t), app = await serveApp(f.root, { env: f.env });
  t.after(() => app.stop());
  const d = app.descriptor;
  const page = await fetch(d.url);
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
  assert.match(await page.text(), /Generate a single-use code/);
  assert.equal((await fetch(new URL("/_crew/control/session", d.url), { method: "POST" })).status, 403);
  assert.equal(await new Promise((resolve, reject) => {
    http.get(d.url, { headers: { host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  }), 403);
  const { cookie } = await runnerRequest(d, "session");
  assert.match(await (await fetch(d.url, { headers: { cookie: `${cookie.name}=${cookie.value}` } })).text(), /Dashboard/);
  const { code } = await runnerRequest(d, "login-code");
  const login = () => fetch(new URL("/_crew/login", d.url), { method: "POST", headers: { origin: new URL(d.url).origin, "sec-fetch-site": "same-origin" }, body: new URLSearchParams({ code }), redirect: "manual" });
  assert.equal((await fetch(new URL("/_crew/login", d.url), { method: "POST", headers: { origin: "null" }, body: new URLSearchParams({ code }) })).status, 403);
  assert.equal((await fetch(new URL("/_crew/login", d.url), { method: "POST", headers: { origin: "https://evil.example" }, body: new URLSearchParams({ code }) })).status, 403);
  const accepted = await login();
  assert.equal(accepted.status, 303);
  assert.match(accepted.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal((await login()).status, 403);
  assert.throws(() => acquireRunnerLock(f.root, f.env), /already has a running/);
  await app.stop();
  assert.equal(readRunner(f.root, f.env), null);
  const again = await serveApp(f.root, { env: f.env });
  t.after(() => again.stop());
  assert.match(await (await fetch(again.descriptor.url, { headers: { cookie: `${cookie.name}=${cookie.value}` } })).text(), /Generate a single-use code/);
});

test("two launchers attach to the same detached runner; explicit stop, not client exit, ends it", { timeout: 30000 }, async (t) => {
  const f = fixture(t);
  const entry = fileURLToPath(new URL("../bin/crewrun-app.js", import.meta.url));
  const run = async (command) => JSON.parse((await promisify(execFile)(process.execPath, [entry, command, f.root], { env: f.env, timeout: 20000 })).stdout);
  t.after(async () => { try { await run("stop"); } catch { /* already stopped */ } });
  const [a, b] = await Promise.all([run("ensure"), run("ensure")]);
  assert.equal(a.url, b.url); assert.equal(a.identity, b.identity);
  assert.notEqual(a.cookie.value, b.cookie.value);
  assert.equal((await run("status")).identity, a.identity);
  await run("stop");
  for (let i = 0; i < 100 && readRunner(f.root, f.env); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(readRunner(f.root, f.env), null);
});

test("app only creates an implicit personal workspace; explicit invalid paths never get overwritten", (t) => {
  const f = fixture(t);
  assert.throws(() => appWorkspace(undefined, f.env, { initialize: false }), /requires .crew/);
  assert.equal(existsSync(path.join(f.env.CREW_HOME, "workspaces", "personal")), false);
  const first = appWorkspace(undefined, f.env);
  assert.equal(appWorkspace(undefined, f.env), first);
  const sentinel = path.join(f.dir, "important.txt"); writeFileSync(sentinel, "keep");
  assert.throws(() => appWorkspace(f.dir, f.env), /requires .crew/);
});
