import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, loadReferencePlugins } from "@medhus-ai/crewrun-reference-host";
import { crewHome } from "../crew-dirs.js";
import { createUp } from "../up.js";
import { createConsole } from "../console/server.js";
import { requireWorkspace, workspaceIdentity } from "../workspace-manifest.js";
import { initializeWorkspace } from "../workspace-setup.js";
import { digest } from "../runtime-store.js";
import { acquireRunnerLock, runnerDirectory } from "./runner-lock.js";
import { createConsoleAccess } from "./console-access.js";

const ENTRY = fileURLToPath(new URL("../../bin/crewrun-app.js", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const descriptorFile = (root, env) => path.join(runnerDirectory(root, env), "app-runner.json");

export function appWorkspace(input, env = process.env, { initialize = true } = {}) {
  const root = path.resolve(input || path.join(crewHome(env), "workspaces", "personal"));
  if (initialize && !input && !existsSync(path.join(root, ".crew", "workspace.json"))) initializeWorkspace(root, { kind: "personal", name: "Personal" });
  requireWorkspace(root);
  return realpathSync(root);
}

export function readRunner(root, env = process.env) {
  const file = descriptorFile(root, env);
  if (!existsSync(file)) return null;
  if (lstatSync(file).isSymbolicLink()) throw new Error("Runner descriptor must not be a symlink");
  const value = JSON.parse(readFileSync(file, "utf8"));
  const url = new URL(value.url);
  if (value.protocol !== 1 || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password
    || value.identity !== digest(workspaceIdentity(root)) || value.root !== realpathSync(root) || !/^[a-f0-9]{64}$/.test(value.token)) {
    throw new Error("Invalid runner descriptor or workspace moved while running; stop the original runner first");
  }
  return value;
}

export async function runnerRequest(descriptor, action) {
  const response = await fetch(new URL(`/_crew/control/${action}`, descriptor.url), {
    method: "POST", headers: { authorization: `Bearer ${descriptor.token}` },
    redirect: "error", signal: AbortSignal.timeout(2000)
  });
  if (!response.ok) throw new Error(`Runner rejected ${action} (${response.status})`);
  const value = await response.json();
  if (action === "status" && (value.protocol !== 1 || value.identity !== descriptor.identity)) throw new Error("Runner identity mismatch");
  return value;
}

export async function ensureRunner(root, env = process.env) {
  const previous = readRunner(root, env);
  if (previous) {
    try { await runnerRequest(previous, "status"); return previous; } catch { /* OS lock, not this failed probe, decides whether a new host may start. */ }
  }
  const child = spawn(process.execPath, [ENTRY, "serve", root], { env, detached: true, windowsHide: true, stdio: "ignore" });
  let failure;
  child.on("error", (error) => { failure = error; });
  child.unref();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    const current = readRunner(root, env);
    if (current) {
      try { await runnerRequest(current, "status"); return current; } catch { /* bounded startup wait */ }
    }
    await delay(100);
  }
  throw new Error("Runner did not become ready. Run CrewRun --headless to see the startup error; an existing host may own this workspace.");
}

function protectDirectory(directory) {
  if (process.platform !== "win32") { chmodSync(directory, 0o700); return; }
  // Native Windows tools, fixed code and argument arrays; never interpolate a path into a shell.
  const sid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { encoding: "utf8", windowsHide: true }).trim();
  if (!/^S-1-5-[0-9-]+$/.test(sid)) throw new Error("Cannot establish Windows owner identity");
  execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { windowsHide: true, stdio: "pipe" });
}

export async function serveApp(root, { env = process.env, log = () => {} } = {}) {
  const lock = acquireRunnerLock(root, env);
  let up, consoleApp, stopped;
  const file = descriptorFile(root, env);
  const stop = () => stopped ||= (async () => {
    if (consoleApp) await consoleApp.close();
    if (up) await up.stop();
    rmSync(file, { force: true });
    lock.close();
  })();
  try {
    protectDirectory(lock.directory);
    const manifest = requireWorkspace(root);
    process.env.TZ = manifest.timezone;
    const host = createHost({ targetRoot: root, env, log, plugins: await loadReferencePlugins(env) });
    up = createUp({ targetRoot: root, host, log });
    const identity = digest(workspaceIdentity(root)), token = randomBytes(32).toString("hex");
    consoleApp = createConsole({ targetRoot: root, up, knownEvents: host.knownEvents || [], port: 0, host: "127.0.0.1", env,
      access: createConsoleAccess({ controlToken: token, identity, onStop: () => { void stop(); } }) });
    await up.start();
    const port = await consoleApp.listen();
    const descriptor = { protocol: 1, identity, root: realpathSync(root), pid: process.pid, url: `http://127.0.0.1:${port}/`, token };
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(temp, JSON.stringify(descriptor), { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
    log(`CrewRun is running at ${descriptor.url} (owner sign-in required).`);
    return { descriptor, stop };
  } catch (error) { await stop(); throw error; }
}
