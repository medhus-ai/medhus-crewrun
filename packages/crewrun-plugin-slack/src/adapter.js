import { oauthAuthorizationUrl } from "@medhus-ai/crewrun-plugin-sdk";

import { slackActions } from "./actions.js";

const SLACK_API = "https://slack.com/api";

// Host runtime values are supplied per call. The adapter never owns a client secret, credential
// vault, or global fetch implementation; it only transforms private OAuth credentials for the
// host and returns narrowly-shaped provider data to an already-authorized tool invocation.
export function createSlackAdapter({ fetch: defaultFetch = null, apiBase = SLACK_API } = {}) {
  const endpoint = String(apiBase || SLACK_API).replace(/\/+$/, "");
  const fetchFor = (value) => {
    const fetchFn = value || defaultFetch || globalThis.fetch;
    if (typeof fetchFn !== "function") throw new Error("fetch is required for the Slack provider adapter");
    return fetchFn;
  };

  async function authorizationUrl({ clientId, redirectUri, state, codeChallenge, capabilities, config = {} } = {}) {
    return oauthAuthorizationUrl({
      oauth: slackOAuth,
      clientId: required(clientId || config.clientId, "Slack clientId"),
      redirectUri,
      state,
      scopes: scopesForCapabilities(capabilities),
      // The host creates a verifier for every callback. Slack's v2 OAuth flow uses the
      // confidential client secret exchange instead, so deliberately omit that unused value.
      codeChallenge: undefined
    });
  }

  async function exchangeCode({ code, redirectUri, clientId, clientSecret, fetch: fetchFn, config = {} } = {}) {
    const response = await fetchFor(fetchFn)("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: required(clientId || config.clientId, "Slack clientId"),
        client_secret: required(clientSecret || config.clientSecret, "Slack clientSecret"),
        code: required(code, "Slack OAuth code"),
        redirect_uri: required(redirectUri, "redirectUri")
      }).toString()
    });
    const payload = await json(response, "Slack OAuth token exchange");
    if (!response.ok || payload.ok !== true) throw new Error(`Slack OAuth token exchange failed: ${String(payload.error || response.status || "unknown error")}`);
    return tokenResult(payload);
  }

  async function refreshCredentials({ credentials, clientId, clientSecret, fetch: fetchFn, config = {} } = {}) {
    const refreshToken = required(credentials?.refreshToken, "Slack refresh token");
    const response = await fetchFor(fetchFn)("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: required(clientId || config.clientId, "Slack clientId"),
        client_secret: required(clientSecret || config.clientSecret, "Slack clientSecret"),
        grant_type: "refresh_token",
        refresh_token: refreshToken
      }).toString()
    });
    const payload = await json(response, "Slack OAuth refresh");
    if (!response.ok || payload.ok !== true) throw new Error(`Slack OAuth refresh failed: ${String(payload.error || response.status || "unknown error")}`);
    return tokenResult(payload, credentials);
  }

  async function identifyAccount({ credentials, fetch: fetchFn } = {}) {
    const payload = await api("auth.test", { token: accessToken(credentials), fetchFn: fetchFor(fetchFn) });
    return {
      id: String(payload.team_id || payload.enterprise_id || ""),
      label: String(payload.team || payload.enterprise_name || ""),
      ...(payload.user_id ? { userId: String(payload.user_id) } : {}),
      ...(payload.user ? { userLabel: String(payload.user) } : {})
    };
  }

  async function invoke({ action, input = {}, credentials, clientId, clientSecret, fetch: fetchFn, config = {} } = {}) {
    const descriptor = slackActions.find((entry) => entry.id === String(action || ""));
    if (!descriptor) throw new Error(`unsupported Slack action: ${String(action || "<empty>")}`);
    const checked = descriptor.validate(input);
    if (!checked.ok) throw new Error(checked.error);
    const useFetch = fetchFor(fetchFn);
    let activeCredentials = credentials;
    if (needsRefresh(activeCredentials) && activeCredentials?.refreshToken) {
      const refreshed = await refreshCredentials({ credentials: activeCredentials, clientId, clientSecret, config, fetch: useFetch });
      activeCredentials = refreshed.credentials;
    }
    const token = accessToken(activeCredentials);
    const result = descriptor.id === "slack.getThread"
      ? await getThread({ token, input: checked.input, fetchFn: useFetch })
      : await postMessage({ token, input: checked.input, reply: descriptor.id === "slack.replyToMention", fetchFn: useFetch });
    return activeCredentials === credentials ? result : { result, credentials: activeCredentials };
  }

  async function subscribe() {
    // Slack Event Subscriptions are configured in the app manifest/admin UI, not through a
    // generic Web API endpoint. There is consequently no remote subscription record for the
    // host to persist or renew; the manifest's `subscription` descriptor explains the manual
    // setup to the operator.
    return [];
  }

  async function renew() {
    return [];
  }

  async function revoke({ credentials, fetch: fetchFn } = {}) {
    try {
      await api("auth.revoke", { token: accessToken(credentials), form: { test: "false" }, fetchFn: fetchFor(fetchFn) });
      return { revoked: true };
    } catch (error) {
      return { revoked: false, warning: String(error?.message || "Slack token revocation failed") };
    }
  }

  async function getThread({ token, input, fetchFn }) {
    const url = new URL(`${endpoint}/conversations.replies`);
    url.searchParams.set("channel", input.channel);
    url.searchParams.set("ts", input.threadTs);
    url.searchParams.set("limit", String(input.maxMessages));
    const response = await fetchFn(url, { headers: { authorization: `Bearer ${token}` } });
    const payload = await json(response, "Slack conversations.replies");
    if (!response.ok || payload.ok !== true) throw new Error(`Slack conversations.replies failed: ${String(payload.error || response.status || "unknown error")}`);
    return { channel: input.channel, messages: Array.isArray(payload.messages) ? payload.messages.slice(0, input.maxMessages).map(safeMessage) : [] };
  }

  async function postMessage({ token, input, reply, fetchFn }) {
    const body = { channel: input.channel, text: input.text, unfurl_links: false, unfurl_media: false };
    if (reply) body.thread_ts = input.threadTs;
    const payload = await api("chat.postMessage", { token, json: body, fetchFn });
    return {
      channel: String(payload.channel || input.channel),
      messageTs: String(payload.ts || ""),
      threadTs: String(payload.message?.thread_ts || (reply ? input.threadTs : payload.ts || ""))
    };
  }

  async function api(method, { token, form, json: jsonBody, fetchFn }) {
    const response = await fetchFn(`${endpoint}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${required(token, "Slack access token")}`,
        ...(jsonBody ? { "content-type": "application/json; charset=utf-8" } : { "content-type": "application/x-www-form-urlencoded" })
      },
      body: jsonBody ? JSON.stringify(jsonBody) : new URLSearchParams(form || {}).toString()
    });
    const payload = await json(response, `Slack ${method}`);
    if (!response.ok || payload.ok !== true) throw new Error(`Slack ${method} failed: ${String(payload.error || response.status || "unknown error")}`);
    return payload;
  }

  return { authorizationUrl, exchangeCode, refreshCredentials, identifyAccount, invoke, subscribe, renew, revoke };
}

export const slackOAuth = Object.freeze({
  authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
  tokenEndpoint: "https://slack.com/api/oauth.v2.access",
  scopeSeparator: ",",
  pkce: "none",
  defaultScopes: Object.freeze(["chat:write", "app_mentions:read", "channels:history"])
});

function scopesForCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) return slackOAuth.defaultScopes;
  const scopes = new Set();
  for (const capability of capabilities.map((value) => String(value || "").trim())) {
    if (capability === "messages") ["chat:write", "channels:history"].forEach((scope) => scopes.add(scope));
    if (capability === "mentions") ["chat:write", "app_mentions:read"].forEach((scope) => scopes.add(scope));
  }
  return scopes.size ? [...scopes] : slackOAuth.defaultScopes;
}

function tokenResult(payload, previous = {}) {
  const expiresAt = payload?.expires_in ? new Date(Date.now() + (Number(payload.expires_in) * 1000)).toISOString() : previous?.expiresAt;
  const scopes = Array.isArray(payload?.scope)
    ? payload.scope
    : String(payload?.scope || previous?.scopes || "").split(/[\s,]+/).filter(Boolean);
  return {
    // This nested value is host-private: the reference host writes it straight to the vault and
    // persists only account/scopes/expiry metadata in the durable connection record.
    credentials: {
      accessToken: required(payload?.access_token, "Slack access token"),
      ...(payload?.refresh_token || previous?.refreshToken ? { refreshToken: String(payload.refresh_token || previous.refreshToken) } : {}),
      ...(expiresAt ? { expiresAt } : {})
    },
    account: {
      ...(payload?.team?.id ? { id: String(payload.team.id) } : {}),
      ...(payload?.team?.name ? { label: String(payload.team.name) } : {})
    },
    scopes,
    ...(expiresAt ? { expiresAt } : {})
  };
}

function accessToken(credentials) {
  return required(credentials?.accessToken, "Slack access token");
}

function needsRefresh(credentials) {
  const expires = new Date(String(credentials?.expiresAt || "")).getTime();
  return Number.isFinite(expires) && expires <= Date.now() + 60_000;
}

function safeMessage(message) {
  return {
    ts: String(message?.ts || ""),
    threadTs: String(message?.thread_ts || message?.ts || ""),
    ...(message?.user ? { senderId: String(message.user) } : {}),
    ...(message?.bot_id ? { botId: String(message.bot_id) } : {}),
    text: typeof message?.text === "string" ? message.text.slice(0, 16_000) : ""
  };
}

async function json(response, label) {
  if (!response) throw new Error(`${label} did not return a response`);
  const payload = await response.json().catch(() => ({}));
  return payload && typeof payload === "object" ? payload : {};
}

function required(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required`);
  return text;
}
