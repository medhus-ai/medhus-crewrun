import { createToolBroker } from "./tool-broker.js";
import { gmailConnectorActions } from "./connectors/gmail.js";
export { connectorAuthorizationUrl, connectorProvider, connectorProviders } from "./connectors/oauth.js";
export { gmailConnectorActions } from "./connectors/gmail.js";
export { slackConnectorActions } from "./connectors/slack.js";
import { slackConnectorActions } from "./connectors/slack.js";

const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ACTION_ID = /^[a-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;
const CONNECTION_STATES = new Set(["connected", "needs_reconnect", "revoked", "disconnected"]);

// Connector records are deliberately metadata only. OAuth callbacks, refresh tokens, client
// secrets, and provider SDKs remain in the host application; this module only decides which
// narrow action a role may request and whether the host needs to approve it.
export const builtInConnectorActions = Object.freeze([
  ...slackConnectorActions,
  ...gmailConnectorActions
]);

// Gmail reads are off until a host explicitly opts in. Sending a host-owned draft and the Slack
// message actions remain available when their connection, scopes, and role grants permit them.
export function connectorActions({ gmailRead = false, actions = builtInConnectorActions } = {}) {
  return actionValues(actions)
    .filter((action) => gmailRead || action.provider !== "gmail" || !action.read)
    .map(normalizeAction);
}

// Creates the public form of a connection. It copies known metadata fields only, which means a
// caller can safely use it for a dashboard, prompt context, or cross-process MCP context even if
// the host's source record also carries `accessToken`, `refreshToken`, or a vault reference.
export function connectionMetadata(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("connection metadata must be an object");
  }
  const id = normalizedConnectionId(record.id);
  const provider = normalizedProvider(record.provider);
  const status = String(record.status || "connected").trim();
  if (!CONNECTION_STATES.has(status)) throw new Error(`invalid connection status: ${status || "<empty>"}`);

  const accountSource = record.account && typeof record.account === "object" && !Array.isArray(record.account)
    ? record.account
    : {};
  const accountId = safeText(accountSource.id ?? record.accountId, 256);
  const accountLabel = safeText(accountSource.label ?? record.accountLabel, 256);
  const metadata = {
    id,
    provider,
    status,
    account: accountId || accountLabel ? { ...(accountId ? { id: accountId } : {}), ...(accountLabel ? { label: accountLabel } : {}) } : null,
    scopes: normalizedScopes(record.scopes ?? record.grantedScopes)
  };
  for (const [key, value] of [["createdAt", record.createdAt], ["updatedAt", record.updatedAt], ["expiresAt", record.expiresAt]]) {
    const text = safeText(value, 64);
    if (text) metadata[key] = text;
  }
  return metadata;
}

export function createConnectionCatalog(connections = []) {
  const records = connectionValues(connections);
  const byId = new Map();
  for (const record of records) {
    const metadata = connectionMetadata(record);
    if (byId.has(metadata.id)) throw new Error(`duplicate connection id: ${metadata.id}`);
    byId.set(metadata.id, metadata);
  }
  const copy = (metadata) => metadata ? structuredClone(metadata) : null;
  return {
    get: (connectionId) => copy(byId.get(String(connectionId || "").trim())),
    list: () => [...byId.values()].map(copy)
  };
}

// Return the risk classification a host should display and hand to its approval UI. An
// external-write action is never downgraded by a descriptor: it always requires a host decision.
export function classifyConnectorAction(action) {
  const descriptor = typeof action === "string"
    ? connectorActions({ gmailRead: true }).find((entry) => entry.id === action)
    : normalizeAction(action);
  if (!descriptor) throw new Error(`unknown connector action: ${action || "<empty>"}`);
  const requiresApproval = descriptor.risk === "external-write" || descriptor.approval === "required";
  return {
    action: descriptor.id,
    provider: descriptor.provider,
    risk: descriptor.risk,
    requiresApproval,
    reason: requiresApproval ? "This action can communicate or change data outside CrewRun." : "This action is read-only."
  };
}

// A createMcpBridge-compatible registry. `invoke` is intentionally the only place that can
// perform a provider call; it receives a connection id, never a credential or token.
//
// Typical host wiring:
//   const bridge = createMcpBridge(createConnectorRegistry({ roleActions, roleConnections,
//     connections, invoke: ({ action, connectionId, input }) => hostConnectors.invoke(...) }));
export function createConnectorRegistry({
  connections = [],
  roleActions = {},
  roleConnections = {},
  actions = builtInConnectorActions,
  gmailRead = false,
  invoke,
  approve = null,
  governance = null,
  dataFor = defaultConnectorData,
  displayRole = (role) => String(role || "agent"),
  serverName = "connectors",
  label = "Connected services"
} = {}) {
  const descriptors = connectorActions({ gmailRead, actions });
  const actionById = new Map(descriptors.map((action) => [action.id, action]));
  const catalog = createConnectionCatalog(connections);
  const broker = createToolBroker({ allowlists: roleActions, displayRole, governance });

  function canCallAction(role, actionId, roleOptions = {}) {
    return actionById.has(String(actionId || "")) && broker.canCallTool(role, actionId, roleOptions);
  }

  function connectionsForRole(role, actionId, roleOptions = {}) {
    const action = actionById.get(String(actionId || ""));
    if (!action || !canCallAction(role, action.id, roleOptions)) return [];
    return connectionIdsForRole(role, roleConnections)
      .map((connectionId) => catalog.get(connectionId))
      .filter((connection) => connection && supportsAction(connection, action));
  }

  function toolsForRole(role, roleOptions = {}) {
    return broker.toolsForRole(role, roleOptions)
      .filter((actionId) => actionById.has(actionId))
      .filter((actionId) => connectionsForRole(role, actionId, roleOptions).length > 0);
  }

  // createMcpBridge can use this before exposing a tool to a governed role. It deliberately
  // derives data scope from connection metadata only; no token, vault key, or provider payload
  // crosses this boundary.
  function actionPolicy(actionId, context = {}) {
    const action = actionById.get(String(actionId || ""));
    if (!action) return null;
    const role = String(context?.role || "").trim();
    const roleOptions = context?.roleOptions || {};
    const connections = role ? connectionsForRole(role, action.id, roleOptions) : [];
    const data = combineData(connections.map((connection) => dataFor({
      role,
      action: publicAction(action),
      connectionId: connection.id,
      input: {}
    })));
    return { impact: governanceImpact(action.risk), data };
  }

  function validate(actionId, input = {}) {
    const action = actionById.get(String(actionId || ""));
    if (!action) return { ok: false, error: `connector action ${actionId || "<empty>"} is not registered` };
    const result = action.validate(input || {});
    if (!result?.ok) return result || { ok: false, error: `invalid input for ${action.id}` };
    const requestedConnectionId = input?.connectionId == null ? "" : String(input.connectionId).trim();
    if (requestedConnectionId && !CONNECTION_ID.test(requestedConnectionId)) {
      return { ok: false, error: "connectionId is invalid" };
    }
    // The descriptor returns only its known safe input fields, dropping unexpected API-shaped
    // values such as headers, method, raw MIME, blocks, or an `approved` flag from the model.
    return { ok: true, input: { ...result.input, ...(requestedConnectionId ? { connectionId: requestedConnectionId } : {}) } };
  }

  async function call({ role, toolName, input = {}, context = {}, roleOptions = {} } = {}) {
    const actionId = String(toolName || "");
    const action = actionById.get(actionId);
    if (!action) throw new Error(`connector action ${actionId || "<empty>"} is not registered`);
    // Let the shared broker record an allowlist denial before doing validation, lookup, or a
    // host approval lookup. An unauthorized role never learns which connections exist.
    if (!broker.canCallTool(role, actionId, roleOptions)) {
      return broker.callTool({ role, toolName: actionId, input, context, roleOptions, registry: {} });
    }
    const checked = validate(actionId, input);
    if (!checked.ok) throw new Error(checked.error);
    const connection = selectConnection({
      role,
      action,
      requestedConnectionId: checked.input.connectionId,
      connectionsForRole: (selectedRole, selectedAction) => connectionsForRole(selectedRole, selectedAction, roleOptions)
    });
    const actionInput = withoutConnectionId(checked.input);
    const approval = classifyConnectorAction(action);
    const data = dataFor({ role, action: publicAction(action), connectionId: connection.id, input: actionInput });
    const impact = governanceImpact(action.risk);
    // Check authority before asking an operator to review an action. Otherwise a denied role
    // could fill the approval queue with requests for a connector it is not entitled to use.
    const preDecision = governance?.authorizeAction
      ? await governance.authorizeAction({ role, toolName: actionId, input: checked.input, context, roleOptions, approval: null, data, impact })
      : null;
    if (preDecision && !preDecision.allowed && preDecision.decision !== "approval-required") {
      await governance.recordAction?.({
        role,
        action: "tool",
        toolName: actionId,
        input: checked.input,
        context,
        data,
        impact,
        actor: context?.actor || "",
        runner: context?.runner || "",
        model: context?.model || "",
        outcome: preDecision.decision,
        decision: preDecision
      });
      throw new Error(`${displayRole(role)} is not authorized to call ${actionId}${preDecision.reason ? `: ${preDecision.reason}` : ""}`);
    }
    let approvalRecord = null;
    if (approval.requiresApproval) {
      const request = { role, action: action.id, connectionId: connection.id, input: actionInput, approval, data, context };
      if (typeof approve === "function") {
        approvalRecord = await approve(request);
      } else if (typeof governance?.requestApproval === "function") {
        const response = await governance.requestApproval({
          ...request,
          toolName: action.id,
          impact,
          // The policy records the decision fingerprint. This makes a retry after a contract
          // edit create a new review rather than silently claiming the prior approval.
          decision: preDecision || descriptorApprovalDecision(action)
        });
        approvalRecord = response?.approval ?? response ?? null;
      }
      if (!approvalAccepted(approvalRecord)) throw new Error(`${action.id} requires host approval`);
    }
    if (typeof invoke !== "function") throw new Error("connector host does not provide an invoke function");
    return broker.callTool({
      role,
      toolName: actionId,
      input: checked.input,
      context,
      roleOptions,
      approval: approvalRecord,
      data,
      impact,
      actor: context?.actor || "",
      runner: context?.runner || "",
      model: context?.model || "",
      registry: {
        [actionId]: async (_input, invocation) => {
          return await invoke({
            role,
            action: action.id,
            connectionId: connection.id,
            input: actionInput,
            approval,
            approvalRecord,
            data,
            context: invocation.context
          });
        }
      }
    });
  }

  return {
    serverName: normalizedServerName(serverName),
    label: String(label || "Connected services"),
    instructions: "Connected-service actions are host-governed. Use only the listed action; never ask for, expose, or attempt to access OAuth credentials.",
    governance,
    toolsForRole,
    canCallAction,
    actionPolicy,
    connectionsForRole: (role, actionId, roleOptions = {}) => connectionsForRole(role, actionId, roleOptions),
    connectionMetadata: () => catalog.list(),
    describe: (actionId) => actionById.get(String(actionId || ""))?.description || "Unknown connector action.",
    inputSchema: (actionId, z) => {
      const action = actionById.get(String(actionId || ""));
      return action ? { connectionId: z.string().optional(), ...action.inputSchema(z) } : {};
    },
    validate,
    call,
    actions: () => descriptors.map(publicAction)
  };
}

// Alias kept intentionally small: it makes the bridge use clear at call sites without adding a
// second abstraction. The returned value implements createMcpBridge's host registry contract.
export function connectorToolDefinitions(options = {}) {
  return createConnectorRegistry(options);
}

function normalizeAction(raw) {
  if (!raw || typeof raw !== "object") throw new Error("connector action must be an object");
  const id = String(raw.id || "").trim();
  const provider = normalizedProvider(raw.provider);
  if (!ACTION_ID.test(id) || !id.startsWith(`${provider}.`)) throw new Error(`invalid connector action id: ${id || "<empty>"}`);
  if (typeof raw.validate !== "function" || typeof raw.inputSchema !== "function") {
    throw new Error(`connector action ${id} needs inputSchema and validate functions`);
  }
  const risk = raw.risk === "external-write" ? "external-write" : raw.risk === "write" ? "write" : "read";
  return {
    id,
    provider,
    label: String(raw.label || id),
    description: String(raw.description || raw.label || id),
    scopes: normalizedScopes(raw.scopes),
    scopeSets: normalizedScopeSets(raw.scopeSets, raw.scopes),
    risk,
    approval: risk === "external-write" || raw.approval === "required" ? "required" : "none",
    read: Boolean(raw.read),
    inputSchema: raw.inputSchema,
    validate: raw.validate
  };
}

function publicAction(action) {
  return {
    id: action.id,
    provider: action.provider,
    label: action.label,
    description: action.description,
    scopes: [...action.scopes],
    risk: action.risk,
    approval: action.approval,
    read: action.read
  };
}

function selectConnection({ role, action, requestedConnectionId, connectionsForRole: findConnections }) {
  const candidates = findConnections(role, action.id);
  if (requestedConnectionId) {
    const selected = candidates.find((connection) => connection.id === requestedConnectionId);
    if (!selected) throw new Error(`${String(role || "agent")} is not allowed to use connection ${requestedConnectionId}`);
    return selected;
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) throw new Error(`no authorized ${action.provider} connection is available for ${String(role || "agent")}`);
  throw new Error(`select connectionId for ${action.id}`);
}

function supportsAction(connection, action) {
  if (connection.status !== "connected" || connection.provider !== action.provider) return false;
  const granted = new Set(connection.scopes);
  return action.scopeSets.some((scopeSet) => scopeSet.every((scope) => granted.has(scope)));
}

function normalizedConnectionId(value) {
  const id = String(value || "").trim();
  if (!CONNECTION_ID.test(id)) throw new Error(`invalid connection id: ${id || "<empty>"}`);
  return id;
}

function normalizedProvider(value) {
  const provider = String(value || "").trim();
  if (!PROVIDER_ID.test(provider)) throw new Error(`invalid connector provider: ${provider || "<empty>"}`);
  return provider;
}

function normalizedScopes(value) {
  const scopes = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  return [...new Set(scopes.map((scope) => String(scope || "").trim()).filter(Boolean))];
}

function normalizedScopeSets(value, fallback) {
  const source = Array.isArray(value) && value.length ? value : [fallback];
  const sets = source.map((entry) => normalizedScopes(entry)).filter((entry) => entry.length > 0);
  if (sets.length === 0) throw new Error("connector action needs at least one OAuth scope");
  return sets;
}

function actionValues(actions) {
  if (Array.isArray(actions)) return actions;
  if (actions instanceof Map) return [...actions.values()];
  if (actions && typeof actions === "object") return Object.values(actions);
  throw new Error("connector actions must be an array, map, or object");
}

function connectionValues(connections) {
  if (Array.isArray(connections)) return connections;
  if (connections instanceof Map) return [...connections.values()];
  if (connections && typeof connections === "object") {
    return Object.entries(connections).map(([id, record]) => ({ ...(record || {}), id: record?.id || id }));
  }
  throw new Error("connections must be an array, map, or object");
}

function connectionIdsForRole(role, roleConnections) {
  const value = roleConnections instanceof Map
    ? roleConnections.get(role)
    : roleConnections?.[role];
  const ids = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
}

function withoutConnectionId(input) {
  const { connectionId, ...actionInput } = input;
  return actionInput;
}

function defaultConnectorData({ action, connectionId }) {
  const scope = `connector:${String(action?.provider || "unknown").toLowerCase()}:${String(connectionId || "unknown").toLowerCase()}`;
  return action?.risk === "read" ? { read: [scope], write: [] } : { read: [], write: [scope] };
}

function combineData(values) {
  const read = new Set();
  const write = new Set();
  for (const value of values) {
    for (const scope of Array.isArray(value?.read) ? value.read : []) read.add(String(scope));
    for (const scope of Array.isArray(value?.write) ? value.write : []) write.add(String(scope));
  }
  return { read: [...read].sort(), write: [...write].sort() };
}

function descriptorApprovalDecision(action) {
  return {
    allowed: false,
    decision: "approval-required",
    reason: `${action.id} requires host approval`,
    impact: governanceImpact(action.risk),
    approval_required: true
  };
}

function governanceImpact(risk) {
  if (risk === "external-write") return "external-write";
  if (risk === "write") return "internal-write";
  return "read";
}

function approvalAccepted(value) {
  if (value === true) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = String(value.status ?? (value.approved ? "approved" : "")).trim().toLowerCase();
  return status === "approved";
}

function safeText(value, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, maxLength);
}

function normalizedServerName(value) {
  const name = String(value || "connectors").trim();
  return /^[a-z][a-z0-9-]{0,63}$/.test(name) ? name : "connectors";
}
