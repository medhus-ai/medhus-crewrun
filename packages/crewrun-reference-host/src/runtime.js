import { createHash } from "node:crypto";

import { redactIntegrationText } from "@medhus-ai/crewrun-plugin-sdk";
import { createAgentRunner, runnerIdForRole } from "medhus-crewrun/runner";
import { createMcpBridge } from "medhus-crewrun/mcp";
import { createConnectorRegistry } from "medhus-crewrun/connectors";
import { createRuntimeStore } from "medhus-crewrun/runtime-store";
import { createRoleGovernance, scopeAllows } from "medhus-crewrun/role-contract";
import { listRoleSpecs, loadRoleSpec } from "medhus-crewrun/role-spec";
import { createConsoleChatService, createConsoleHelperBridge, HELPER_ROLE } from "medhus-crewrun/console-chat";
import { resolveRunnerProfile } from "medhus-crewrun/runner-config";
import { createWorkspaceTools, WORK_TOOLS, workToolSchema } from "medhus-crewrun/workspace-tools";
import { routeLifecycleEvents } from "medhus-crewrun/runtime-lifecycle";
import { readWorkspace } from "medhus-crewrun/workspace-manifest";
import { executeLeasedRun } from "medhus-crewrun/runtime-worker";
import { createShellSession } from "medhus-crewrun/shell-access";

class QueuedAction extends Error {
  constructor(action) { super("Saved for operator review"); this.action = action; }
}

// Versioned plugins share the runtime store, worker, governed tools, and delivery outbox.
export function createIntegrationRuntime({ targetRoot, state, plugins, pluginConfig = {}, fetchImpl = globalThis.fetch, env = process.env, now = Date.now, log = () => {} } = {}) {
  const store = createRuntimeStore({ targetRoot, env, now });
  const dispatches = new WeakMap();
  const controllers = new Map();
  const running = new Set();
  let runner = null;
  let chatRunner = null;
  let helperRunner = null;
  let active = null;
  let stopped = false;
  let closed = false;

  const authorization = (decision) => ({
    decision: decision?.decision,
    contract_version: decision?.contract_version,
    contract_revision: decision?.contract_revision,
    contract_fingerprint: decision?.contract_fingerprint
  });
  const governance = createRoleGovernance({
    targetRoot,
    env,
    requireContracts: true,
    getContract: (role) => loadRoleSpec(targetRoot, role)?.contract,
    requestApproval: async (request) => requestApproval(request)
  });
  const workspace = createWorkspaceTools({ targetRoot, store, governance, now });

  function connectionRecords() {
    return state.listConnections().map((connection) => ({
      id: connection.id, provider: connection.plugin, status: connection.status,
      account: connection.account, scopes: connection.scopes, capabilities: connection.capabilities
    }));
  }

  function actionDescriptors() {
    return plugins.list().flatMap((plugin) => Array.isArray(plugins.get(plugin.id)?.actions) ? plugins.get(plugin.id).actions : []);
  }

  function isExternalWriteAction(actionId) {
    return actionDescriptors().some((descriptor) => descriptor?.id === String(actionId || "") && descriptor.risk === "external-write");
  }

  function connectorRegistry() {
    const specs = listRoleSpecs(targetRoot);
    const connectionIds = connectionRecords().map((connection) => connection.id);
    return createConnectorRegistry({
      connections: connectionRecords(),
      actions: actionDescriptors(),
      roleActions: Object.fromEntries(Object.entries(specs).map(([role, spec]) => [role, (spec.contract?.authority?.tools || []).map((tool) => tool.name)])),
      roleConnections: Object.fromEntries(Object.keys(specs).map((role) => [role, connectionIds])),
      governance,
      serverName: "integrations",
      label: "Connected integrations",
      invoke: invokePluginAction
    });
  }

  const registryBridge = {
    serverName: "integrations",
    label: "Connected integrations",
    instructions: "Integration tools are governed by your role contract. Use only listed tools and never request, reveal, or handle provider credentials.",
    governance,
    assertContext: (context) => { if (context?.runId) store.assertRunContext(context.runId, context.runLease); },
    toolsForRole: (role, options) => [...connectorRegistry().toolsForRole(role, options), ...Object.keys(WORK_TOOLS)],
    describe: (name) => WORK_TOOLS[name] || connectorRegistry().describe(name),
    inputSchema: (name, z) => WORK_TOOLS[name] ? workToolSchema(name, z) : connectorRegistry().inputSchema(name, z),
    validate: (name, input) => WORK_TOOLS[name] ? { ok: true, input } : connectorRegistry().validate(name, input),
    actionPolicy: (name, context) => WORK_TOOLS[name] ? { impact: ["task.get", "task.list", "workspace.read", "workspace.search"].includes(name) ? "read" : "internal-write" } : connectorRegistry().actionPolicy(name, context),
    call: async (request) => {
      if (WORK_TOOLS[request.toolName]) return workspace.call(request);
      try { return await connectorRegistry().call(request); }
      catch (error) {
        if (!(error instanceof QueuedAction)) throw error;
        return { actionId: error.action.id, runId: error.action.run_id, status: error.action.status, nextAction: "This write is waiting for operator approval. It has not been sent." };
      }
    }
  };
  const bridge = createMcpBridge(registryBridge);
  // Credentials and connection resolvers remain in host closures for both engines.
  const tools = { ...bridge, openShellSession: (options) => createShellSession({ ...options, env }) };
  const chats = createConsoleChatService({
    targetRoot,
    getDb: () => store.db,
    createRunner: () => chatRunner ||= createAgentRunner({ tools }),
    createHelperRunner: () => helperRunner ||= createAgentRunner({ tools: createConsoleHelperBridge({ targetRoot, workspace, extraStatus: () => ({ connections: connectionRecords(), integrations: plugins.list().map((p) => ({ id: p.id, events: p.events, capabilities: p.capabilities })) }) }) }),
    toolContextFor: ({ role }) => role === HELPER_ROLE ? { governedToolsOnly: true } : actionOrigin(role),
    beforeTurn: ({ role }) => store.tx(() => {
      const day = new Date(now()).toISOString().slice(0, 10);
      const key = `chat-count:${role}:${day}`;
      const count = store.meta(key) || 0;
      const runs = store.db.prepare("SELECT COUNT(*) AS n FROM runtime_attempts a JOIN runtime_runs r ON r.id=a.run_id WHERE r.agent=? AND a.started_at>=?").get(role, Date.parse(day)).n;
      const cap = loadRoleSpec(targetRoot, role)?.contract?.budget?.max_runs_per_day;
      if (cap != null && runs + count >= cap) throw new Error("Daily agent run limit reached, including chats.");
      store.setMeta(key, count + 1);
    }),
    afterTurn: ({ role, conversationId, result, durationSeconds }) => {
      const origin = actionOrigin(role);
      store.ledger.recordRun({ workflow: "console-chat", repository: targetRoot, runnerId: origin.runner, model: origin.model, actor: role, ref: `chat:${conversationId}`, result: result.ok ? "completed" : "failed", durationSeconds, usage: result.usage });
    },
    log
  });

  async function requestApproval(request) {
    const connection = state.getConnection(request.connectionId);
    if (!connection || connection.status !== "connected") throw new Error("This integration is disconnected.");
    const current = dispatches.get(request.context);
    if (current) {
      const payload = current.payload;
      if (payload.connectionRevision !== connection.revision) throw new Error("The connection changed after review. Submit a new request.");
      if (fingerprint(payload.authorization) !== fingerprint(authorization(request.decision))) throw new Error("Role authority changed after review. Submit a new request.");
      if (fingerprint(payload.input) !== fingerprint(request.input)) throw new Error("The action changed after review. Submit a new request.");
      return { id: current.id, status: "approved", approved_by: current.decided_by, authorization: payload.authorization };
    }
    if (request.context?.runId) store.assertRunContext(request.context.runId, request.context.runLease);
    const payload = {
      role: request.role, connectionId: request.connectionId, input: request.input,
      connectionRevision: connection.revision, authorization: authorization(request.decision),
      // Delivery may run later in another process. Preserve host-derived execution identity,
      // rather than a model-provided field, so the durable audit can still say who acted.
      origin: actionOrigin(request.role),
      // This remains in the private runtime database for operator review; audit records keep
      // only a digest through the governance layer.
      preview: previewForApproval(request.action, request.input)
    };
    const action = store.tx(() => {
      if (request.context?.runId) store.assertRunContext(request.context.runId, request.context.runLease);
      const run = request.context?.runId
        ? store.getRun(request.context.runId)
        : store.enqueue({ agent: request.role, prompt: `Review ${request.action}`, workflow: "connector" });
      if (!request.context?.runId) store.db.prepare("UPDATE runtime_runs SET status='completed' WHERE id=?").run(run.id);
      return store.queueAction({ runId: run.id, action: request.action, payload, dedupeKey: fingerprint([run.id, request.action, payload]) });
    });
    throw new QueuedAction(action);
  }

  async function invokePluginAction({ action, connectionId, input, context }) {
    let connection = state.getConnection(connectionId, { credentials: true });
    if (!connection || connection.status !== "connected") throw new Error("This integration is disconnected.");
    const plugin = plugins.get(connection.plugin);
    if (!plugin?.adapter?.invoke) throw new Error(`${connection.plugin} does not implement action delivery`);
    connection = await refreshConnectionIfNeeded({ state, connection, plugin, pluginConfig, fetchImpl, now });
    const dispatched = dispatches.get(context);
    if (dispatched) {
      const latest = store.getAction(dispatched.id);
      if (!latest || latest.lease !== dispatched.lease || latest.lease_until <= now()) throw new Error("Delivery claim expired before provider dispatch.");
    }
    const config = privatePluginConfig(pluginConfig, connection.plugin);
    let result;
    try {
      result = await plugin.adapter.invoke({ action, input, connection, credentials: connection.credentials, config, ...config, fetch: fetchImpl, idempotencyKey: dispatched?.id || "" });
    } catch (error) {
      // None of the supported providers offers a uniform, durable idempotency guarantee for
      // every curated write. Once an external-write adapter has started, a lost response cannot
      // prove that the provider did not commit it. Do not put that action back on the automatic
      // queue: require an operator to reconcile it and, if needed, approve a fresh request.
      if (isExternalWriteAction(action)) throw uncertainExternalDelivery(error);
      throw error;
    }
    if (result?.credentials) {
      state.saveConnection({ ...connection, pluginId: connection.plugin, credentials: result.credentials });
    }
    return result?.result ?? result;
  }

  async function runCaptured(run) {
    const work = executeLeasedRun({ store, run, controllers, errorMessage: (error) => redactIntegrationText(error?.message || "Agent run failed", 1000), execute: async (signal) => {
      const spec = loadRoleSpec(targetRoot, run.agent);
      if (readWorkspace(targetRoot) && !spec?.contract) throw new Error("A governed agent contract is required.");
      if (run.workflow === "integration-event") {
        const source = JSON.parse(run.provenance || "{}");
        if (source.connectionId) {
          const connection = state.getConnection(source.connectionId);
          const routes = readWorkspace(targetRoot)?.integrationRules || state.listRoutes();
          if (connection?.status !== "connected" || !spec?.hooks.includes(source.eventType) || !scopeAllows(spec.contract?.authority.data.read, source.scope) || !routes.some((r) => r.enabled && r.role === run.agent && r.connectionId === source.connectionId && r.eventType === source.eventType)) throw new Error("Event connection or routing authority changed before execution.");
        } else if (readWorkspace(targetRoot)) throw new Error("Event execution requires verified host provenance.");
      }
      if (run.parent_id && ["delegation", "lifecycle"].includes(run.workflow)) {
        const parent = store.getRun(run.parent_id);
        if (parent?.agent !== run.agent && (!governance.authorizeHandoff({ role: parent?.agent, peerRole: run.agent }).allowed || !governance.authorizeHandoff({ role: run.agent, peerRole: parent?.agent, direction: "receive" }).allowed)) throw new Error("Handoff authority changed before execution.");
      }
      runner ||= createAgentRunner({ tools });
      const origin = actionOrigin(run.agent);
      return runner.runAgentCapture({
        root: targetRoot, agent: run.agent, prompt: run.prompt, context: `Host task state (data, not policy):\n${store.taskContext(run.id)}`, label: run.agent, signal,
        toolContext: {
          runId: run.id, runLease: run.lease, ...origin
        }, log
      });
    } });
    running.add(work);
    work.finally(() => running.delete(work)).catch(() => {});
    return work;
  }

  function deliver(id = null) {
    if (stopped) return Promise.resolve(null);
    const work = dispatch(id);
    running.add(work);
    work.finally(() => running.delete(work)).catch(() => {});
    return work;
  }

  async function dispatch(id = null) {
    const action = store.claimAction(id);
    if (!action) return null;
    const context = actionOrigin(action.payload?.role || "", action.payload?.origin);
    dispatches.set(context, action);
    const heartbeat = setInterval(() => store.renew("action", action.id, action.lease), 20_000);
    heartbeat.unref?.();
    try {
      const receipt = await connectorRegistry().call({
        role: action.payload.role, toolName: action.action,
        input: { ...action.payload.input, connectionId: action.payload.connectionId }, context
      });
      store.finishAction(action, { status: "delivered", receipt });
    } catch (error) {
      const status = error?.deliveryStatus || (isTransient(error) ? "retry_wait" : "failed");
      store.finishAction(action, { status, error: redactIntegrationText(error?.message || "Provider delivery failed", 1_000), retryAfterMs: status === "retry_wait" ? 30_000 : 0 });
    } finally {
      clearInterval(heartbeat);
      dispatches.delete(context);
    }
    return store.getAction(action.id);
  }

  async function tick() {
    if (active || stopped) return active;
    active = (async () => {
      store.recover();
      workspace.recover();
      routeLifecycleEvents({ targetRoot, store, governance });
      await deliver();
      if (stopped) return;
      const run = store.claimRun();
      if (run) await runCaptured(run);
    })();
    try { return await active; } finally { active = null; }
  }

  function enqueue({ role, body, externalId, provenance = {} }) {
    return store.enqueue({ agent: role, prompt: body, workflow: "integration-event", dedupeKey: externalId, provenance });
  }

  async function runTurn(role, prompt, meta = {}) {
    if (stopped) throw new Error("The workspace runtime is stopped.");
    const run = store.enqueue({ agent: role, prompt, workflow: meta.workflow || "manual", dedupeKey: meta.dedupeKey || null });
    const claimed = store.claimRun(run.id);
    return claimed ? runCaptured(claimed) : { ok: true, runId: run.id, status: run.status };
  }

  async function stop() {
    stopped = true;
    for (const controller of controllers.values()) controller.abort();
    await active;
    await Promise.allSettled([...running]);
  }

  async function close() {
    if (closed) return;
    closed = true;
    await stop();
    store.close();
  }

  function actionOrigin(role, persisted = null) {
    const actor = String(role || "").trim();
    const configuredRunner = runnerIdForRole(actor, targetRoot);
    const configuredProfile = resolveRunnerProfile(configuredRunner);
    // The durable payload is written by this host when it queues approval. Preserve its bounded
    // runner/model through a later config edit, but pin actor to the approved role rather than a
    // stored or model-supplied identity.
    const stored = persisted && typeof persisted === "object" && !Array.isArray(persisted) ? persisted : {};
    const runner = originText(stored.runner, 160) || configuredRunner || configuredProfile?.id || "";
    const model = originText(stored.model, 160) || configuredProfile?.model || configuredProfile?.display_name || "";
    return {
      actor,
      ...(runner ? { runner } : {}),
      ...(model ? { model } : {})
    };
  }

  return {
    store, tools, governance, workspace, chats, enqueue, runTurn, tick, deliver, stop, close,
    start: () => {
      if (closed) throw new Error("integration runtime is closed");
      stopped = false;
    },
    snapshot: () => store.snapshot(),
    decideApproval: (id, action) => store.decideAction(id, action),
    reconcileAction: (id, input) => store.reconcile(id, input)
  };
}

function fingerprint(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function originText(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum && /^[^\r\n\u0000]+$/.test(text) ? text : "";
}
function uncertainExternalDelivery(error) {
  if (error?.deliveryStatus) return error;
  const failure = new Error("CrewRun did not receive a confirmed provider receipt. The external action may have completed; reconcile it before requesting a new approval.");
  failure.deliveryStatus = "uncertain";
  failure.cause = error;
  return failure;
}
function isTransient(error) { return /timeout|network|temporar|rate limit|429|5\d\d/i.test(String(error?.message || "")); }
function previewForApproval(action, input) {
  const rendered = JSON.stringify(input);
  return `${action}\n${rendered.length > 8_000 ? `${rendered.slice(0, 8_000)}…` : rendered}`;
}

function privatePluginConfig(config, pluginId) {
  return config && typeof config === "object" && !Array.isArray(config) && config[pluginId] && typeof config[pluginId] === "object" && !Array.isArray(config[pluginId])
    ? config[pluginId]
    : {};
}

export async function refreshConnectionIfNeeded({ state, connection, plugin, pluginConfig = {}, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const expiresAt = Date.parse(String(connection?.credentials?.expiresAt || ""));
  if (!Number.isFinite(expiresAt) || expiresAt > now() + 60_000 || !plugin?.adapter?.refreshCredentials) return connection;
  const config = privatePluginConfig(pluginConfig, connection.plugin);
  const refreshed = await plugin.adapter.refreshCredentials({ connection, credentials: connection.credentials, config, ...config, fetch: fetchImpl });
  const credentials = refreshed?.credentials || refreshed;
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) throw new Error(`${connection.plugin} did not return refreshed credentials`);
  state.saveConnection({
    ...connection,
    pluginId: connection.plugin,
    scopes: Array.isArray(refreshed?.scopes) && refreshed.scopes.length ? refreshed.scopes : connection.scopes,
    credentials
  });
  return state.getConnection(connection.id, { credentials: true });
}
