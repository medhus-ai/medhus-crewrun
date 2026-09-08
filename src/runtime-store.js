import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, closeSync, openSync } from "node:fs";
import path from "node:path";
import { crewHome } from "./crew-dirs.js";
import { createBudgetLedger } from "./budget.js";
import { workspaceIdentity, readWorkspace } from "./workspace-manifest.js";
import { loadRoleSpec } from "./role-spec.js";

export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function runtimeStatePath(targetRoot, env = process.env) {
  return path.join(crewHome(env), "runtime", digest(workspaceIdentity(targetRoot)).slice(0, 24), "state.sqlite");
}
const json = JSON.stringify;
const parse = (value, fallback = null) => value ? JSON.parse(value) : fallback;

// SQLite is the source of truth for standalone work. Network calls never run inside
// transactions. Leases fence late workers; an expired send is uncertain, never queued.
export function createRuntimeStore({ targetRoot, env = process.env, now = Date.now, leaseMs = 60_000 } = {}) {
  const file = runtimeStatePath(targetRoot, env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);
  const db = new Database(file);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_runs (
      id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE, agent TEXT NOT NULL, prompt TEXT NOT NULL,
      workflow TEXT NOT NULL, status TEXT NOT NULL, desired TEXT NOT NULL DEFAULT 'active',
      dependencies TEXT NOT NULL DEFAULT '[]', attempt INTEGER NOT NULL DEFAULT 0,
      lease TEXT, lease_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      error TEXT, accepted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS runtime_actions (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runtime_runs(id), dedupe_key TEXT NOT NULL UNIQUE,
      action TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
      lease TEXT, lease_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, approved_at INTEGER, decided_by TEXT, error TEXT, receipt TEXT
    );
    CREATE INDEX IF NOT EXISTS runtime_action_run ON runtime_actions(run_id);
    CREATE INDEX IF NOT EXISTS runtime_action_due ON runtime_actions(status, available_at);
    CREATE TABLE IF NOT EXISTS runtime_events (
      id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runtime_runs(id), action_id TEXT,
      type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_artifacts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runtime_runs(id), name TEXT NOT NULL,
      media_type TEXT NOT NULL, content TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_attempts (
      lease TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runtime_runs(id), started_at INTEGER NOT NULL,
      ended_at INTEGER, result TEXT
    );
    CREATE TABLE IF NOT EXISTS runtime_triggers (key TEXT PRIMARY KEY, fired_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_questions (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runtime_runs(id), question TEXT NOT NULL,
      options TEXT NOT NULL, answer TEXT, created_at INTEGER NOT NULL, answered_at INTEGER
    );
  `);
  db.transaction(() => {
    const columns = new Set(db.prepare("PRAGMA table_info(runtime_runs)").all().map((column) => column.name));
    for (const [name, declaration] of Object.entries({ title: "TEXT NOT NULL DEFAULT ''", priority: "TEXT NOT NULL DEFAULT 'normal'", outcome: "TEXT NOT NULL DEFAULT ''", criteria: "TEXT NOT NULL DEFAULT ''", parent_id: "TEXT", correlation_id: "TEXT", depth: "INTEGER NOT NULL DEFAULT 0", blockers: "TEXT NOT NULL DEFAULT '[]'", progress: "TEXT NOT NULL DEFAULT ''", feedback: "TEXT NOT NULL DEFAULT ''", provenance: "TEXT NOT NULL DEFAULT '{}'" })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE runtime_runs ADD COLUMN ${name} ${declaration}`);
    }
    db.exec("CREATE INDEX IF NOT EXISTS runtime_chain ON runtime_runs(correlation_id)");
    if (!db.prepare("PRAGMA table_info(runtime_actions)").all().some((c) => c.name === "superseded_at")) db.exec("ALTER TABLE runtime_actions ADD COLUMN superseded_at INTEGER");
    if (!db.prepare("PRAGMA table_info(runtime_questions)").all().some((c) => c.name === "consumed")) db.exec("ALTER TABLE runtime_questions ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0");
  }).immediate();
  const ledger = createBudgetLedger({ getDb: () => db, describeSource: () => "Standalone run ledger" });
  ledger.source();
  const tx = (fn) => db.transaction(fn).immediate();
  const event = (runId, type, data = {}, actionId = null) => db.prepare("INSERT INTO runtime_events (run_id, action_id, type, data, created_at) VALUES (?,?,?,?,?)").run(runId, actionId, type, json(data), now());
  const getRun = (id) => db.prepare("SELECT * FROM runtime_runs WHERE id = ?").get(id);
  const getAction = (id) => {
    const row = db.prepare("SELECT * FROM runtime_actions WHERE id = ?").get(id);
    return row ? { ...row, payload: parse(row.payload), receipt: parse(row.receipt) } : null;
  };
  const meta = (key) => parse(db.prepare("SELECT value FROM runtime_meta WHERE key = ?").get(key)?.value);
  const setMeta = (key, value) => db.prepare("INSERT INTO runtime_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, json(value));

  function enqueue({ agent, prompt, workflow = "manual", dedupeKey = null, dependencies = [], title = "", priority = "normal", outcome = "", criteria = "", parentId = null, provenance = {} }) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(agent || "")) throw new Error("Choose a valid agent.");
    if (!String(prompt || "").trim() || prompt.length > 100_000) throw new Error("A task needs a prompt of at most 100000 characters.");
    if (!Array.isArray(dependencies) || dependencies.some((id) => !getRun(id))) throw new Error("Every dependency must be an existing task.");
    return tx(() => {
      const existing = dedupeKey && db.prepare("SELECT * FROM runtime_runs WHERE dedupe_key = ?").get(dedupeKey);
      if (existing) return { ...existing, created: false };
      if (!["low", "normal", "high", "urgent"].includes(priority)) throw new Error("Choose a valid task priority.");
      for (const value of [title, outcome, criteria]) if (typeof value !== "string" || value.length > 10000) throw new Error("Task details must be text of at most 10000 characters.");
      const parent = parentId ? getRun(parentId) : null;
      if (parentId && !parent) throw new Error("Parent task not found.");
      const limits = readWorkspace(targetRoot)?.limits || { depth: 4, chainRuns: 20 };
      const correlation = parent && (parent.correlation_id || parent.id);
      if (parent && (parent.depth + 1 > limits.depth || db.prepare("SELECT COUNT(*) AS n FROM runtime_runs WHERE correlation_id=? OR id=?").get(correlation, correlation).n >= limits.chainRuns)) throw new Error("Automatic task chain limit reached.");
      const id = `run-${randomUUID()}`;
      db.prepare("INSERT INTO runtime_runs (id,dedupe_key,agent,prompt,workflow,status,dependencies,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?,?)").run(id, dedupeKey, agent, prompt, workflow, json(dependencies), now(), now());
      db.prepare("UPDATE runtime_runs SET title=?,priority=?,outcome=?,criteria=?,parent_id=?,correlation_id=?,depth=? WHERE id=?").run(title.slice(0, 160), priority, outcome, criteria, parentId, correlation || id, parent ? parent.depth + 1 : 0, id);
      db.prepare("UPDATE runtime_runs SET provenance=? WHERE id=?").run(json(provenance), id);
      event(id, "run.queued", { workflow, dependencies });
      return { ...getRun(id), created: true };
    });
  }

  function schedule(key, at, makeTask) {
    return tx(() => {
      const last = db.prepare("SELECT fired_at FROM runtime_triggers WHERE key=?").get(key)?.fired_at;
      if (last != null && last >= at) return null;
      const task = enqueue({ ...makeTask, dedupeKey: `trigger:${key}:${at}` });
      db.prepare("INSERT INTO runtime_triggers VALUES (?,?) ON CONFLICT(key) DO UPDATE SET fired_at=excluded.fired_at").run(key, at);
      return task;
    });
  }
  function recover() {
    return tx(() => {
      for (const run of db.prepare("SELECT * FROM runtime_runs WHERE status='running' AND lease_until <= ?").all(now())) {
        const status = run.desired === "active" ? "interrupted" : run.desired;
        db.prepare("UPDATE runtime_runs SET status=?,lease=NULL,lease_until=NULL,error=?,updated_at=? WHERE id=?").run(status, "Worker stopped before recording a result. Review existing artifacts and deliveries before retrying.", now(), run.id);
        db.prepare("UPDATE runtime_attempts SET ended_at=?,result='interrupted' WHERE lease=? AND ended_at IS NULL").run(now(), run.lease);
        event(run.id, "run.recovered", { status, usage: "unknown for interrupted attempt" });
      }
      for (const action of db.prepare("SELECT id,run_id FROM runtime_actions WHERE status='dispatching' AND lease_until <= ?").all(now())) {
        db.prepare("UPDATE runtime_actions SET status='uncertain',lease=NULL,lease_until=NULL,error=?,updated_at=? WHERE id=?").run("Delivery worker stopped. Reconcile with the provider before resending.", now(), action.id);
        event(action.run_id, "action.uncertain", { reason: "expired delivery lease" }, action.id);
      }
      for (const action of db.prepare("SELECT id,run_id FROM runtime_actions WHERE status IN ('awaiting_approval','queued','retry_wait') AND expires_at <= ?").all(now())) {
        db.prepare("UPDATE runtime_actions SET status='failed',error='Approval expired; submit a new request.',updated_at=? WHERE id=?").run(now(), action.id);
        event(action.run_id, "action.expired", {}, action.id);
      }
    });
  }
  function claimRun(id = null) {
    return tx(() => {
      recover();
      const candidates = db.prepare("SELECT * FROM runtime_runs WHERE status='queued' AND desired='active' ORDER BY created_at,id").all();
      const run = candidates.find((r) => (!id || r.id === id) && !parse(r.blockers, []).length && !db.prepare("SELECT id FROM runtime_questions WHERE run_id=? AND answered_at IS NULL").get(r.id) && parse(r.dependencies, []).every((dep) => getRun(dep)?.accepted_at));
      if (!run) return null;
      const limits = readWorkspace(targetRoot)?.limits || { attempts: 5, chainRuns: 20 };
      const budget = loadRoleSpec(targetRoot, run.agent)?.contract?.budget;
      const day = new Date(now()).toISOString().slice(0, 10);
      const dailyCount = db.prepare("SELECT COUNT(*) AS n FROM runtime_attempts a JOIN runtime_runs r ON r.id=a.run_id WHERE r.agent=? AND a.started_at>=?").get(run.agent, Date.parse(day)).n + (meta(`chat-count:${run.agent}:${day}`) || 0);
      const chainAttempts = db.prepare("SELECT COALESCE(SUM(attempt),0) AS n FROM runtime_runs WHERE correlation_id=? OR id=?").get(run.correlation_id || run.id, run.correlation_id || run.id).n;
      const limitReason = run.attempt >= limits.attempts ? "Attempt limit reached." : chainAttempts >= limits.chainRuns ? "Task chain execution limit reached." : budget?.max_runs_per_day != null && dailyCount >= budget.max_runs_per_day ? "Daily agent run limit reached." : "";
      if (limitReason) {
        db.prepare("UPDATE runtime_runs SET status='failed',error=?,updated_at=? WHERE id=?").run(limitReason, now(), run.id);
        event(run.id, "run.limit", { reason: limitReason });
        return null;
      }
      const lease = randomUUID();
      db.prepare("UPDATE runtime_runs SET status='running',attempt=attempt+1,lease=?,lease_until=?,updated_at=? WHERE id=?").run(lease, now() + leaseMs, now(), run.id);
      db.prepare("INSERT INTO runtime_attempts (lease,run_id,started_at) VALUES (?,?,?)").run(lease, run.id, now());
      db.prepare("UPDATE runtime_questions SET consumed=1 WHERE run_id=? AND answered_at IS NOT NULL").run(run.id);
      if (meta(`shell-continuation:${run.id}`)) setMeta(`shell-continuation:${run.id}`, false);
      event(run.id, "run.started", { attempt: run.attempt + 1 });
      return getRun(run.id);
    });
  }
  function renew(kind, id, lease) {
    const table = kind === "run" ? "runtime_runs" : "runtime_actions";
    return db.prepare(`UPDATE ${table} SET lease_until=? WHERE id=? AND lease=? AND lease_until>?`).run(now() + leaseMs, id, lease, now()).changes === 1;
  }
  function assertRunContext(id, lease) {
    const run = getRun(id);
    if (!run || run.status !== "running" || run.desired !== "active" || run.lease !== lease || run.lease_until <= now()) throw new Error("This task is stopped or its worker lease has expired.");
    return run;
  }
  function artifact(runId, { name = "Result", content, mediaType = "text/plain" }) {
    if (typeof content !== "string" || content.length > 2_000_000) throw new Error("Artifact must contain at most 2 MB of text.");
    const id = `artifact-${randomUUID()}`;
    db.prepare("INSERT INTO runtime_artifacts VALUES (?,?,?,?,?,?,?)").run(id, runId, String(name).slice(0, 160), String(mediaType).slice(0, 100), content, digest(content), now());
    event(runId, "artifact.saved", { id, name });
    return id;
  }
  function finishRun(run, result = {}) {
    return tx(() => {
      const current = getRun(run.id);
      if (current?.lease !== run.lease || current.lease_until <= now()) return false;
      const waiting = db.prepare("SELECT id FROM runtime_questions WHERE run_id=? AND answered_at IS NULL").get(run.id) || parse(current.blockers, []).length || parse(current.dependencies, []).some((id) => !getRun(id)?.accepted_at);
      const answeredDuringRun = db.prepare("SELECT id FROM runtime_questions WHERE run_id=? AND answered_at IS NOT NULL AND consumed=0").get(run.id);
      const status = current.desired !== "active" ? current.desired : result.ok === false ? "failed" : waiting ? "waiting" : answeredDuringRun || meta(`shell-continuation:${run.id}`) ? "queued" : "completed";
      if (result.text) artifact(run.id, { name: `Attempt ${current.attempt} result`, content: result.text });
      for (const item of result.artifacts || []) artifact(run.id, item);
      db.prepare("UPDATE runtime_runs SET status=?,lease=NULL,lease_until=NULL,error=?,updated_at=? WHERE id=?").run(status, result.reason || null, now(), run.id);
      db.prepare("UPDATE runtime_attempts SET ended_at=?,result=? WHERE lease=? AND ended_at IS NULL").run(now(), status, run.lease);
      ledger.recordRun({ workflow: run.workflow, repository: path.resolve(targetRoot), runnerId: result.runnerId, engine: result.engineId, provider: result.provider, ref: run.id, actor: run.agent, result: status, durationSeconds: (now() - db.prepare("SELECT started_at FROM runtime_attempts WHERE lease=?").get(run.lease).started_at) / 1000, usage: result.usage });
      event(run.id, "run.finished", { status, usage: result.usage || null });
      if (status === "failed" && run.workflow.startsWith("schedule")) event(run.id, "schedule.failed", { status });
      return true;
    });
  }
  function saveArtifact(runId, lease, input) {
    return tx(() => { assertRunContext(runId, lease); return artifact(runId, input); });
  }
  function controlRun(id, command, { feedback = "" } = {}) {
    return tx(() => {
      const run = getRun(id);
      if (!run) throw new Error("Task not found.");
      if (run.accepted_at) throw new Error("This deliverable has already been accepted.");
      const actions = db.prepare("SELECT status,superseded_at FROM runtime_actions WHERE run_id=?").all(id);
      if (command === "accept") {
        if (run.status !== "completed" || run.desired !== "active" || actions.some((a) => a.status !== "delivered" && !a.superseded_at)) throw new Error("Accept only a completed task whose deliveries have succeeded or were explicitly superseded by a revision.");
        db.prepare("UPDATE runtime_runs SET accepted_at=?,updated_at=? WHERE id=?").run(now(), now(), id);
        for (const parent of db.prepare("SELECT * FROM runtime_runs WHERE status='waiting' AND desired='active'").all()) {
          if (parse(parent.dependencies, []).includes(id) && parse(parent.dependencies, []).every((dep) => getRun(dep)?.accepted_at) && !parse(parent.blockers, []).length && !db.prepare("SELECT id FROM runtime_questions WHERE run_id=? AND answered_at IS NULL").get(parent.id)) db.prepare("UPDATE runtime_runs SET status='queued',updated_at=? WHERE id=?").run(now(), parent.id);
        }
      } else if (command === "request_changes") {
        if (run.status !== "completed" || run.desired !== "active" || !String(feedback).trim()) throw new Error("Request changes on a completed result with feedback.");
        if (actions.some((a) => ["dispatching", "uncertain", "queued", "retry_wait", "awaiting_approval"].includes(a.status))) throw new Error("Resolve pending deliveries before requesting changes.");
        db.prepare("UPDATE runtime_runs SET status='queued',feedback=?,error=NULL,updated_at=? WHERE id=?").run(String(feedback).slice(0, 10000), now(), id);
        db.prepare("UPDATE runtime_actions SET superseded_at=? WHERE run_id=? AND status='rejected' AND superseded_at IS NULL").run(now(), id);
      } else if (command === "pause" || command === "cancel") {
        if (run.desired === "cancelled") throw new Error("This task is cancelled.");
        const desired = command === "pause" ? "paused" : "cancelled";
        db.prepare("UPDATE runtime_runs SET desired=?,status=CASE WHEN status IN ('running','completed') THEN status ELSE ? END,updated_at=? WHERE id=?").run(desired, desired, now(), id);
        if (command === "cancel") db.prepare("UPDATE runtime_actions SET status='cancelled',updated_at=? WHERE run_id=? AND status IN ('queued','retry_wait','awaiting_approval')").run(now(), id);
      } else if (command === "resume" || command === "retry") {
        if (!(command === "resume" ? run.desired === "paused" : ["failed", "interrupted"].includes(run.status))) throw new Error("This task cannot be resumed or retried in its current state.");
        if (run.status === "running") throw new Error("Wait for the running worker to stop before resuming.");
        db.prepare("UPDATE runtime_runs SET desired='active',status=CASE WHEN status='completed' THEN status ELSE 'queued' END,error=NULL,updated_at=? WHERE id=?").run(now(), id);
      } else throw new Error("Unknown task control.");
      event(id, `run.${command}`, { actor: "operator", ...(feedback ? { feedback: String(feedback).slice(0, 10000) } : {}) });
      return getRun(id);
    });
  }
  function queueAction({ runId, action, payload, dedupeKey }) {
    return tx(() => {
      const existing = db.prepare("SELECT id FROM runtime_actions WHERE dedupe_key=?").get(dedupeKey);
      if (existing) return getAction(existing.id);
      const run = getRun(runId);
      if (!run || run.desired !== "active" || run.accepted_at) throw new Error("This task no longer accepts outgoing actions.");
      const id = randomUUID();
      db.prepare("INSERT INTO runtime_actions (id,run_id,dedupe_key,action,payload,status,available_at,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,'awaiting_approval',?,?,?,?)").run(id, runId, dedupeKey, action, json(payload), now(), now(), now(), now() + 86400_000);
      event(runId, "action.awaiting_approval", { action }, id);
      return getAction(id);
    });
  }
  function decideAction(id, command, actor = "operator") {
    return tx(() => {
      recover();
      const action = getAction(id);
      if (!action || action.status !== "awaiting_approval") throw new Error("This request is no longer waiting for approval.");
      if (!["approve", "reject"].includes(command)) throw new Error("Choose approve or reject.");
      const status = command === "approve" ? "queued" : "rejected";
      db.prepare("UPDATE runtime_actions SET status=?,approved_at=?,decided_by=?,updated_at=? WHERE id=?").run(status, command === "approve" ? now() : null, actor, now(), id);
      event(action.run_id, `action.${command}`, { actor }, id);
      event(action.run_id, command === "approve" ? "approval.approved" : "approval.rejected", { actor }, id);
      if (action.action === "shell.native" && command === "approve") {
        const run = getRun(action.run_id);
        if (run.workflow !== "shell-console" && run.desired === "active" && !run.accepted_at) {
          setMeta(`shell-continuation:${run.id}`, true);
          db.prepare("UPDATE runtime_runs SET status=CASE WHEN status IN ('completed','failed','interrupted') THEN 'queued' ELSE status END,updated_at=? WHERE id=?").run(now(), run.id);
        }
      }
      return getAction(id);
    });
  }
  function claimAction(id = null, { nativeShell = false } = {}) {
    return tx(() => {
      recover();
      const action = db.prepare(`SELECT a.* FROM runtime_actions a JOIN runtime_runs r ON r.id=a.run_id
        WHERE a.status IN ('queued','retry_wait') AND a.available_at<=? AND r.desired='active'
        AND (a.action='shell.native')=?
        AND (? IS NULL OR a.id=?) ORDER BY a.created_at,a.id LIMIT 1`).get(now(), nativeShell ? 1 : 0, id, id);
      if (!action) return null;
      const lease = randomUUID();
      db.prepare("UPDATE runtime_actions SET status='dispatching',attempt=attempt+1,lease=?,lease_until=?,updated_at=? WHERE id=?").run(lease, now() + leaseMs, now(), action.id);
      event(action.run_id, "action.dispatching", { attempt: action.attempt + 1 }, action.id);
      return getAction(action.id);
    });
  }
  function finishAction(action, { status, receipt = null, error = null, retryAfterMs = 0 }) {
    if (!["delivered", "uncertain", "retry_wait", "failed", "cancelled"].includes(status)) throw new Error("Invalid delivery result.");
    return tx(() => {
      const current = getAction(action.id);
      if (current?.lease !== action.lease || current.lease_until <= now()) {
        if (current && receipt) event(action.run_id, "action.late_receipt", { receipt, nextAction: "Review this late receipt when reconciling delivery." }, action.id);
        return false;
      }
      if (status === "retry_wait" && current.attempt >= 5) { status = "failed"; error = `Retry limit reached after ${current.attempt} attempts. Review the provider response before requesting a new approval. ${error || ""}`; }
      db.prepare("UPDATE runtime_actions SET status=?,receipt=?,error=?,available_at=?,lease=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(status, receipt ? json(receipt) : null, error, now() + Math.max(1000, retryAfterMs), now(), action.id);
      event(action.run_id, `action.${status}`, { receipt, error }, action.id);
      return true;
    });
  }
  function reconcile(id, { outcome, receipt, evidence, actor = "operator" }) {
    return tx(() => {
      const action = getAction(id);
      if (!action || !["uncertain", "failed"].includes(action.status)) throw new Error("Only unresolved deliveries can be reconciled.");
      if (!["delivered", "not_sent"].includes(outcome) || !String(evidence || "").trim()) throw new Error("Record delivery evidence or evidence that it was not sent.");
      if (outcome === "delivered" && (!receipt || typeof receipt !== "object" || !Object.keys(receipt).length)) throw new Error("A delivered action needs an external receipt.");
      // A verified non-delivery requires a fresh approval, never a silent resend.
      db.prepare("UPDATE runtime_actions SET status=?,receipt=?,approved_at=NULL,expires_at=?,error=NULL,updated_at=? WHERE id=?").run(outcome === "delivered" ? "delivered" : "awaiting_approval", receipt ? json(receipt) : null, now() + 86400_000, now(), id);
      event(action.run_id, "action.reconciled", { outcome, evidence: String(evidence).slice(0, 4000), actor, receipt }, id);
      return getAction(id);
    });
  }
  function snapshot() {
    recover();
    const runs = db.prepare("SELECT * FROM runtime_runs ORDER BY created_at DESC,id DESC").all().map((run) => {
      const actions = db.prepare("SELECT id FROM runtime_actions WHERE run_id=? ORDER BY created_at,id").all(run.id).map(({ id }) => getAction(id));
      const dependencies = parse(run.dependencies, []).map((id) => ({ id, accepted: Boolean(getRun(id)?.accepted_at) }));
      const questions = db.prepare("SELECT * FROM runtime_questions WHERE run_id=? ORDER BY created_at,id").all(run.id).map((q) => ({ ...q, options: parse(q.options, []) }));
      const blockers = parse(run.blockers, []);
      const blocked = dependencies.some((dep) => !dep.accepted) || blockers.length > 0 || questions.some((q) => !q.answered_at);
      let nextAction = run.accepted_at ? "Deliverable accepted." : run.desired === "cancelled" ? "Cancelled. Check any delivery already in flight." : run.desired === "paused" ? "Resume when ready. An in-flight delivery may still finish." : blocked ? "Accept the dependency tasks before this task can start." : run.status === "interrupted" ? "Review saved results and deliveries, then retry this task." : run.status === "failed" ? "Review the error, then retry this task." : run.status === "running" ? "Agent is working." : run.status === "queued" ? "Waiting for an available worker." : "Review the result and accept the deliverable.";
      if (run.desired === "active" && actions.some((a) => a.status === "rejected" && !a.superseded_at)) nextAction = "An outgoing action was rejected. Request changes on the completed result or cancel this task.";
      else if (run.desired === "active" && actions.some((a) => ["failed", "uncertain"].includes(a.status))) nextAction = "Review the unresolved delivery and record reconciliation evidence.";
      else if (run.desired === "active" && actions.some((a) => a.status === "awaiting_approval")) nextAction = "Review the outgoing action in Approvals.";
      else if (run.desired === "active" && actions.some((a) => ["queued", "retry_wait", "dispatching"].includes(a.status))) nextAction = "Delivery is queued or in progress; any retry time is shown below.";
      if (questions.some((q) => !q.answered_at)) nextAction = "Answer the agent's question to continue this task.";
      else if (blockers.length) nextAction = "Resolve the recorded blockers to continue this task.";
      return { ...run, owner: run.agent, questions, blockers, dependencies, blocked, nextAction, actions: actions.map(({ payload, lease, ...action }) => ({ ...action, summary: payload.preview || json(payload.input), agent: payload.role })), artifacts: db.prepare("SELECT * FROM runtime_artifacts WHERE run_id=? ORDER BY created_at,id").all(run.id), timeline: db.prepare("SELECT * FROM runtime_events WHERE run_id=? ORDER BY id").all(run.id).map((e) => ({ ...e, data: parse(e.data) })) };
    });
    const usage = ledger.report();
    const month = new Date(now()).toISOString().slice(0, 7);
    const accepted = runs.filter((r) => r.accepted_at && new Date(r.accepted_at).toISOString().slice(0, 7) === month);
    const monthStart = Date.parse(month + "-01T00:00:00Z");
    const interrupted = db.prepare("SELECT COUNT(*) AS n FROM runtime_attempts WHERE result='interrupted' AND ended_at>=?").get(monthStart).n;
    const unreported = db.prepare("SELECT COUNT(*) AS n FROM budget_runs WHERE month=? AND input_tokens IS NULL AND output_tokens IS NULL AND cost_usd IS NULL").get(month).n;
    return { runs, usage, outcomes: { month, delivered: accepted.length, accepted: accepted.length, humanTouches: db.prepare("SELECT COUNT(*) AS n FROM runtime_events WHERE type IN ('run.accept','action.approve','action.reject','action.reconciled') AND created_at>=?").get(monthStart).n, unknownUsageAttempts: interrupted + unreported } };
  }
  function updateProgress(id, { progress = "", blockers = [] } = {}) {
    if (typeof progress !== "string" || progress.length > 10000 || !Array.isArray(blockers) || blockers.length > 20 || blockers.some((b) => !b || typeof b.reason !== "string" || b.reason.length > 2000)) throw new Error("Provide progress text and up to 20 blockers with a reason.");
    return tx(() => {
      const run = getRun(id);
      if (!run || run.accepted_at || run.desired !== "active") throw new Error("This task cannot be updated.");
      db.prepare("UPDATE runtime_runs SET progress=?,blockers=?,status=CASE WHEN status='waiting' AND ?='[]' THEN 'queued' ELSE status END,updated_at=? WHERE id=?").run(progress, json(blockers.map((b) => ({ reason: b.reason }))), json(blockers), now(), id);
      event(id, "task.progress", { progress, blockers });
      return getRun(id);
    });
  }
  function askQuestion(runId, lease, { question, options = [] }) {
    if (typeof question !== "string" || !question.trim() || question.length > 4000 || !Array.isArray(options) || options.length > 5 || options.some((v) => typeof v !== "string" || !v.trim() || v.length > 500)) throw new Error("Ask a short question with up to five suggested answers.");
    return tx(() => {
      assertRunContext(runId, lease);
      const existing = db.prepare("SELECT id FROM runtime_questions WHERE run_id=? AND answered_at IS NULL").get(runId);
      if (existing) return existing;
      const id = randomUUID();
      db.prepare("INSERT INTO runtime_questions (id,run_id,question,options,created_at) VALUES (?,?,?,?,?)").run(id, runId, question, json(options), now());
      event(runId, "question.asked", { id });
      return { id, status: "waiting", nextAction: "Finish this turn. The owner's answer will resume this task." };
    });
  }
  function answerQuestion(id, answer) {
    if (typeof answer !== "string" || !answer.trim() || answer.length > 10000) throw new Error("Provide an answer of at most 10000 characters.");
    return tx(() => {
      const question = db.prepare("SELECT * FROM runtime_questions WHERE id=?").get(id);
      if (!question) throw new Error("Question not found.");
      if (question.answered_at) {
        if (question.answer !== answer) throw new Error("This question has already been answered.");
        return getRun(question.run_id);
      }
      const run = getRun(question.run_id);
      if (run.desired === "cancelled" || run.accepted_at) throw new Error("This task no longer accepts answers.");
      db.prepare("UPDATE runtime_questions SET answer=?,answered_at=? WHERE id=?").run(answer, now(), id);
      db.prepare("UPDATE runtime_runs SET status=CASE WHEN status='waiting' THEN 'queued' ELSE status END,updated_at=? WHERE id=?").run(now(), run.id);
      event(run.id, "question.answered", { id, actor: "operator" });
      return getRun(run.id);
    });
  }
  function taskContext(id) {
    const run = getRun(id);
    const questions = db.prepare("SELECT question,answer FROM runtime_questions WHERE run_id=? AND answered_at IS NOT NULL ORDER BY created_at").all(id);
    const children = db.prepare("SELECT id,agent,title,status,progress,accepted_at FROM runtime_runs WHERE parent_id=? ORDER BY created_at").all(id);
    const actions = db.prepare("SELECT id,action,status,receipt FROM runtime_actions WHERE run_id=? ORDER BY created_at").all(id);
    const approvedShell = actions.filter((a) => a.action === "shell.native" && a.status === "queued").map((a) => ({ id: a.id, input: getAction(a.id).payload.input }));
    return json({ taskId: id, owner: run.agent, outcome: run.outcome, completionCriteria: run.criteria, progress: run.progress, reviewFeedback: run.feedback, answers: questions, children, actions, approvedShell, deliveryInstruction: "Reuse recorded actions. Do not retry rejected actions or replace uncertain deliveries; ask the owner to reconcile them. approvedShell permits one exact retry through the native tool, never a general permission grant." });
  }
  return { file, db, ledger, tx, meta, setMeta, enqueue, schedule, getRun, getAction, event, recover, claimRun, renew, assertRunContext, saveArtifact, finishRun, controlRun, updateProgress, askQuestion, answerQuestion, taskContext, queueAction, decideAction, claimAction, finishAction, reconcile, snapshot, close: () => db.close() };
}
