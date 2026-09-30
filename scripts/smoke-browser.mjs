// Opt-in real Chromium form test: node scripts/smoke-browser.mjs /path/to/chrome
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appWorkspace, serveApp, runnerRequest } from "../src/app/runtime.js";

if (!process.argv[2]) throw new Error("Provide a Chromium executable");
const home = mkdtempSync(path.join(os.tmpdir(), "crew-browser-"));
const env = { ...process.env, CREW_HOME: path.join(home, "state"), CREWRUN_PUBLIC_BASE_URL: "" };
const app = await serveApp(appWorkspace(undefined, env), { env });
const profile = path.join(home, "browser");
const browser = spawn(process.argv[2], ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let browserErrors = "";
browser.stderr.on("data", (chunk) => { browserErrors = (browserErrors + chunk).slice(-4000); });
const closed = new Promise((resolve) => browser.once("exit", resolve));
let socket;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let port;
  // Cold starts on shared CI runners can take well over ten seconds.
  for (let i = 0; i < 300; i++) {
    try { port = Number(readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); break; } catch { await delay(100); }
  }
  assert.ok(port, `browser did not start with its sandbox enabled within 30 s:\n${browserErrors}`);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  async function call(method, params = {}) {
    const key = ++id;
    const reply = new Promise((resolve) => pending.set(key, resolve));
    socket.send(JSON.stringify({ id: key, method, params }));
    let timer;
    try {
      const message = await Promise.race([reply, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Browser timeout: ${method}`)), 10000); })]);
      if (message.error) throw new Error(message.error.message);
      return message.result;
    } finally { clearTimeout(timer); pending.delete(key); }
  }
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  await call("Page.navigate", { url: app.descriptor.url });
  for (let i = 0; i < 100 && !await evaluate('!!document.querySelector("input[name=code]")'); i++) await delay(50);
  const { code } = await runnerRequest(app.descriptor, "login-code");
  await evaluate(`document.querySelector("input[name=code]").value=${JSON.stringify(code)}; document.querySelector("form").requestSubmit();`);
  let body = "";
  for (let i = 0; i < 100; i++) {
    body = await evaluate("document.body?.innerText || ''");
    if (/Inbox|Open the console directly/.test(body)) break;
    await delay(50);
  }
  assert.match(body, /Inbox/, "real browser form login reaches the authenticated Inbox");
  console.log("Chromium: actual login form submission reached authenticated Inbox.");
} finally {
  socket?.close();
  browser.kill();
  await closed;
  await app.stop();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
