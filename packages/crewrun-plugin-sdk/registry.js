import { integrationPluginManifest, providerOAuthMetadata } from "./manifest.js";
import { oauthAuthorizationUrl } from "./oauth.js";
import { connectionMetadata, deepFreeze, normalizeIntegrationEvent } from "./safe.js";

// A deliberately small host-side registry. It indexes only validated, immutable manifests and
// leaves credentials, database state, HTTP listeners, and policy enforcement with the host.
export function createPluginRegistry({ plugins = [] } = {}) {
  const byId = new Map();
  const actions = new Map();
  const events = new Map();
  for (const plugin of pluginValues(plugins)) {
    const defined = integrationPluginManifest(plugin);
    if (byId.has(defined.id)) throw new Error(`duplicate integration plugin id: ${defined.id}`);
    byId.set(defined.id, defined);
    for (const action of defined.actions) {
      if (actions.has(action.id)) throw new Error(`duplicate integration action id: ${action.id}`);
      actions.set(action.id, action);
    }
    for (const event of defined.events) {
      if (events.has(event.id)) throw new Error(`duplicate integration event id: ${event.id}`);
      events.set(event.id, event);
    }
  }

  const publicPlugin = (plugin) => plugin ? publicManifest(plugin) : null;
  const publicAction = (action) => action ? publicDescriptor(action) : null;
  const publicEvent = (event) => event ? publicDescriptor(event) : null;

  return Object.freeze({
    get: (pluginId) => byId.get(String(pluginId || "").trim()) || null,
    list: () => [...byId.values()].map(publicPlugin),
    action: (actionId) => publicAction(actions.get(String(actionId || "").trim())),
    actions: () => [...actions.values()].map(publicAction),
    event: (eventId) => publicEvent(events.get(String(eventId || "").trim())),
    events: () => [...events.values()].map(publicEvent),
    oauth: (pluginId) => {
      const plugin = requiredPlugin(byId, pluginId);
      return providerOAuthMetadata(plugin);
    },
    authorizationUrl: (pluginId, options = {}) => {
      const plugin = requiredPlugin(byId, pluginId);
      return oauthAuthorizationUrl({ ...options, plugin });
    },
    connectionMetadata: (record) => connectionMetadata(record),
    normalizeEvent: (pluginId, event) => {
      const plugin = requiredPlugin(byId, pluginId);
      const normalize = plugin.adapter?.normalizeEvent;
      const normalized = typeof normalize === "function" ? normalize(event) : event;
      return normalizeIntegrationEvent(normalized, { provider: plugin.id, eventIds: plugin.events.map((entry) => entry.id) });
    },
    verifyWebhook: async (pluginId, request) => {
      const plugin = requiredPlugin(byId, pluginId);
      const verify = plugin.adapter?.verifyWebhook;
      if (typeof verify !== "function") throw new Error(`integration plugin ${plugin.id} does not verify webhooks`);
      return await verify(request);
    }
  });
}

function pluginValues(plugins) {
  if (Array.isArray(plugins)) return plugins;
  if (plugins instanceof Map) return [...plugins.values()];
  if (plugins && typeof plugins === "object") return Object.values(plugins);
  throw new Error("integration plugins must be an array, map, or object");
}

function requiredPlugin(byId, pluginId) {
  const id = String(pluginId || "").trim();
  const plugin = byId.get(id);
  if (!plugin) throw new Error(`unknown integration plugin: ${id || "<empty>"}`);
  return plugin;
}

function publicManifest(plugin) {
  return deepFreeze({
    apiVersion: plugin.apiVersion,
    id: plugin.id,
    label: plugin.label,
    ...(plugin.description ? { description: plugin.description } : {}),
    oauth: plugin.oauth ? providerOAuthMetadata(plugin) : null,
    ...(plugin.setup ? { setup: structuredClone(plugin.setup) } : {}),
    capabilities: plugin.capabilities.map((entry) => ({ ...entry, scopes: [...entry.scopes] })),
    actions: plugin.actions.map(publicDescriptor),
    events: plugin.events.map(publicDescriptor),
    ...(plugin.subscription ? { subscription: structuredClone(plugin.subscription) } : {}),
    ...(plugin.metadata ? { metadata: structuredClone(plugin.metadata) } : {})
  });
}

function publicDescriptor(descriptor) {
  const { inputSchema, validate, ...publicValue } = descriptor;
  return deepFreeze({
    ...publicValue,
    ...(Array.isArray(publicValue.scopes) ? { scopes: [...publicValue.scopes] } : {}),
    ...(Array.isArray(publicValue.scopeSets) ? { scopeSets: publicValue.scopeSets.map((set) => [...set]) } : {})
  });
}
