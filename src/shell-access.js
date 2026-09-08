import { randomUUID } from "node:crypto";
import path from "node:path";
import { createRuntimeStore, digest } from "./runtime-store.js";
import { loadRoleSpec } from "./role-spec.js";
import { readWorkspace, resolveWorkspacePath, WORKSPACE_FILE } from "./workspace-manifest.js";
import { writeJsonAtomic } from "./preference-memory.js";

const ACTION = "shell.native";
const LOCK = "native-shell-session";

export function assertShellRunner(profile) {
  if (profile?.engine !== "claude-agent" || profile.base_url) throw new Error("Allow shell currently requires a direct Claude runner with native auto mode. Codex needs an interactive App Server approval adapter; routed providers and generic CLI runners are unsupported.");
  if (profile.engine === "claude-agent" && /haiku/i.test(profile.model || "")) throw new Error("Choose a Claude model and account that support native auto mode.");
}

// One scalar, not a boolean copied into N agent files. SQLite serializes competing
// console requests with shell turns; the atomic manifest write is the commit point.
export function setShellAgent({ targetRoot, role, enabled, confirmed = false, profile, env = process.env }) {
  const store = createRuntimeStore({ targetRoot, env });
  try {
    return store.tx(() => {
      const workspace = readWorkspace(targetRoot);
      if (!workspace || role === "crew-helper" || !loadRoleSpec(targetRoot, role)?.hasSpecFile) throw new Error("Shell access requires an ordinary workspace agent.");
      if (enabled) {
        if (!confirmed) throw new Error("Confirm that this agent can act with the service user's system permissions.");
        if (workspace.shellAgent && workspace.shellAgent !== role) throw new Error(`Shell access belongs to ${workspace.shellAgent}. Disable it there first.`);
        if (!loadRoleSpec(targetRoot, role)?.contract) throw new Error("A shell agent still requires an authority contract.");
        assertShellRunner(profile);
        const active = store.meta(LOCK);
        if (active && active.until > Date.now()) throw new Error("Wait for the active shell turn to stop before enabling shell access.");
      } else if (workspace.shellAgent !== role) throw new Error("This agent does not own shell access.");
      if (workspace.shellRevision === Number.MAX_SAFE_INTEGER) throw new Error("Shell revision is exhausted; inspect the workspace manifest before changing access.");
      workspace.shellAgent = enabled ? role : null;
      workspace.shellRevision++;
      writeJsonAtomic(resolveWorkspacePath(targetRoot, WORKSPACE_FILE), workspace);
      return workspace;
    });
  } finally { store.close(); }
}

// This is a privileged native-runtime exception, not an OS isolation boundary.
// Ordinary agents never get this object. Existing outbox rows hold exact flagged
// actions; provider workers cannot claim them. Uncertain executions never retry.
export function createShellSession({ targetRoot, role, profile, context = {}, env = process.env, onRevoke = () => {} }) {
  assertShellRunner(profile);
  const store = createRuntimeStore({ targetRoot, env });
  const id = randomUUID();
  const fingerprint = () => digest({ workspace: readWorkspace(targetRoot), role, spec: loadRoleSpec(targetRoot, role), profile });
  const revision = fingerprint();
  let closed = false;
  let runId = context.runId;
  let ownedRun = false;
  const claimed = new Map();
  const identity = { role, engine: profile.engine, runner: profile.id, model: profile.model, revision };
  function check(turn = {}) {
    if (turn.role && turn.role !== role || turn.targetRoot && path.resolve(turn.targetRoot) !== path.resolve(targetRoot)) throw new Error("Shell session belongs to a different agent or workspace.");
    if (closed || readWorkspace(targetRoot)?.shellAgent !== role || fingerprint() !== revision) throw new Error("Shell access or agent authority changed. Start a new turn after owner review.");
    const lock = store.meta(LOCK);
    if (lock?.id !== id || lock.until <= Date.now()) throw new Error("The shell execution lease has expired.");
    if (context.runId && store.assertRunContext(context.runId, context.runLease).agent !== role) throw new Error("Shell work must be assigned to the selected agent through a handoff.");
  }
  try {
    store.tx(() => {
      if (!loadRoleSpec(targetRoot, role)?.contract) throw new Error("A shell agent still requires an authority contract.");
      if (role === "crew-helper" || readWorkspace(targetRoot)?.shellAgent !== role) throw new Error("Only the owner's selected shell agent may execute native commands.");
      const lock = store.meta(LOCK);
      if (lock && lock.until > Date.now()) throw new Error("A shell turn is already active. Wait for it to finish.");
      if (runId) {
        if (store.assertRunContext(runId, context.runLease).agent !== role) throw new Error("Shell work must be assigned to the selected agent through a handoff.");
      }
      else {
        runId = store.enqueue({ agent: role, prompt: "Native shell actions from the agent chat. Review exact flagged commands, then retry from the same chat.", title: "Shell session", workflow: "shell-console" }).id;
        store.db.prepare("UPDATE runtime_runs SET status='completed' WHERE id=?").run(runId);
        ownedRun = true;
      }
      store.setMeta(LOCK, { id, role, until: Date.now() + 60_000 });
      store.event(runId, "shell.started", identity);
    });
  } catch (error) { store.close(); throw error; }
  const timer = setInterval(() => {
    try {
      store.tx(() => { check(); store.setMeta(LOCK, { id, role, until: Date.now() + 60_000 }); });
      for (const action of claimed.values()) store.renew("action", action.id, action.lease);
    } catch { onRevoke(); }
  }, 1000);
  timer.unref();
  const keyFor = (tool, input) => `shell:${digest({ revision, role, tool, input, cwd: path.resolve(targetRoot), task: context.runId || null, chat: context.chatId || null })}`;
  function find(tool, input) {
    const row = store.db.prepare("SELECT id FROM runtime_actions WHERE dedupe_key=?").get(keyFor(tool, input));
    return row ? store.getAction(row.id) : null;
  }
  return {
    check,
    runId,
    approved(callId, tool, input) {
      check();
      const action = claimed.get(callId);
      return Boolean(action && action.payload.tool === tool && digest(action.payload.input) === digest(input));
    },
    record(type, data = {}) { check(); store.event(runId, `shell.${type}`, { ...identity, ...data }); },
    request(tool, input, reason = "Native runtime requested owner review.") {
      check();
      if (JSON.stringify(input).length > 60_000) throw new Error("Shell review input is too large; split the operation.");
      return store.queueAction({ runId, action: ACTION, dedupeKey: keyFor(tool, input), payload: {
        ...identity, input, tool, cwd: path.resolve(targetRoot),
        preview: `${tool}\n${JSON.stringify(input, null, 2)}\n\n${String(reason).slice(0, 4000)}\n\nApprove only this action. Task work queues one continuation; chat work requires a retry from the same agent chat. Native safety rules still apply.`
      } });
    },
    before(tool, input, callId) {
      return store.tx(() => {
        check();
        if (claimed.has(callId)) return "deny";
        const previous = find(tool, input);
        if (!previous) return "auto";
        if (previous.status !== "queued") return "deny";
        const action = store.claimAction(previous.id, { nativeShell: true });
        if (!action) return "deny";
        claimed.set(callId, action);
        return "approved";
      });
    },
    finish(callId, { ok = true } = {}) {
      check();
      const action = claimed.get(callId);
      if (action) { store.finishAction(action, { status: ok ? "delivered" : "uncertain", receipt: { native: true, callId } }); claimed.delete(callId); }
      store.event(runId, "shell.tool_finished", { ...identity, callId, ok });
    },
    close() {
      if (closed) return;
      clearInterval(timer);
      for (const action of claimed.values()) store.finishAction(action, { status: "uncertain", error: "Native turn ended without a confirmed tool result. Reconcile manually; do not retry automatically." });
      store.tx(() => {
        if (store.meta(LOCK)?.id === id) store.setMeta(LOCK, null);
        store.event(runId, "shell.finished", { ...identity, chat: ownedRun });
      });
      closed = true;
      store.close();
    }
  };
}
