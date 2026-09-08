import http from "node:http";
import { URL } from "node:url";

import { redactIntegrationText, safeMetadata } from "@medhus-ai/crewrun-plugin-sdk";

const MAX_BODY_BYTES = 1_000_000;

// A deliberately tiny public server. It exposes only provider callbacks and verified
// webhook endpoints; the CrewRun console remains on a separate private listener.
export function createIntegrationIngress({ plugins, state, configFor = () => ({}), onEvent = async () => {}, onConnectionConnected = async () => {}, publicBaseUrl = "", fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  if (!plugins?.get) throw new Error("createIntegrationIngress requires a plugin registry");
  if (!state?.consumeOAuthState || !state?.claimConnectionLease || !state?.releaseConnectionLease || !state?.ingestEvent) {
    throw new Error("createIntegrationIngress requires integration state");
  }
  const publicBase = normalizedPublicBase(publicBaseUrl);
  const connectionLocks = new Map();

  async function handle(request, response) {
    const url = new URL(request.url || "/", publicBase || "http://localhost");
    const route = routeFor(url.pathname);
    try {
      if (!route) return respond(response, 404, "Not found");
      const plugin = plugins.get(route.pluginId);
      if (!plugin) return respond(response, 404, "Unknown integration");
      if (route.kind === "oauth" && request.method === "GET") return await oauthCallback({ request, response, url, plugin, pluginId: route.pluginId });
      if (route.kind === "webhook" && request.method === "POST") return await webhook({ request, response, url, plugin, pluginId: route.pluginId, connectionId: route.connectionId });
      return respond(response, 405, "Method not allowed");
    } catch (error) {
      log(`[integrations] public ingress failed: ${safeError(error)}`);
      if (!response.headersSent) respond(response, 400, "Invalid integration request");
    }
  }

  async function oauthCallback({ response, url, plugin, pluginId }) {
    const code = String(url.searchParams.get("code") || "");
    // GitHub App setup callbacks carry an installation id rather than an OAuth code.
    // They still consume the same host-issued state, so installation setup remains
    // one-time and cannot attach a guessed installation to a later browser session.
    const installationId = String(url.searchParams.get("installation_id") || url.searchParams.get("installationId") || "");
    const providerError = String(url.searchParams.get("error") || "");
    const stateValue = String(url.searchParams.get("state") || "");
    const pending = state.consumeOAuthState(stateValue, { pluginId });
    if (!pending) return respond(response, 400, completionPage("Connection expired", "Start the connection again from CrewRun."), "text/html; charset=utf-8");
    if (providerError || (!code && !installationId)) return respond(response, 400, completionPage("Connection not completed", providerError || "The provider returned no authorization result."), "text/html; charset=utf-8");
    const adapter = plugin.adapter || {};
    if (typeof adapter.exchangeCode !== "function") throw new Error(`${pluginId} does not implement OAuth exchange`);
    const config = configFor(pluginId) || {};
    // Browser callbacks may arrive at nearly the same time (double-clicks, duplicate browser
    // windows, or a user reconnecting while an older consent tab returns). Serialize each
    // provider's persistence/replacement phase so a one-owner host cannot retire both records.
    return await withPluginConnectionLock(pluginId, async () => {
      // The in-process queue avoids needless conflicting callbacks in one server; the durable
      // SQLite lease covers two hosts sharing the same target root. Without it, both hosts can
      // exchange a code, save a new record, and each retire the other's only usable connection.
      const replacementLease = state.claimConnectionLease({ pluginId });
      if (!replacementLease) {
        return respond(response, 409, completionPage("Connection already in progress", "Another CrewRun host is finishing this provider connection. Start again from CrewRun if it does not complete."), "text/html; charset=utf-8");
      }
      try {
        const result = await adapter.exchangeCode({
          code, installationId, verifier: pending.verifier, redirectUri: oauthCallbackUrl(publicBase, pluginId),
          capabilities: pending.capabilities, clientId: config.clientId, clientSecret: config.clientSecret, config, ...config, fetch: fetchImpl
        });
        if (!result?.credentials || !result?.account) throw new Error(`${pluginId} did not return connection credentials and account metadata`);
        const usable = !result.status || result.status === "connected";
        const connection = state.saveConnection({
          pluginId, account: safeAccount(result.account), scopes: result.scopes || [], capabilities: pending.capabilities,
          credentials: result.credentials, status: usable ? "connected" : "needs_reconnect"
        });
        const discardConnection = async (reason) => {
          // A result can contain a valid token while still not be a usable connection (for
          // example, a provider may report a reconnect-required status). Keep such grants out
          // of the local active set and attempt the provider's narrow revoke before clearing it.
          const stored = state.getConnection(connection.id, { credentials: true }) || connection;
          try {
            await adapter.revoke?.({
              connection: stored,
              subscriptions: state.listSubscriptions({ connectionId: connection.id }),
              credentials: stored.credentials || result.credentials,
              config, ...config, fetch: fetchImpl
            });
          } catch (revokeError) {
            log(`[integrations] ${pluginId} failed connection cleanup: ${safeError(revokeError)}`);
          } finally {
            state.disconnectConnection(connection.id);
          }
          log(`[integrations] ${pluginId} ${reason}; the new authorization was removed`);
        };
        if (!usable) {
          await discardConnection("returned a non-connected OAuth result");
          return respond(response, 502, completionPage("Connection not completed", "CrewRun did not receive a usable provider connection. The new authorization was removed; try connecting again."), "text/html; charset=utf-8");
        }
        if (typeof adapter.subscribe === "function") {
          try {
            const subscriptions = await adapter.subscribe({ connection, credentials: result.credentials, config, ...config, publicBaseUrl: publicBase, fetch: fetchImpl });
            for (const subscription of Array.isArray(subscriptions) ? subscriptions : []) {
              state.upsertSubscription({ ...subscription, connectionId: connection.id });
            }
          } catch (error) {
            // Do not leave a locally active credential after provider event setup failed. A
            // successful replacement is the only path allowed to retire the prior connection.
            await discardConnection("subscription setup failed");
            log(`[integrations] ${pluginId} subscription setup error: ${safeError(error)}`);
            return respond(response, 502, completionPage("Connection not completed", "CrewRun could not finish the provider event setup. The new authorization was removed; try connecting again."), "text/html; charset=utf-8");
          }
        }
        // The reference host can impose a one-owner connection policy after every provider step
        // has succeeded. Keep this callback outside the generic ingress so other hosts remain
        // free to model multiple accounts explicitly.
        if (state.getConnection(connection.id)?.status === "connected") {
          await onConnectionConnected({ plugin, pluginId, connection: state.getConnection(connection.id), config });
        }
        return respond(response, 200, completionPage(`${plugin.label || pluginId} connected`, "You can return to the private CrewRun console."), "text/html; charset=utf-8");
      } finally {
        state.releaseConnectionLease(replacementLease);
      }
    });
  }

  async function webhook({ request, response, url, plugin, pluginId, connectionId }) {
    const rawBody = await readBody(request);
    const adapter = plugin.adapter || {};
    if (typeof adapter.verifyWebhook !== "function") return respond(response, 404, "Webhook is not enabled");
    const verified = await adapter.verifyWebhook({
      headers: request.headers, rawBody, query: Object.fromEntries(url.searchParams), connectionId: connectionId || "", config: configFor(pluginId) || {}, state, fetch: fetchImpl
    });
    if (!verified?.ok) return respond(response, Number(verified?.status) || 401, "Unauthorized");
    // Provider validation handshakes must not wait for persistence or model work.
    if (verified.challenge != null) return respond(response, 200, String(verified.challenge), verified.contentType || "text/plain; charset=utf-8");
    const events = Array.isArray(verified.events) ? verified.events : [];
    const accepted = [];
    for (const event of events) {
      const resolvedConnectionId = event.connectionId || connectionId || resolveConnectionId(pluginId, event);
      if (!resolvedConnectionId) continue; // A valid delivery for an unconnected account is harmlessly acknowledged.
      const connection = state.getConnection(resolvedConnectionId);
      if (!connection || connection.plugin !== pluginId || connection.status !== "connected") continue;
      const descriptor = (plugin.events || []).find((entry) => (typeof entry === "string" ? entry : entry.id) === event.type);
      // A provider application may be configured broadly, but an operator's Connect choice is
      // narrower. Keep an unselected event capability out of durable state and agent routing.
      if (descriptor?.capability && Array.isArray(connection.capabilities) && connection.capabilities.length && !connection.capabilities.includes(descriptor.capability)) continue;
      let normalized;
      try {
        normalized = normalizeWebhookEvent(plugin, event, resolvedConnectionId);
      } catch (error) {
        log(`[integrations] discarded invalid ${pluginId} event: ${safeError(error)}`);
        continue;
      }
      const saved = state.ingestEvent({
        connectionId: normalized.connectionId, providerEventId: normalized.providerEventId,
        type: normalized.type, resource: normalized.resource, summary: normalized.summary, rawPayload: rawBody, occurredAt: normalized.occurredAt
      });
      if (saved.created) accepted.push(saved.event);
    }
    // Acknowledge once the receipt is durable. No fetch, tool call, or agent turn happens
    // on the provider request path; post-ACK work runs in the host's queue.
    respond(response, 200, verified.responseBody || "");
    for (const event of accepted) {
      void Promise.resolve(onEvent(event)).catch((error) => log(`[integrations] event ${event.id} processing failed: ${safeError(error)}`));
    }
  }

  function resolveConnectionId(pluginId, event) {
    const matches = state.findConnections({ pluginId, accountId: event.accountId || "" });
    return matches.length === 1 ? matches[0].id : "";
  }

  async function withPluginConnectionLock(pluginId, work) {
    const previous = connectionLocks.get(pluginId) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    connectionLocks.set(pluginId, mine);
    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      release();
      if (connectionLocks.get(pluginId) === mine) connectionLocks.delete(pluginId);
    }
  }

  function listen({ port = 4411, host = "127.0.0.1" } = {}) {
    const listenHost = normalizedLoopbackHost(host);
    if (!listenHost) throw new Error("integration ingress must listen on a loopback address; publish it only through an operator-managed Funnel");
    const server = http.createServer((request, response) => { void handle(request, response); });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, listenHost, () => { server.off("error", reject); resolve(server); });
    });
  }

  return { handle, listen, oauthCallbackUrl: (pluginId) => oauthCallbackUrl(publicBase, pluginId), webhookUrl: (pluginId, connectionId = "") => webhookUrl(publicBase, pluginId, connectionId) };
}

export function oauthCallbackUrl(publicBaseUrl, pluginId) {
  return `${normalizedPublicBase(publicBaseUrl)}/integrations/oauth/${encodeURIComponent(pluginId)}/callback`;
}

export function webhookUrl(publicBaseUrl, pluginId, connectionId = "") {
  return `${normalizedPublicBase(publicBaseUrl)}/integrations/webhooks/${encodeURIComponent(pluginId)}${connectionId ? `/${encodeURIComponent(connectionId)}` : ""}`;
}

function routeFor(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "integrations") return null;
  if (parts.length === 4 && parts[1] === "oauth" && parts[3] === "callback") return { kind: "oauth", pluginId: decode(parts[2]) };
  if ((parts.length === 3 || parts.length === 4) && parts[1] === "webhooks") return { kind: "webhook", pluginId: decode(parts[2]), connectionId: parts[3] ? decode(parts[3]) : "" };
  return null;
}

function decode(value) { try { return decodeURIComponent(value); } catch { return ""; } }
function normalizedPublicBase(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("CREWRUN_PUBLIC_BASE_URL must be an https origin without a path");
  }
  if (url.protocol !== "https:") throw new Error("CREWRUN_PUBLIC_BASE_URL must use https");
  // This listener only routes absolute /integrations/... paths. A reverse-proxy prefix would
  // silently produce callback URLs the local listener cannot serve, so reject it rather than
  // accepting a broken or ambiguously routed public ingress configuration.
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("CREWRUN_PUBLIC_BASE_URL must be an https origin without a path, query, fragment, or credentials");
  }
  return url.origin;
}
function safeAccount(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  // Never place an arbitrary OAuth/profile response in the plaintext connection table.
  // Account metadata is deliberately just enough for a human to distinguish connections.
  const id = safeAccountText(source.id, 256);
  const label = safeAccountText(source.label, 256);
  const email = safeAccountText(source.email, 320);
  return { ...(id ? { id } : {}), ...(label ? { label } : {}), ...(email ? { email } : {}) };
}
function safeAccountText(value, maximum) {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, maximum) : "";
  return /^(?!.*(?:token|secret|password|bearer))[A-Za-z0-9@._:/+()' -]+$/i.test(text) ? text : "";
}
function normalizeWebhookEvent(plugin, event, connectionId) {
  const declared = new Set((plugin.events || []).map((entry) => typeof entry === "string" ? entry : entry.id));
  const type = String(event?.type || "").trim();
  const providerEventId = String(event?.providerEventId || event?.id || "").trim();
  if (!declared.has(type)) throw new Error("event type is not declared by this plugin");
  if (!/^[A-Za-z0-9_.:@/-]{1,512}$/.test(providerEventId)) throw new Error("provider event id is invalid");
  return {
    connectionId,
    providerEventId,
    type,
    resource: safeEventMetadata(event?.resource ?? event?.subject ?? {}),
    summary: safeEventMetadata(event?.summary ?? event?.metadata ?? {}),
    occurredAt: eventTimestamp(event?.occurredAt)
  };
}

// Provider adapters intentionally select harmless metadata (message subject, repository,
// channel, resource URL). This second check makes it impossible for a buggy adapter to persist
// a raw email body, document body, HTML, or entire webhook payload for an agent prompt.
function safeEventMetadata(value) {
  const metadata = safeMetadata(value && typeof value === "object" ? value : {});
  rejectContentLikeKeys(metadata);
  return metadata;
}
function rejectContentLikeKeys(value) {
  if (Array.isArray(value)) return value.forEach(rejectContentLikeKeys);
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:body|content|html|text|message|raw|payload|mime|blocks)$/i.test(key)) throw new Error(`event metadata field ${key} is not allowed`);
    rejectContentLikeKeys(item);
  }
}
function eventTimestamp(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}
function normalizedLoopbackHost(value) {
  const host = String(value || "").trim().toLowerCase();
  if (host === "[::1]") return "::1";
  return host === "127.0.0.1" || host === "localhost" || host === "::1" ? host : "";
}
function respond(response, status, body = "", contentType = "text/plain; charset=utf-8") {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}
function completionPage(title, detail) {
  return `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${escape(title)}</title><main><h1>${escape(title)}</h1><p>${escape(detail)}</p><p>You may close this tab.</p></main>`;
}
function escape(value) { return String(value || "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])); }
function safeError(error) { return redactIntegrationText(error?.message || "integration request failed", 1_000); }
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => { size += chunk.length; if (size > MAX_BODY_BYTES) { reject(new Error("request body is too large")); request.destroy(); } else chunks.push(chunk); });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
