import { createRuntimeStore, digest as hash } from "./runtime-store.js";
import { deliveryReport } from "./budget.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crewHome } from "./crew-dirs.js";
import { createConnectorRegistry } from "./connectors.js";
import { getActionApproval } from "./action-approvals.js";
import { createRoleGovernance } from "./role-contract.js";
import { listRoleSpecs, loadRoleSpec } from "./role-spec.js";
import { createMcpBridge } from "./mcp.js";
import { createAgentRunner } from "./runner.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.";
const PROVIDERS = ["slack", "gmail"];
class QueuedAction extends Error {
  constructor(action) { super("Saved for review"); this.action = action; }
}
class ServiceError extends Error {
  constructor(message, status, retryAfterMs = 0) { super(message); this.deliveryStatus = status; this.retryAfterMs = retryAfterMs; }
}

export function standaloneStatePath(targetRoot, env = process.env) {
  return path.join(crewHome(env), "connections", `${hash(path.resolve(targetRoot)).slice(0, 24)}.json`);
}

export function createStandaloneRuntime({ targetRoot, env = process.env, fetchImpl = globalThis.fetch, log = () => {}, now = Date.now, executeTurn, leaseMs = 60_000 } = {}) {
  if (!targetRoot) throw new Error("standalone runtime requires targetRoot");
  const root = path.resolve(targetRoot);
  const store = createRuntimeStore({ targetRoot: root, env, now, leaseMs });
  const dispatches = new WeakMap();
  const controllers = new Map();
  const executions = new Set();
  const deliveries = new Set();
  let stopping = false;
  let runner, timer, activeWork;
  const readState = () => ({ connections: Object.fromEntries(PROVIDERS.map((id) => [id, store.meta(`connection:${id}`)]).filter(([, value]) => value)) });
  // Credentials are updated per connection, preventing concurrent account edits from
  // overwriting each other. Payloads and receipts stay in the same private database.
  store.tx(() => {
    if (store.meta("legacy-imported")) return;
    let legacy = {};
    try { legacy = JSON.parse(readFileSync(standaloneStatePath(root, env), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const [id, connection] of Object.entries(legacy.connections || {})) store.setMeta(`connection:${id}`, connection);
    for (const [id, pending] of Object.entries(legacy.pending || {})) {
      const run = store.enqueue({ agent: pending.role, prompt: `Imported ${pending.action}`, workflow: "connector", dedupeKey: `legacy:${id}` });
      store.db.prepare("UPDATE runtime_runs SET status='completed' WHERE id=?").run(run.id);
      const approval = getActionApproval({ targetRoot: root, env, approvalId: id });
      const action = store.queueAction({ runId: run.id, action: pending.action, payload: { ...pending, authorization: approval?.authorization, legacy: true }, dedupeKey: `legacy:${id}` });
      store.db.prepare("UPDATE runtime_actions SET status='uncertain',error=? WHERE id=?").run("Imported request: confirm delivery state before submitting a replacement.", action.id);
      store.event(run.id, "action.imported", { legacyId: id }, action.id);
    }
    store.setMeta("legacy-approval-ids", Object.keys(legacy.pending || {}));
    store.setMeta("legacy-imported", true);
  });
  async function request(url, token, body, externalWrite = false) {
    let response;
    const form = url === "https://oauth2.googleapis.com/token";
    try {
      response = await fetchImpl(url, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" } : {}) },
        ...(body ? { body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) } : {})
      });
    } catch { throw new ServiceError("The service could not be reached.", externalWrite ? "uncertain" : "retry_wait"); }
    const retryHeader = response.headers?.get("retry-after") || "";
    const retryDelay = retryHeader.trim() && Number.isFinite(Number(retryHeader)) ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - now();
    const retryAfterMs = Number.isFinite(retryDelay) ? Math.max(1000, retryDelay) : 60_000;
    if (response.status === 429) throw new ServiceError("Service rate limit reached. Retry is scheduled.", "retry_wait", retryAfterMs);
    if (!response.ok) {
      if (response.status === 403 && url.startsWith("https://gmail.googleapis.com/")) {
        const rejected = await response.json().catch(() => ({}));
        if (rejected?.error?.errors?.some((e) => ["rateLimitExceeded", "userRateLimitExceeded"].includes(e.reason))) throw new ServiceError("Gmail rate limit reached. Retry is scheduled.", "retry_wait", retryAfterMs);
      }
      throw new ServiceError(`Service request failed (HTTP ${response.status}).${response.status === 401 ? " Reconnect in Integrations." : ""}`, response.status >= 500 || [408, 409].includes(response.status) ? externalWrite ? "uncertain" : "retry_wait" : "failed");
    }
    let result;
    try { result = await response.json(); }
    catch { throw new ServiceError("Service response was unreadable.", externalWrite ? "uncertain" : "retry_wait"); }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new ServiceError("Service response was incomplete.", externalWrite ? "uncertain" : "retry_wait");
    if (result.ok === false || result.error) {
      const code = typeof result.error === "string" ? result.error : "service_error";
      throw new ServiceError(`The service rejected the request (${code}). Check account permissions.`, code === "ratelimited" ? "retry_wait" : ["internal_error", "fatal_error", "request_timeout", "duplicate_message"].includes(code) ? "uncertain" : "failed", retryAfterMs);
    }
    return { result, scopes: response.headers?.get("x-oauth-scopes") || "" };
  }

  async function tokenFor(connection) {
    if (connection.provider !== "gmail" || !connection.refreshToken) return connection.accessToken;
    const { result } = await request("https://oauth2.googleapis.com/token", "", {
      grant_type: "refresh_token", client_id: connection.clientId,
      client_secret: connection.clientSecret, refresh_token: connection.refreshToken
    });
    if (!result.access_token) throw new Error("Gmail did not return an access token. Reconnect in Integrations.");
    if (result.scope) connection.scopes = String(result.scope).split(" ").filter(Boolean);
    return result.access_token;
  }

  async function draftSnapshot(connection, draftId) {
    const { result } = await request(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?format=raw`, await tokenFor(connection));
    if (!result.message?.raw) throw new Error("Gmail draft is empty or unavailable.");
    return { raw: result.message.raw, digest: hash(result.message.raw) };
  }

  const authorization = (decision) => ({ decision: decision?.decision, contract_version: decision?.contract_version, contract_revision: decision?.contract_revision, contract_fingerprint: decision?.contract_fingerprint });
  const governance = createRoleGovernance({
    targetRoot: root, env, getContract: (agent) => loadRoleSpec(root, agent)?.contract,
    requestApproval: async (req) => {
      const connection = readState().connections[req.connectionId];
      if (!connection) throw new Error("This account is disconnected.");
      const dispatched = dispatches.get(req.context);
      if (dispatched) {
        const current = store.getAction(dispatched.id);
        if (current?.status !== "dispatching" || current.lease !== dispatched.lease || current.lease_until <= now() || store.getRun(current.run_id)?.desired !== "active") throw new Error("Delivery was stopped or its lease expired.");
        if (connection.revision !== dispatched.payload.connectionRevision) throw new Error("The account changed. Submit a new request.");
        if (hash(authorization(req.decision)) !== hash(dispatched.payload.authorization)) throw new Error("Agent authority changed after review. Submit a new request.");
        if (dispatched.payload.draftDigest && (await draftSnapshot(connection, req.input.draftId)).digest !== dispatched.payload.draftDigest) throw new Error("The draft changed after review. Submit a new request.");
        return { id: dispatched.id, status: "approved", approved_by: dispatched.decided_by, authorization: dispatched.payload.authorization };
      }
      if (req.context?.runId) store.assertRunContext(req.context.runId, req.context.runLease);
      const draft = req.action === "gmail.sendDraft" ? await draftSnapshot(connection, req.input.draftId) : null;
      const payload = { role: req.role, connectionId: req.connectionId, input: req.input, connectionRevision: connection.revision, authorization: authorization(req.decision), ...(draft ? { draftDigest: draft.digest, raw: draft.raw, preview: Buffer.from(draft.raw, "base64url").toString("utf8") } : {}) };
      const action = store.tx(() => {
        if (req.context?.runId) store.assertRunContext(req.context.runId, req.context.runLease);
        const run = req.context?.runId ? store.getRun(req.context.runId) : store.enqueue({ agent: req.role, prompt: `Review ${req.action}`, workflow: "connector" });
        if (!req.context?.runId) store.db.prepare("UPDATE runtime_runs SET status='completed' WHERE id=?").run(run.id);
        return store.queueAction({ runId: run.id, action: req.action, payload, dedupeKey: hash([run.id, req.action, payload]) });
      });
      throw new QueuedAction(action);
    }
  });

  function registry() {
    const state = readState();
    const specs = listRoleSpecs(root);
    return createConnectorRegistry({
      connections: Object.values(state.connections).map((connection) => ({ id: connection.provider, provider: connection.provider, status: "connected", scopes: connection.scopes })),
      roleActions: Object.fromEntries(Object.entries(specs).map(([agent, spec]) => [agent, (spec.contract?.authority?.tools || []).map((tool) => tool.name)])),
      roleConnections: Object.fromEntries(Object.keys(specs).map((agent) => [agent, PROVIDERS])),
      gmailRead: state.connections.gmail?.gmailRead === true,
      governance,
      invoke: async ({ role, action, connectionId, input, context, data, approvalRecord }) => {
        const connection = readState().connections[connectionId];
        if (!connection) throw new Error("This account is disconnected.");
        const token = await tokenFor(connection);
        const dispatched = dispatches.get(context);
        if (action.startsWith("slack.") || action === "gmail.sendDraft") {
          if (!dispatched) throw new Error("External actions require a durable delivery claim.");
          const latest = store.getAction(dispatched.id);
          if (latest.lease !== dispatched.lease || latest.lease_until <= now() || store.getRun(latest.run_id).desired !== "active") throw new Error("Delivery stopped before sending.");
          if (readState().connections[connectionId]?.revision !== connection.revision) throw new Error("Connection changed before sending.");
          const decision = governance.authorizeAction({ role, toolName: action, input, data, impact: "external-write", approval: approvalRecord });
          if (!decision.allowed) throw new Error("Agent authority changed before sending.");
        }
        if (action === "slack.postMessage" || action === "slack.replyToMention") {
          const { result } = await request("https://slack.com/api/chat.postMessage", token, { channel: input.channel, text: input.text, client_msg_id: dispatched.id, mrkdwn: false, unfurl_links: false, unfurl_media: false, ...(input.threadTs ? { thread_ts: input.threadTs } : {}) }, true);
          if (!result.channel || !result.ts) throw new ServiceError("Slack returned no delivery receipt.", "uncertain");
          return { ok: true, channel: result.channel, ts: result.ts, client_msg_id: dispatched.id };
        }
        if (action === "gmail.sendDraft") {
          const raw = dispatched.payload.raw;
          if (!raw) throw new Error("The reviewed Gmail draft is unavailable. Submit it again for approval.");
          const { result } = await request("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", token, { id: input.draftId, message: { raw } }, true);
          if (!result.id) throw new ServiceError("Gmail returned no delivery receipt.", "uncertain");
          return { ok: true, id: result.id, threadId: result.threadId };
        }
        if (action === "gmail.searchMetadata") {
          const params = new URLSearchParams({ q: input.query, maxResults: String(input.maxResults) });
          const { result } = await request(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, token);
          return { messages: (result.messages || []).map(({ id, threadId }) => ({ id, threadId })) };
        }
        if (action === "gmail.getMessage") {
          const { result } = await request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(input.messageId)}?format=full`, token);
          return { id: result.id, threadId: result.threadId, snippet: result.snippet, payload: result.payload };
        }
        throw new Error("Unsupported connector action");
      }
    });
  }

  const tools = createMcpBridge({
    serverName: "crewrun", label: "Crewrun tools", governance,
    stdioServerEntry: fileURLToPath(new URL("./standalone-stdio.js", import.meta.url)),
    serializeContext: (context) => ({ targetRoot: root, roleOptions: context.roleOptions || {}, crewHome: crewHome(env), runId: context.runId, runLease: context.runLease }),
    assertContext: (context) => { if (context?.runId) store.assertRunContext(context.runId, context.runLease); },
    toolsForRole: (agent, ...args) => [...registry().toolsForRole(agent, ...args), ...(loadRoleSpec(root, agent)?.contract?.authority?.tools?.some((t) => t.name === "task.saveArtifact") ? ["task.saveArtifact"] : [])],
    describe: (name) => name === "task.saveArtifact" ? "Persist a useful task result now so it survives a worker restart. Supply a name and text content." : registry().describe(name),
    inputSchema: (name, z) => name === "task.saveArtifact" ? { name: z.string(), content: z.string() } : registry().inputSchema(name, z),
    validate: (name, input) => name === "task.saveArtifact" ? { ok: true, input } : registry().validate(name, input),
    actionPolicy: (name, context) => name === "task.saveArtifact" ? { impact: "internal-write" } : registry().actionPolicy(name, context),
    call: async (req) => {
      if (req.context?.runId) store.assertRunContext(req.context.runId, req.context.runLease);
      if (req.toolName === "task.saveArtifact") {
        const decision = governance.authorizeAction({ role: req.role, toolName: req.toolName, impact: "internal-write", input: req.input });
        if (!decision.allowed) throw new Error("This agent cannot save task artifacts.");
        return { artifactId: store.saveArtifact(req.context?.runId, req.context?.runLease, req.input) };
      }
      try { return await registry().call(req); }
      catch (error) {
        if (!(error instanceof QueuedAction)) throw error;
        const a = error.action;
        return { actionId: a.id, runId: a.run_id, status: a.status, receipt: a.receipt, nextAction: a.status === "awaiting_approval" ? "Operator review is required in Approvals. This action has not been sent." : "Check this action in Tasks before submitting another request." };
      }
    }
  });

  const operations = {
    async getSnapshot() {
      const state = readState();
      const snapshot = store.snapshot();
      return {
        connectors: PROVIDERS.map((provider) => ({
          id: provider, provider, label: provider === "gmail" ? "Gmail" : "Slack", localSetup: true,
          description: provider === "slack" ? "Prepare channel updates and thread replies for your review." : "Review and send existing drafts, with optional inbox access.",
          status: state.connections[provider] ? "connected" : "not connected",
          accountLabel: state.connections[provider]?.account || "",
          capabilities: provider === "slack" ? ["Post message", "Reply in a thread"] : ["Send existing draft", ...(state.connections.gmail?.gmailRead ? ["Search and read email"] : [])]
        })),
        ...snapshot, supersededApprovalIds: store.meta("legacy-approval-ids") || [], delivery: deliveryReport(snapshot.usage.current, snapshot.outcomes),
        approvals: snapshot.runs.flatMap((run) => run.actions.filter((a) => a.status === "awaiting_approval").map((a) => ({ id: a.id, source: "runtime", status: "pending", role: run.agent, action: a.action, summary: `${a.action}\n${a.summary}`, createdAt: new Date(a.created_at).toISOString(), runId: run.id }))),
        audit: governance.audit.list()
      };
    },
    async connect({ connectorId, credentials = {} }) {
      if (!PROVIDERS.includes(connectorId)) throw new Error("Choose Slack or Gmail.");
      const clean = (key) => String(credentials[key] || "").trim();
      const connection = { provider: connectorId, accessToken: clean("access_token"), clientId: clean("client_id"), clientSecret: clean("client_secret"), refreshToken: clean("refresh_token"), gmailRead: credentials.gmail_read === "1", revision: hash([Date.now(), Math.random()]) };
      if (connectorId === "slack") {
        if (!/^xox[bp]-[^\s]{10,}$/.test(connection.accessToken)) throw new Error("Enter a Slack bot or user OAuth token.");
        const checked = await request("https://slack.com/api/auth.test", connection.accessToken, {});
        connection.scopes = checked.scopes.split(",").map((scope) => scope.trim()).filter(Boolean);
        if (!connection.scopes.includes("chat:write")) throw new Error("This Slack app needs chat:write. Add the scope and reinstall the app.");
        connection.account = checked.result.team || checked.result.user || "Slack workspace";
      } else {
        if (!connection.clientId || !connection.clientSecret || !connection.refreshToken) throw new Error("Enter your Google OAuth client ID, client secret, and refresh token for unattended access.");
        await tokenFor(connection);
        connection.scopes ||= [];
        if (!connection.scopes.some((scope) => [GMAIL_SCOPE + "compose", GMAIL_SCOPE + "modify", "https://mail.google.com/"].includes(scope))) throw new Error("Gmail needs gmail.compose permission to review and send existing drafts.");
        if (connection.gmailRead && !connection.scopes.some((scope) => [GMAIL_SCOPE + "readonly", GMAIL_SCOPE + "modify", "https://mail.google.com/"].includes(scope))) throw new Error("Gmail reads need gmail.readonly permission.");
        connection.account = "Google account";
        delete connection.accessToken;
      }
      store.setMeta(`connection:${connectorId}`, connection);
      return "/connectors";
    },
    disconnect({ connectorId }) {
      if (!PROVIDERS.includes(connectorId)) throw new Error("Unknown connection");
      store.setMeta(`connection:${connectorId}`, null);
      return "/connectors";
    },
    async decideApproval({ id, action }) { store.decideAction(id, action); return "/approvals"; },
    async afterApproval({ id, action }) { if (store.getAction(id)?.status === "awaiting_approval") store.decideAction(id, action); return deliver(id); },
    enqueueTask({ agent, prompt, dependencies = [] }) {
      if (!loadRoleSpec(root, agent)) throw new Error("Agent not found.");
      const run = store.enqueue({ agent, prompt, dependencies });
      return { ...run, redirect: `/tasks?run=${run.id}` };
    },
    controlTask({ id, action }) { store.controlRun(id, action); if (["pause", "cancel"].includes(action)) controllers.get(id)?.abort(); return `/tasks?run=${id}`; },
    reconcileAction({ id, outcome, evidence, receipt }) { const action = store.reconcile(id, { outcome, evidence, receipt }); return `/tasks?run=${action.run_id}`; },
    async checkDelivery({ id }) {
      const action = store.getAction(id);
      if (!action || action.status !== "uncertain") throw new Error("Choose an uncertain delivery.");
      const connection = readState().connections[action.payload.connectionId];
      if (!connection || connection.revision !== action.payload.connectionRevision) throw new Error("The original connection is required for reconciliation.");
      // Positive evidence only: absence from one history page cannot prove non-delivery.
      if (action.action.startsWith("slack.") && connection.scopes.some((s) => ["channels:history", "groups:history", "im:history", "mpim:history"].includes(s))) {
        const input = action.payload.input;
        const method = input.threadTs ? "conversations.replies" : "conversations.history";
        const params = new URLSearchParams({ channel: input.channel, oldest: String((action.created_at - 60_000) / 1000), limit: "100", ...(input.threadTs ? { ts: input.threadTs } : {}) });
        const { result } = await request(`https://slack.com/api/${method}?${params}`, await tokenFor(connection));
        const message = result.messages?.find((m) => m.client_msg_id === id);
        if (message?.ts) store.reconcile(id, { outcome: "delivered", receipt: { channel: input.channel, ts: message.ts, client_msg_id: id }, evidence: "Provider history matched the action client_msg_id.", actor: "provider" });
        else throw new Error("No matching receipt in this history page. Check the provider and record evidence; no resend was scheduled.");
      } else if (action.action === "gmail.sendDraft" && connection.gmailRead) {
        const messageId = action.payload.preview?.match(/^Message-ID:\s*(<[^>]+>)/im)?.[1];
        if (!messageId) throw new Error("The reviewed draft has no Message-ID. Check Sent mail and record evidence manually.");
        const params = new URLSearchParams({ q: `in:sent rfc822msgid:${messageId}`, maxResults: "2" });
        const { result } = await request(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, await tokenFor(connection));
        if (result.messages?.length === 1) {
          // An RFC Message-ID may have been reused before this task. Preserve the candidate
          // for human review instead of treating a search match alone as proof of this send.
          store.event(action.run_id, "action.receipt_candidate", { receipt: result.messages[0], messageId, nextAction: "Check this sent message and record reconciliation evidence." }, id);
        }
        else throw new Error("Sent mail did not return one matching receipt. Record evidence manually.");
      } else throw new Error("Provider history access is not enabled. Check the message or Sent mail and record evidence manually.");
      return `/tasks?run=${action.run_id}`;
    }
  };
  function deliver(id) {
    if (stopping) return Promise.resolve();
    const promise = dispatch(id);
    deliveries.add(promise);
    promise.finally(() => deliveries.delete(promise)).catch(() => {});
    return promise;
  }
  async function dispatch(id) {
    const action = store.claimAction(id);
    if (!action) return;
    const context = {};
    dispatches.set(context, action);
    const heartbeat = setInterval(() => store.renew("action", action.id, action.lease), Math.max(100, leaseMs / 3));
    heartbeat.unref?.();
    try {
      const receipt = await registry().call({ role: action.payload.role, toolName: action.action, input: { ...action.payload.input, connectionId: action.payload.connectionId }, context });
      store.finishAction(action, { status: "delivered", receipt });
    } catch (error) {
      store.finishAction(action, { status: error.deliveryStatus || "failed", error: error.message, retryAfterMs: Math.max(error.retryAfterMs || 0, Math.min(300_000, 1000 * 2 ** action.attempt)) });
    } finally { clearInterval(heartbeat); dispatches.delete(context); }
    return store.getAction(action.id);
  }
  async function execute(run) {
    const controller = new AbortController();
    controllers.set(run.id, controller);
    const heartbeat = setInterval(() => {
      if (!store.renew("run", run.id, run.lease) || store.getRun(run.id)?.desired !== "active") controller.abort();
    }, Math.max(100, Math.min(1000, leaseMs / 3)));
    heartbeat.unref?.();
    try {
      runner ||= executeTurn ? null : createAgentRunner({ tools });
      const previousActions = store.db.prepare("SELECT id,action,status,receipt FROM runtime_actions WHERE run_id=?").all(run.id);
      const context = previousActions.length ? `Previously saved outgoing actions for this task: ${JSON.stringify(previousActions)}. Reuse these results. Do not create replacement messages for an existing action; unresolved deliveries require operator reconciliation.` : "";
      const args = { root, agent: run.agent, prompt: run.prompt, context, label: run.agent, log, signal: controller.signal, toolContext: { runId: run.id, runLease: run.lease } };
      let result;
      try { result = await (executeTurn ? executeTurn(args) : runner.runAgentCapture(args)); }
      catch (error) { result = { ok: false, reason: error.message }; }
      store.finishRun(run, result);
      return { ...result, runId: run.id };
    } finally { clearInterval(heartbeat); controllers.delete(run.id); }
  }
  async function tick() {
    if (activeWork || stopping) return;
    activeWork = (async () => {
      store.recover();
      await deliver();
      if (stopping) return;
      const run = store.claimRun();
      if (run) await execute(run);
    })();
    try { await activeWork; } finally { activeWork = null; }
  }
  async function stop() {
    stopping = true;
    clearInterval(timer); timer = null;
    for (const controller of controllers.values()) controller.abort();
    await activeWork;
    await Promise.allSettled([...executions, ...deliveries]);
  }
  return {
    tools, operations, store, tick, deliver,
    runTurn(agent, prompt, meta = {}) {
      if (stopping) throw new Error("The runtime is stopped.");
      const run = store.enqueue({ agent, prompt, workflow: meta.workflow, dedupeKey: meta.dedupeKey });
      const claimed = store.claimRun(run.id);
      if (!claimed) return Promise.resolve({ ok: true, runId: run.id, status: run.status });
      const promise = execute(claimed);
      executions.add(promise);
      promise.finally(() => executions.delete(promise)).catch(() => {});
      return promise;
    },
    start() { stopping = false; if (!timer) { void tick().catch((error) => log(`[runtime] ${error.message}`)); timer = setInterval(() => void tick().catch((error) => log(`[runtime] ${error.message}`)), 1000); timer.unref?.(); } },
    stop,
    async close() { await stop(); store.close(); }
  };
}
