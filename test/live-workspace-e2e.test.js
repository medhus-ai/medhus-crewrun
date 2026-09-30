import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspace } from "../src/workspace-setup.js";
import { createHost } from "../packages/crewrun-reference-host/index.js";
import { saveGlobalRunnerConfig } from "../src/runner-config.js";

for (const [name, flag, runner] of [["Claude", "CREW_LIVE_WORKSPACE", "claude-agent-sonnet-high"], ["Codex", "CREW_LIVE_CODEX_WORKSPACE", "codex-agent-low"]]) {
test(`live governed ${name} workspace writes only through its scoped internal bridge`, { timeout: 120000 }, async (t) => {
  if (process.env.CREW_LIVE_E2E !== "1" || process.env[flag] !== "1") {
    t.skip(`set CREW_LIVE_E2E=1 ${flag}=1 with a signed-in ${name} runtime`);
    return;
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "crew-live-workspace-"));
  const root = path.join(directory, "repo");
  const previousRunnerFile = process.env.CREW_RUNNERS_FILE;
  process.env.CREW_RUNNERS_FILE = path.join(directory, "runners.json");
  t.after(() => {
    if (previousRunnerFile === undefined) delete process.env.CREW_RUNNERS_FILE;
    else process.env.CREW_RUNNERS_FILE = previousRunnerFile;
  });
  saveGlobalRunnerConfig({ runners: [{ id: runner, engine: name === "Codex" ? "codex-agent" : "claude-agent", auth: "subscription", model: name === "Codex" ? "" : "sonnet", reasoning_effort: "low" }] });
  initializeWorkspace(root, { name: "Isolated live test", runner });
  const host = createHost({ targetRoot: root, env: { CREW_HOME: path.join(directory, "private"), HOME: process.env.HOME, PATH: process.env.PATH } });
  try {
    const result = await host.runtime.runTurn("assistant", 'Use workspace.writeDraft to create drafts/assistant/probe.md containing exactly "crew-live-ok". Use only this internal tool, then reply ready.');
    assert.equal(result.ok, true, result.reason);
    assert.equal(readFileSync(path.join(root, "drafts/assistant/probe.md"), "utf8").trim(), "crew-live-ok");
    assert.ok(host.runtime.governance.audit.list().some((entry) => entry.tool_name === "workspace.writeDraft" && entry.outcome === "completed"));
    assert.equal(host.ingress, null);
    if (name === "Codex") {
      const first = await host.runtime.chats.sendChat({ role: "assistant", message: "Remember the test word apricot. Reply with that word only; do not use tools." });
      const session = host.runtime.store.db.prepare("SELECT engine_session_id FROM conversations WHERE id=?").get(first.id)?.engine_session_id;
      assert.ok(session);
      const second = await host.runtime.chats.sendChat({ role: "assistant", message: "What test word did I give you? Reply with that word only." });
      assert.equal(second.id, first.id);
      assert.match(second.messages.at(-1).content, /apricot/i);
      assert.equal(host.runtime.store.db.prepare("SELECT engine_session_id FROM conversations WHERE id=?").get(first.id)?.engine_session_id, session);
    }
  } finally { await host.stop(); rmSync(directory, { recursive: true, force: true }); }
});
}
