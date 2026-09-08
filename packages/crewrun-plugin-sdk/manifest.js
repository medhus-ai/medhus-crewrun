import { deepFreeze, normalizedProvider, normalizedStrings, requiredText, safeMetadata, safeText } from "./safe.js";

export const INTEGRATION_PLUGIN_API_VERSION = "crewrun.integration/v1";

const ACTION_OR_EVENT_ID = /^[a-z][a-z0-9-]{0,63}\.[A-Za-z][A-Za-z0-9]*$/;
const CAPABILITY_ID = /^[a-z][a-z0-9-]{0,63}$/;
const DIRECTIONS = new Set(["read", "write", "both"]);
const RISKS = new Set(["read", "internal-write", "external-write", "write"]);
const APPROVALS = new Set(["none", "required"]);
const DELIVERIES = new Set(["webhook", "poll"]);
const RETENTIONS = new Set(["metadata", "content"]);
const PKCE_MODES = new Set(["required", "optional", "none"]);
const RESERVED_OAUTH_PARAMETERS = new Set(["client_id", "redirect_uri", "state", "scope", "response_type", "code_challenge", "code_challenge_method"]);

// Define a provider integration contract. The returned object only contains declarative public
// metadata plus host-runtime hooks; credentials and storage adapters are deliberately absent.
export function defineIntegrationPlugin(manifest) {
  return deepFreeze(validateIntegrationPlugin(manifest));
}

export const integrationPluginManifest = defineIntegrationPlugin;

export function validateIntegrationPlugin(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("integration plugin manifest must be an object");
  }
  const apiVersion = raw.apiVersion == null ? INTEGRATION_PLUGIN_API_VERSION : requiredText(raw.apiVersion, "plugin apiVersion", 128);
  if (apiVersion !== INTEGRATION_PLUGIN_API_VERSION) {
    throw new Error(`unsupported integration plugin apiVersion: ${apiVersion}`);
  }
  const id = normalizedProvider(raw.id);
  const label = requiredText(raw.label, "plugin label", 160);
  const description = safeText(raw.description, 1_024);
  const oauth = raw.oauth == null ? null : normalizeOAuthMetadata(raw.oauth);
  const capabilities = values(raw.capabilities, "plugin capabilities").map(validateIntegrationCapability);
  assertDistinct(capabilities, "id", "capability");
  const capabilityIds = new Set(capabilities.map((capability) => capability.id));
  const actions = values(raw.actions, "plugin actions").map((action) => validateIntegrationAction(action, { pluginId: id, capabilityIds }));
  assertDistinct(actions, "id", "action");
  const events = values(raw.events, "plugin events").map((event) => validateIntegrationEvent(event, { pluginId: id, capabilityIds }));
  assertDistinct(events, "id", "event");
  const runtime = runtimeHooks(raw);
  const subscription = raw.subscription == null ? null : safeMetadata(raw.subscription);
  const metadata = raw.metadata == null ? null : safeMetadata(raw.metadata);
  return {
    apiVersion,
    id,
    label,
    ...(description ? { description } : {}),
    oauth,
    capabilities,
    actions,
    events,
    ...(subscription ? { subscription } : {}),
    ...(metadata ? { metadata } : {}),
    ...runtime
  };
}

export function validateIntegrationCapability(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("integration capability must be an object");
  const id = String(raw.id || "").trim();
  if (!CAPABILITY_ID.test(id)) throw new Error(`invalid integration capability id: ${id || "<empty>"}`);
  const label = requiredText(raw.label, `capability ${id} label`, 160);
  const description = safeText(raw.description, 1_024);
  const direction = raw.direction == null ? "read" : String(raw.direction).trim();
  if (!DIRECTIONS.has(direction)) throw new Error(`invalid direction for capability ${id}`);
  return {
    id,
    label,
    ...(description ? { description } : {}),
    direction,
    scopes: normalizedStrings(raw.scopes)
  };
}

export function validateIntegrationAction(raw, { pluginId, capabilityIds } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("integration action must be an object");
  const id = normalizedDescriptorId(raw.id, pluginId, "action");
  const capability = requiredText(raw.capability, `action ${id} capability`, 64);
  if (capabilityIds && !capabilityIds.has(capability)) throw new Error(`action ${id} references unknown capability ${capability}`);
  const label = requiredText(raw.label, `action ${id} label`, 160);
  const description = safeText(raw.description, 1_024);
  const rawRisk = raw.risk == null ? "read" : String(raw.risk).trim();
  if (!RISKS.has(rawRisk)) throw new Error(`invalid risk for action ${id}`);
  const risk = rawRisk === "write" ? "internal-write" : rawRisk;
  const requestedApproval = raw.approval == null ? "none" : String(raw.approval).trim();
  if (!APPROVALS.has(requestedApproval)) throw new Error(`invalid approval for action ${id}`);
  const approval = risk === "external-write" ? "required" : requestedApproval;
  const scopes = normalizedStrings(raw.scopes);
  const scopeSets = normalizeScopeSets(raw.scopeSets, scopes);
  if (raw.inputSchema != null && typeof raw.inputSchema !== "function") throw new Error(`action ${id} inputSchema must be a function`);
  if (raw.validate != null && typeof raw.validate !== "function") throw new Error(`action ${id} validate must be a function`);
  // The MCP tool schema and the host-side safe projection are complementary boundaries. A
  // schema alone cannot give the non-MCP delivery path a whitelisted normalized input, while a
  // validator alone cannot expose a safe tool schema. Reject either omission at load time.
  if (typeof raw.inputSchema !== "function" || typeof raw.validate !== "function") {
    throw new Error(`action ${id} needs inputSchema and validate functions`);
  }
  return {
    id,
    provider: descriptorProvider(id),
    capability,
    label,
    ...(description ? { description } : {}),
    risk,
    approval,
    read: risk === "read",
    scopes,
    scopeSets,
    requiresConnection: raw.requiresConnection !== false,
    ...(raw.inputSchema ? { inputSchema: raw.inputSchema } : {}),
    ...(raw.validate ? { validate: raw.validate } : {})
  };
}

export function validateIntegrationEvent(raw, { pluginId, capabilityIds } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("integration event must be an object");
  const id = normalizedDescriptorId(raw.id, pluginId, "event");
  const capability = requiredText(raw.capability, `event ${id} capability`, 64);
  if (capabilityIds && !capabilityIds.has(capability)) throw new Error(`event ${id} references unknown capability ${capability}`);
  const label = requiredText(raw.label, `event ${id} label`, 160);
  const description = safeText(raw.description, 1_024);
  const delivery = raw.delivery == null ? "webhook" : String(raw.delivery).trim();
  if (!DELIVERIES.has(delivery)) throw new Error(`invalid delivery for event ${id}`);
  const retention = raw.retention == null ? "metadata" : String(raw.retention).trim();
  if (!RETENTIONS.has(retention)) throw new Error(`invalid retention for event ${id}`);
  return {
    id,
    provider: descriptorProvider(id),
    capability,
    label,
    ...(description ? { description } : {}),
    delivery,
    retention,
    scopes: normalizedStrings(raw.scopes)
  };
}

export function providerOAuthMetadata(pluginOrOAuth) {
  const source = pluginOrOAuth?.oauth ?? pluginOrOAuth;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  return deepFreeze(normalizeOAuthMetadata(source));
}

export function normalizeOAuthMetadata(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("OAuth metadata must be an object");
  const authorizationEndpoint = httpsUrl(raw.authorizationEndpoint, "OAuth authorizationEndpoint");
  const tokenEndpoint = raw.tokenEndpoint == null ? "" : httpsUrl(raw.tokenEndpoint, "OAuth tokenEndpoint");
  const scopeSeparator = raw.scopeSeparator == null ? " " : String(raw.scopeSeparator);
  if (!scopeSeparator || scopeSeparator.length > 4) throw new Error("OAuth scopeSeparator is invalid");
  const pkce = raw.pkce == null ? (raw.usePkce === false ? "none" : "required") : String(raw.pkce).trim();
  if (!PKCE_MODES.has(pkce)) throw new Error("OAuth pkce must be required, optional, or none");
  const authorizationParams = normalizeAuthorizationParams(raw.authorizationParams);
  return {
    authorizationEndpoint,
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    defaultScopes: normalizedStrings(raw.defaultScopes ?? raw.scopes),
    scopeSeparator,
    pkce,
    ...(Object.keys(authorizationParams).length ? { authorizationParams } : {})
  };
}

function runtimeHooks(raw) {
  for (const name of ["verifyWebhook", "normalizeEvent", "subscribe", "renew", "disconnect", "invoke"]) {
    if (raw[name] != null) throw new Error(`v6 plugin hooks belong in adapter, not top-level ${name}`);
  }
  const adapter = normalizeAdapter(raw.adapter);
  return adapter ? { adapter } : {};
}

function normalizeAdapter(raw) {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("plugin adapter must be an object");
  const adapter = {};
  const names = [
    "authorizationUrl",
    "exchangeCode",
    "refreshCredentials",
    "identifyAccount",
    "invoke",
    "verifyWebhook",
    "normalizeEvent",
    "subscribe",
    "renew",
    "revoke"
  ];
  for (const name of names) {
    if (raw[name] == null) continue;
    if (typeof raw[name] !== "function") throw new Error(`plugin adapter ${name} must be a function`);
    adapter[name] = raw[name];
  }
  for (const key of Object.keys(raw)) {
    if (!names.includes(key)) throw new Error(`plugin adapter field ${key} is not supported`);
  }
  return Object.keys(adapter).length ? adapter : null;
}

function values(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function normalizedDescriptorId(value, pluginId, kind) {
  const id = requiredText(value, `${kind} id`, 128);
  const provider = normalizedProvider(pluginId ?? descriptorProvider(id));
  if (!ACTION_OR_EVENT_ID.test(id) || !id.startsWith(`${provider}.`)) {
    throw new Error(`invalid integration ${kind} id: ${id}`);
  }
  return id;
}

function descriptorProvider(id) {
  return String(id || "").split(".", 1)[0];
}

function normalizeScopeSets(value, fallback) {
  if (value == null) return fallback.length ? [fallback] : [];
  if (!Array.isArray(value)) throw new Error("action scopeSets must be an array");
  return value.map((entry) => normalizedStrings(entry)).filter((entry) => entry.length > 0);
}

function normalizeAuthorizationParams(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OAuth authorizationParams must be an object");
  const params = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || RESERVED_OAUTH_PARAMETERS.has(key.toLowerCase())) {
      throw new Error(`OAuth authorization parameter ${key} is not allowed`);
    }
    params[key] = requiredText(String(item ?? ""), `OAuth authorization parameter ${key}`, 1_024);
  }
  return params;
}

function httpsUrl(value, name) {
  const text = requiredText(value, name, 2_048);
  let url;
  try { url = new URL(text); } catch { throw new Error(`${name} must be an absolute URL`); }
  if (url.protocol !== "https:") throw new Error(`${name} must use https`);
  return url.toString();
}

function assertDistinct(items, key, name) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item[key])) throw new Error(`duplicate integration ${name} id: ${item[key]}`);
    seen.add(item[key]);
  }
}
