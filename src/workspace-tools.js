import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { digest } from "./runtime-store.js";
import { loadRoleSpec, listRoleSpecs, roleScheduledEntries } from "./role-spec.js";
import { normalizeRoleContract, scopeAllows } from "./role-contract.js";
import { normalizeSchedule } from "./schedules.js";
import { normalizeWorkspace, readWorkspace, resolveWorkspacePath, relativeWorkspacePath, WORKSPACE_FILE } from "./workspace-manifest.js";

export const WORK_TOOLS = Object.freeze({
  "task.list": "List up to ten authorized tasks, with optional status and pagination.",
  "task.create": "Create a bounded task assigned to yourself.",
  "task.get": "Read your task or a directly delegated task, including its saved result.",
  "task.update": "Record progress and structured blockers; this does not accept the result.",
  "task.delegate": "Delegate a linked child task to an authorized peer; no authority is inherited.",
  "task.askOwner": "Ask one blocking question, then finish this turn. The answer resumes this task.",
  "task.saveArtifact": "Save a structured result or text artifact for this task.",
  "workspace.read": "Read an authorized workspace text file.",
  "workspace.search": "Search authorized Markdown files for a literal phrase.",
  "workspace.writeDraft": "Write a text file only in an authorized draft/output folder.",
  "workspace.proposePatch": "Propose reviewed text changes to authorized durable knowledge; never applies them."
});

export function workToolSchema(name, z) {
  const task = { prompt: z.string(), title: z.string().optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), outcome: z.string().optional(), criteria: z.string().optional() };
  const change = z.object({ path: z.string(), content: z.string() });
  return {
    "task.list": { status: z.string().optional(), offset: z.number().int().min(0).optional() },
    "task.create": task,
    "task.get": { id: z.string() },
    "task.update": { id: z.string().optional(), progress: z.string(), blockers: z.array(z.object({ reason: z.string() })).optional() },
    "task.delegate": { ...task, agent: z.string() },
    "task.askOwner": { question: z.string(), options: z.array(z.string()).optional() },
    "task.saveArtifact": { name: z.string(), content: z.string(), mediaType: z.string().optional() },
    "workspace.read": { path: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(60000).optional() },
    "workspace.search": { query: z.string() },
    "workspace.writeDraft": { path: z.string(), content: z.string() },
    "workspace.proposePatch": { title: z.string(), changes: z.array(change) }
  }[name] || {};
}

export const fileScope = (relative) => `workspace:${relative.toLowerCase()}`;
export function scopeMatches(scopes, scope) {
  return scopeAllows(scopes, scope);
}
export function canReadWorkspace(contract, relative) { return scopeMatches(contract?.authority.data.read, fileScope(relative)); }

export function createWorkspaceTools({ targetRoot, store, governance, now = Date.now }) {
  const { db, tx } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_proposals (
    id TEXT PRIMARY KEY, role TEXT NOT NULL, title TEXT NOT NULL, changes TEXT NOT NULL,
    authorization TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
    decided_at INTEGER, error TEXT, run_id TEXT REFERENCES runtime_runs(id)
  )`);
  const read = (relative) => {
    const file = resolveWorkspacePath(targetRoot, relative);
    if (!existsSync(file)) return null;
    if (!statSync(file).isFile() || statSync(file).size > 1000000) throw new Error("Only bounded text files can be replaced. Use paginated reads for large documents.");
    const body = readFileSync(file, "utf8");
    if (body.length > 250000) throw new Error("Workspace text files must be at most 250000 characters.");
    return body;
  };
  function readChunk(relative, { offset = 0, limit = 60000 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 60000) throw new Error("Use a nonnegative byte offset and a limit from 1 to 60000.");
    const file = resolveWorkspacePath(targetRoot, relative);
    const size = statSync(file);
    if (!size.isFile()) throw new Error("Choose a regular text file.");
    const buffer = Buffer.alloc(Math.min(limit, Math.max(0, size.size - offset)));
    const fd = openSync(file, "r");
    try {
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      return { path: relative, content: buffer.subarray(0, bytes).toString("utf8"), offset, nextOffset: offset + bytes < size.size ? offset + bytes : null, totalBytes: size.size };
    } finally { closeSync(fd); }
  }
  const listProposals = () => db.prepare("SELECT * FROM workspace_proposals ORDER BY created_at DESC,id").all().map((p) => ({ ...p, changes: JSON.parse(p.changes) }));
  function authorize(role, toolName, data = {}) {
    const decision = governance.authorizeAction({ role, toolName, impact: toolName.endsWith("read") || toolName.endsWith("search") || ["task.get", "task.list"].includes(toolName) ? "read" : "internal-write", data });
    if (!decision.allowed) throw new Error(decision.reason || "This action is outside your authority.");
    return decision;
  }
  function taskFor(role, id, { update = false } = {}) {
    const run = store.getRun(id);
    const parent = run?.parent_id && store.getRun(run.parent_id);
    const coordinator = scopeMatches(governance.contractFor(role)?.authority.data[update ? "write" : "read"], `task:${run?.agent}`);
    if (!run || run.agent !== role && !coordinator && (update || parent?.agent !== role)) throw new Error("Task is outside your authority.");
    return run;
  }
  function propose({ role, title, changes, runId = null, setup = false }) {
    if (!Array.isArray(changes) || !changes.length || changes.length > 30) throw new Error("Propose between 1 and 30 text file changes.");
    if (!String(title || "").trim()) throw new Error("Give the proposal a title.");
    const seen = new Set();
    const normalized = changes.map((change) => {
      if (seen.has(change.path)) throw new Error("A proposal cannot change the same file twice.");
      seen.add(change.path);
      if (typeof change.content !== "string" || change.content.length > 250000) throw new Error("Propose bounded text content.");
      resolveWorkspacePath(targetRoot, change.path);
      if (setup) {
        validateWorkspaceChange(change.path, change.content);
        if (change.path === WORKSPACE_FILE) {
          const next = normalizeWorkspace(JSON.parse(change.content));
          const current = readWorkspace(targetRoot);
          if (next.shellAgent !== current?.shellAgent || next.shellRevision !== current?.shellRevision) throw new Error("Shell access can only be changed by the owner in agent settings, never through a setup proposal.");
          if (!current || next.id !== current.id) throw new Error("Initialize new workspace identities explicitly with crewrun init.");
          if (next.rules.some((r) => r.enabled && !current.rules.some((old) => old.id === r.id && old.enabled)) || next.integrationRules.some((r) => r.enabled && !current.integrationRules.some((old) => old.connectionId === r.connectionId && old.eventType === r.eventType && old.role === r.role && old.enabled))) throw new Error("New event rules must start disabled; enable them explicitly after reviewing setup.");
        }
        if (/^\.crew\/(?:agents|roles)\/.*\.json$/.test(change.path)) {
          const spec = JSON.parse(change.content);
          const before = read(change.path);
          const previous = before ? JSON.parse(before) : {};
          const existing = new Set(roleScheduledEntries(previous).map((task) => task.id));
          if (roleScheduledEntries(spec).some((task) => !existing.has(task.id) && task.enabled !== false)) throw new Error("New scheduled tasks must start disabled.");
          if (!previous.heartbeat && spec.heartbeat && spec.heartbeat !== "off" && spec.heartbeat.interval !== "off") throw new Error("New heartbeats must start off; enable them explicitly in the agent form.");
        }
      }
      else {
        if (change.path.startsWith(".crew/") || !change.path.endsWith(".md")) throw new Error("Use setup proposals for configuration and skills. Knowledge patches must be Markdown.");
        authorize(role, "workspace.proposePatch", { read: [fileScope(change.path)], write: [fileScope(change.path)] });
      }
      const before = read(change.path);
      return { path: change.path, content: change.content, before, base: digest(before) };
    });
    const contract = setup ? null : governance.contractFor(role);
    const id = randomUUID();
    tx(() => {
      db.prepare("INSERT INTO workspace_proposals (id,role,title,changes,authorization,created_at,run_id) VALUES (?,?,?,?,?,?,?)").run(id, role, String(title).slice(0, 160), JSON.stringify(normalized), contract ? digest(contract) : null, now(), runId);
      if (runId) store.event(runId, "workspace.proposed", { id });
    });
    return { id, status: "pending", nextAction: "The owner must inspect and approve this proposal in Reviews." };
  }
  function decide({ id, action }) {
    if (!["approve", "reject"].includes(action)) throw new Error("Choose approve or reject.");
    // The transaction serializes all CrewRun proposal applications. Persist the approved intent
    // before touching files; each atomic rename can then be recognized after a process crash.
    tx(() => {
      const row = db.prepare("SELECT * FROM workspace_proposals WHERE id=?").get(id);
      if (!row || !["pending", "applying"].includes(row.status)) throw new Error("This proposal is no longer pending.");
      if (row.status === "applying" && action === "reject") throw new Error("Finish recovering the already approved proposal first.");
      preflight(row, action === "approve");
      db.prepare("UPDATE workspace_proposals SET status=?,decided_at=?,error=NULL WHERE id=?").run(action === "approve" ? "applying" : "rejected", now(), id);
    });
    if (action === "approve") apply(id);
    return { id, status: action === "approve" ? "applied" : "rejected" };
  }
  function preflight(row, check) {
    if (!check) return;
    if (row.authorization && row.authorization !== digest(governance.contractFor(row.role))) throw new Error("Agent authority changed; submit a fresh proposal.");
    for (const change of JSON.parse(row.changes)) {
      if (change.path === WORKSPACE_FILE && readWorkspace(targetRoot)?.id !== normalizeWorkspace(JSON.parse(change.content)).id) throw new Error("An active workspace's identity cannot change through a proposal. Initialize a fresh workspace explicitly.");
      if (change.path === WORKSPACE_FILE) {
        const proposed = normalizeWorkspace(JSON.parse(change.content));
        const currentWorkspace = readWorkspace(targetRoot);
        if (currentWorkspace.shellAgent !== proposed.shellAgent || currentWorkspace.shellRevision !== proposed.shellRevision) throw new Error("Shell access cannot change through a proposal.");
      }
      const current = read(change.path);
      if (digest(current) !== change.base && !(row.status === "applying" && current === change.content)) throw new Error(`Stale proposal: ${change.path} changed. Refresh before approval.`);
      if (!row.authorization) validateWorkspaceChange(change.path, change.content);
      else authorize(row.role, "workspace.proposePatch", { read: [fileScope(change.path)], write: [fileScope(change.path)] });
    }
  }
  function apply(id) {
    try {
      tx(() => {
        const row = db.prepare("SELECT * FROM workspace_proposals WHERE id=? AND status='applying'").get(id);
        if (!row) return;
        preflight(row, true);
        for (const change of JSON.parse(row.changes)) {
          if (read(change.path) === change.content) continue;
          writeText(change.path, change.content);
        }
        db.prepare("UPDATE workspace_proposals SET status='applied',error=NULL WHERE id=?").run(id);
        if (row.run_id) store.event(row.run_id, "workspace.applied", { id, actor: "operator" });
      });
    } catch (error) {
      db.prepare("UPDATE workspace_proposals SET error=? WHERE id=?").run(error.message, id);
      throw error;
    }
  }
  function writeText(relative, content) {
    const file = resolveWorkspacePath(targetRoot, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.crew-${randomUUID()}.tmp`;
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    resolveWorkspacePath(targetRoot, relative);
    renameSync(temporary, file);
  }
  async function call({ role, toolName, input = {}, context = {} }) {
    return tx(() => {
      if (context.runId && store.assertRunContext(context.runId, context.runLease).agent !== role) throw new Error("Worker identity does not match the acting agent.");
      authorize(role, toolName);
      const runId = input.id || context.runId;
      let result;
      if (toolName === "task.list") {
        const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? Math.min(input.offset, 10000) : 0;
        const runs = db.prepare("SELECT id,agent,title,status,priority,parent_id FROM runtime_runs WHERE (? IS NULL OR status=?) ORDER BY created_at DESC,id").all(input.status || null, input.status || null).filter((r) => { try { taskFor(role, r.id); return true; } catch { return false; } });
        result = { tasks: runs.slice(offset, offset + 10), nextOffset: offset + 10 < runs.length ? offset + 10 : null };
      } else if (toolName === "task.create" || toolName === "task.delegate") {
        const agent = toolName === "task.create" ? role : input.agent;
        if (!Object.hasOwn(listRoleSpecs(targetRoot), agent)) throw new Error("Choose an existing agent.");
        if (toolName === "task.delegate") {
          taskFor(role, context.runId, { update: true });
          if (agent === role) throw new Error("Delegate to a different agent.");
          if (!governance.authorizeHandoff({ role, peerRole: agent }).allowed || !governance.authorizeHandoff({ role: agent, peerRole: role, direction: "receive" }).allowed) throw new Error("Both agents must authorize this handoff.");
        }
        const { prompt, title, priority, outcome, criteria } = input;
        result = store.enqueue({ prompt, title, priority, outcome, criteria, agent, parentId: context.runId || null, workflow: toolName === "task.delegate" ? "delegation" : "agent-task", dedupeKey: digest([context.runId || context.chatId || role, toolName, input]) });
        if (toolName === "task.delegate") {
          const parent = store.getRun(context.runId);
          const dependencies = [...new Set([...JSON.parse(parent.dependencies), result.id])];
          db.prepare("UPDATE runtime_runs SET dependencies=? WHERE id=?").run(JSON.stringify(dependencies), parent.id);
          store.event(parent.id, "task.delegated", { childId: result.id, recipient: agent });
        }
      } else if (toolName === "task.get") {
        taskFor(role, runId);
        result = { ...JSON.parse(store.taskContext(runId)), status: store.getRun(runId).status, artifacts: db.prepare("SELECT name,content FROM runtime_artifacts WHERE run_id=? ORDER BY created_at DESC LIMIT 10").all(runId) };
      } else if (toolName === "task.update") {
        taskFor(role, runId, { update: true }); result = store.updateProgress(runId, input);
      } else if (toolName === "task.askOwner") {
        taskFor(role, context.runId, { update: true }); result = store.askQuestion(context.runId, context.runLease, input);
      } else if (toolName === "task.saveArtifact") {
        taskFor(role, context.runId, { update: true }); result = { id: store.saveArtifact(context.runId, context.runLease, input) };
      } else if (toolName === "workspace.read") {
        authorize(role, toolName, { read: [fileScope(input.path)] }); result = readChunk(input.path, input);
      } else if (toolName === "workspace.search") {
        if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 200) throw new Error("Search for a short literal phrase.");
        const matches = [];
        let visited = 0;
        let partial = false;
        const visit = (directory = "") => {
          if (visited > 5000 || matches.length >= 50) return;
          for (const entry of readdirSync(directory ? resolveWorkspacePath(targetRoot, directory) : targetRoot, { withFileTypes: true })) {
            if (++visited > 5000 || matches.length >= 50) break;
            if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const relative = directory ? `${directory}/${entry.name}` : entry.name;
            if (entry.isDirectory()) visit(relative);
            else if (entry.isFile() && relative.endsWith(".md") && canReadWorkspace(governance.contractFor(role), relative)) {
              const chunk = readChunk(relative); const body = chunk.content;
              partial ||= chunk.nextOffset != null;
              const index = body.toLowerCase().indexOf(input.query.toLowerCase());
              if (index >= 0) matches.push({ path: relative, excerpt: body.slice(Math.max(0, index - 100), index + 500) });
            }
          }
        };
        visit(); result = { matches, truncated: partial || visited > 5000 || matches.length >= 50 };
      } else if (toolName === "workspace.writeDraft") {
        const manifest = readWorkspace(targetRoot);
        if (!manifest?.policy.drafts.some((folder) => input.path.startsWith(`${folder}/`)) || input.path.startsWith(".crew/")) throw new Error("Direct writes are limited to configured draft/output folders.");
        authorize(role, toolName, { write: [fileScope(input.path)] });
        if (typeof input.content !== "string" || input.content.length > 250000) throw new Error("Write bounded text content.");
        writeText(input.path, input.content); result = { path: input.path, digest: digest(input.content) };
      } else if (toolName === "workspace.proposePatch") result = propose({ role, ...input, runId: context.runId });
      else throw new Error("Unknown workspace tool.");
      const data = input.path ? { [toolName === "workspace.writeDraft" ? "write" : "read"]: [fileScope(input.path)] } : {};
      governance.recordAction({ role, actor: context.actor || role, runner: context.runner, model: context.model, toolName, action: "tool", outcome: "completed", impact: ["task.get", "task.list", "workspace.read", "workspace.search"].includes(toolName) ? "read" : "internal-write", data, input, output: result });
      if (context.runId) store.event(context.runId, "tool.completed", { tool: toolName, role, runner: context.runner || "", model: context.model || "", contract: digest(governance.contractFor(role)), data });
      return result;
    });
  }
  function revise({ id, title, changes }) {
    return tx(() => {
      const row = db.prepare("SELECT * FROM workspace_proposals WHERE id=? AND status='pending'").get(id);
      if (!row) throw new Error("Only pending proposals can be edited.");
      const next = propose({ role: row.role, title, changes, runId: row.run_id, setup: !row.authorization });
      db.prepare("UPDATE workspace_proposals SET status='superseded',decided_at=? WHERE id=?").run(now(), id);
      return next;
    });
  }
  function saveManifest(edit) {
    return tx(() => {
      const current = readWorkspace(targetRoot);
      if (!current) throw new Error("This operation requires an initialized workspace.");
      const next = normalizeWorkspace(edit(current));
      if (next.id !== current.id) throw new Error("Workspace identity cannot change while running.");
      writeText(WORKSPACE_FILE, JSON.stringify(next, null, 2) + "\n");
      return next;
    });
  }
  return { call, propose, decide, revise, saveManifest, listProposals, recover: () => { for (const row of db.prepare("SELECT id FROM workspace_proposals WHERE status='applying'").all()) { try { apply(row.id); } catch { /* visible review error; do not overwrite a conflict */ } } } };
}

// Shared by setup proposals and ordinary forms. Configuration is data, never executable code.
export function validateWorkspaceChange(relative, content) {
  if (relative === WORKSPACE_FILE) { normalizeWorkspace(JSON.parse(content)); return; }
  if (/^\.crew\/(?:agents|roles)\/(?:_defaults|[a-z][a-z0-9-]{0,79})\.json$/.test(relative)) {
    const spec = JSON.parse(content);
    if (!spec || Array.isArray(spec) || typeof spec !== "object") throw new Error("Agent spec must be an object.");
    if (Object.hasOwn(spec, "allowShell") || Object.hasOwn(spec, "allow_shell") || Object.hasOwn(spec, "alloshell")) throw new Error("Use the owner's Allow shell control; shell access is never inherited or granted by agent JSON.");
    if (spec.contract) normalizeRoleContract(spec.contract);
    if (spec.memory_pointers && (!Array.isArray(spec.memory_pointers) || spec.memory_pointers.some((p) => typeof p !== "string"))) throw new Error("Memory pointers must be paths.");
    for (const pointer of spec.memory_pointers || []) relativeWorkspacePath(pointer);
    for (const task of roleScheduledEntries(spec)) normalizeSchedule({ ...task, role: path.basename(relative, ".json") });
    return;
  }
  if (/^\.crew\/skills\/[a-z][a-z0-9-]{0,79}\.md$/.test(relative)) return;
  if (!relative.startsWith(".") && relative.endsWith(".md")) return;
  throw new Error("Setup can propose agent JSON, skill Markdown, workspace metadata, and knowledge Markdown only.");
}
