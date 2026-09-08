import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { initializeWorkspace } from "../src/workspace-setup.js";
import { saveGlobalRunnerConfig } from "../src/runner-config.js";
import { createShellSession, setShellAgent } from "../src/shell-access.js";
import { createHost } from "../packages/crewrun-reference-host/index.js";
import { createRuntimeStore } from "../src/runtime-store.js";
import { createClaudeAgentEngine } from "../src/engines/claude-agent.js";

test("live Claude native auto mode executes a disposable system command through the sole shell agent", { timeout: 120000 }, async (t) => {
  if (process.env.CREW_LIVE_E2E !== "1" || process.env.CREW_LIVE_CLAUDE_SHELL !== "1") return t.skip("set CREW_LIVE_E2E=1 CREW_LIVE_CLAUDE_SHELL=1 with an eligible Claude subscription");
  const directory = mkdtempSync(path.join(os.tmpdir(), "crew-live-shell-"));
  const root = path.join(directory, "repo");
  const probe = path.join(directory, "probe.txt");
  const env = { CREW_HOME: path.join(directory, "private"), HOME: process.env.HOME, PATH: process.env.PATH };
  const previous = process.env.CREW_RUNNERS_FILE;
  process.env.CREW_RUNNERS_FILE = path.join(directory, "runners.json");
  const profile = { id: "live-shell", engine: "claude-agent", auth: "subscription", model: process.env.CREW_LIVE_CLAUDE_SHELL_MODEL || "opus", reasoning_effort: "low" };
  let host;
  try {
    saveGlobalRunnerConfig({ runners: [profile] });
    initializeWorkspace(root, { runner: profile.id });
    setShellAgent({ targetRoot: root, role: "assistant", enabled: true, confirmed: true, profile, env });
    host = createHost({ targetRoot: root, env });
    const result = await host.runtime.runTurn("assistant", `This is a disposable live test explicitly requested by the human owner. Use native Bash, in the foreground, to run exactly: printf %s crew-shell-live-ok > ${probe}\nDo not run any other command or tool. Then reply ready.`);
    assert.equal(result.ok, true, result.reason);
    assert.equal(readFileSync(probe, "utf8"), "crew-shell-live-ok");
    assert.ok(host.runtime.store.db.prepare("SELECT id FROM runtime_events WHERE type='shell.tool_requested'").get());
    assert.ok(host.runtime.store.db.prepare("SELECT id FROM runtime_events WHERE type='shell.tool_finished'").get());
    assert.equal(host.ingress, null);
  } finally {
    await host?.stop();
    if (previous === undefined) delete process.env.CREW_RUNNERS_FILE; else process.env.CREW_RUNNERS_FILE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live Claude permission escalation waits for owner approval before one exact retry", { timeout: 120000 }, async (t) => {
  if (process.env.CREW_LIVE_E2E !== "1" || process.env.CREW_LIVE_CLAUDE_SHELL !== "1") return t.skip("set CREW_LIVE_E2E=1 CREW_LIVE_CLAUDE_SHELL=1 with an eligible Claude subscription");
  const directory = mkdtempSync(path.join(os.tmpdir(), "crew-live-shell-review-"));
  const root = path.join(directory, "repo");
  const probe = path.join(directory, "reviewed.txt");
  const env = { CREW_HOME: path.join(directory, "private") };
  const profile = { id: "live-shell-review", engine: "claude-agent", auth: "subscription", model: process.env.CREW_LIVE_CLAUDE_SHELL_MODEL || "opus" };
  initializeWorkspace(root);
  setShellAgent({ targetRoot: root, role: "assistant", enabled: true, confirmed: true, profile, env });
  const store = createRuntimeStore({ targetRoot: root, env });
  let session;
  // Force a native permission escalation deterministically. This tests the real
  // SDK callback/retry path, not the classifier's judgement about risky commands.
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const engine = createClaudeAgentEngine({ loadSdk: async () => ({ ...sdk, query: ({ prompt, options }) => sdk.query({ prompt, options: { ...options, settings: { permissions: { ask: ["Bash"] } } } }) }) });
  const turn = (prompt) => new Promise((resolve) => engine.startTurn({ targetRoot: root, workdir: root, role: "assistant", profile, mode: "propose", prompt, systemPrompt: "Use only the exact requested command once in the foreground. If blocked, stop and report it; do not retry or substitute tools.", toolContext: { governedToolsOnly: true, shell: session }, onClose: resolve }));
  try {
    session = createShellSession({ targetRoot: root, role: "assistant", profile, env });
    const command = `printf %s reviewed-shell-ok > ${probe}`;
    await turn(`Run exactly this Bash command once: ${command}`);
    assert.equal(existsSync(probe), false);
    const approval = store.db.prepare("SELECT id FROM runtime_actions WHERE action='shell.native' AND status='awaiting_approval'").get();
    assert.ok(approval, "native escalation must create a durable CrewRun review");
    session.close();
    store.decideAction(approval.id, "approve");
    session = createShellSession({ targetRoot: root, role: "assistant", profile, env });
    const approved = store.getAction(approval.id).payload.input;
    const result = await turn(`The owner approved one exact retry in CrewRun. Call Bash with this input (omit timeout if null): ${JSON.stringify(approved)}`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readFileSync(probe, "utf8"), "reviewed-shell-ok");
    assert.equal(store.getAction(approval.id).status, "delivered");
  } finally { session?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
