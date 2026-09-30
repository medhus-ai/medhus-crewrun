import { randomBytes, randomUUID } from "node:crypto";

import { oauthAuthorizationUrl } from "@medhus-ai/crewrun-plugin-sdk";

import { googleWorkspaceActions } from "./actions.js";

const GOOGLE_API = "https://www.googleapis.com";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";

export const googleWorkspaceOAuth = Object.freeze({
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: GOOGLE_TOKEN,
  scopeSeparator: " ",
  pkce: "required",
  authorizationParams: { access_type: "offline", include_granted_scopes: "true" },
  defaultScopes: Object.freeze([
    "openid", "email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/spreadsheets"
  ])
});

// Credential-shaped values occur only in exchange/refresh inputs and their host-private result.
// Invocation outputs are sanitized records, never Google API envelopes or OAuth material.
export function createGoogleWorkspaceAdapter({ fetch: defaultFetch = null, apiBase = GOOGLE_API, now = Date.now } = {}) {
  const endpoint = String(apiBase || GOOGLE_API).replace(/\/+$/, "");
  const fetchFor = (value) => {
    const fetchFn = value || defaultFetch || globalThis.fetch;
    if (typeof fetchFn !== "function") throw new Error("fetch is required for the Google Workspace provider adapter");
    return fetchFn;
  };

  async function authorizationUrl({ clientId, redirectUri, state, codeChallenge, capabilities, config = {} } = {}) {
    return oauthAuthorizationUrl({
      oauth: googleWorkspaceOAuth,
      clientId: required(clientId || config.clientId, "Google clientId"),
      redirectUri,
      state,
      codeChallenge,
      scopes: scopesForCapabilities(capabilities)
    });
  }

  async function exchangeCode({ code, verifier, redirectUri, clientId, clientSecret, fetch: fetchFn, config = {} } = {}) {
    const useFetch = fetchFor(fetchFn);
    const result = await exchangeToken({
      grant_type: "authorization_code",
      code: required(code, "Google OAuth code"),
      code_verifier: required(verifier, "Google PKCE verifier"),
      redirect_uri: required(redirectUri, "redirectUri"),
      client_id: required(clientId || config.clientId, "Google clientId"),
      client_secret: required(clientSecret || config.clientSecret, "Google clientSecret")
    }, useFetch);
    return { ...result, account: await identifyAccount({ credentials: result.credentials, fetch: useFetch }) };
  }

  async function refreshCredentials({ credentials, connection, clientId, clientSecret, fetch: fetchFn, config = {} } = {}) {
    const result = await exchangeToken({
      grant_type: "refresh_token",
      refresh_token: required(credentials?.refreshToken, "Google refresh token"),
      client_id: required(clientId || config.clientId, "Google clientId"),
      client_secret: required(clientSecret || config.clientSecret, "Google clientSecret")
    }, fetchFor(fetchFn), { ...credentials, scopes: connection?.scopes || credentials?.scopes });
    return result;
  }

  async function identifyAccount({ credentials, fetch: fetchFn } = {}) {
    const response = await fetchFor(fetchFn)(`${endpoint}/oauth2/v3/userinfo`, {
      headers: { authorization: `Bearer ${accessToken(credentials)}` }
    });
    const payload = await parseJson(response);
    if (!response.ok || !payload?.sub) throw new Error("Google account identification failed");
    return {
      id: String(payload.sub),
      label: String(payload.name || payload.email || "Google Workspace account"),
      ...(payload.email ? { email: String(payload.email) } : {})
    };
  }

  async function invoke({ action, input = {}, credentials, connection, clientId, clientSecret, fetch: fetchFn, config = {} } = {}) {
    const descriptor = googleWorkspaceActions.find((entry) => entry.id === String(action || ""));
    if (!descriptor) throw new Error(`unsupported Google Workspace action: ${String(action || "<empty>")}`);
    const checked = descriptor.validate(input);
    if (!checked.ok) throw new Error(checked.error);
    const useFetch = fetchFor(fetchFn);
    let activeCredentials = credentials;
    if (needsRefresh(activeCredentials, now) && activeCredentials?.refreshToken) {
      const refreshed = await refreshCredentials({ credentials: activeCredentials, connection, clientId, clientSecret, config, fetch: useFetch });
      activeCredentials = refreshed.credentials;
    }
    const request = createApiRequest({ fetchFn: useFetch, token: accessToken(activeCredentials), endpoint });
    let result;
    switch (descriptor.id) {
      case "google-workspace.searchMail": result = await searchMail(request, checked.input); break;
      case "google-workspace.getMailMetadata": result = await getMailMetadata(request, checked.input); break;
      case "google-workspace.createMailDraft": result = await createMailDraft(request, checked.input); break;
      case "google-workspace.sendMailDraft": result = await sendMailDraft(request, checked.input); break;
      case "google-workspace.searchDrive": result = await searchDrive(request, checked.input); break;
      case "google-workspace.getDocument": result = await getDocument(request, checked.input); break;
      case "google-workspace.createDocument": result = await createDocument(request, checked.input); break;
      case "google-workspace.appendDocumentText": result = await appendDocumentText(request, checked.input); break;
      case "google-workspace.getSheetRange": result = await getSheetRange(request, checked.input); break;
      case "google-workspace.createSpreadsheet": result = await createSpreadsheet(request, checked.input); break;
      case "google-workspace.appendSheetRows": result = await appendSheetRows(request, checked.input); break;
      default: throw new Error(`unsupported Google Workspace action: ${descriptor.id}`);
    }
    return activeCredentials === credentials ? result : { result, credentials: activeCredentials };
  }

  async function subscribe(options = {}) {
    const { kind, credentials, connection, publicBaseUrl, webhookUrl, pubsubTopic, channelId, channelToken, labelIds, fetch: fetchFn, config = {} } = options;
    const requested = kind ? [String(kind)] : subscriptionKindsFor(connection);
    if (!requested.length) return [];
    const request = createApiRequest({ fetchFn: fetchFor(fetchFn), token: accessToken(credentials), endpoint });
    const connectionId = required(connection?.id, "connection.id");
    const subscriptions = [];
    if (requested.some((value) => value === "gmail" || value === "gmail-pubsub-watch")) {
      const topicName = String(pubsubTopic || config.gmailPubsubTopic || "").trim();
      if (topicName) subscriptions.push(await gmailSubscription({ request, connection, connectionId, topicName, labelIds: labelIds || config.gmailLabelIds }));
      else if (kind) throw new Error("Gmail Pub/Sub topic is required");
    }
    if (requested.some((value) => value === "drive" || value === "drive-changes-channel") && config.driveEvents !== false) {
      subscriptions.push(await driveSubscription({
        request, connectionId, publicBaseUrl, webhookUrl: webhookUrl || config.driveWebhookUrl,
        channelId: channelId || config.driveChannelId, channelToken: channelToken || config.driveChannelToken
      }));
    }
    return subscriptions;
  }

  async function renew({ subscription = {}, credentials, connection, publicBaseUrl, webhookUrl, channelId, channelToken, fetch: fetchFn, config = {} } = {}) {
    const providerKey = String(subscription.providerKey || subscription.kind || "");
    if (providerKey === "google-workspace.gmailMailboxChanged" || providerKey === "gmail-pubsub-watch") {
      return await subscribe({
        kind: "gmail-pubsub-watch", credentials, connection, publicBaseUrl,
        pubsubTopic: subscription.metadata?.topicName,
        labelIds: subscription.metadata?.labelIds,
        fetch: fetchFn, config
      });
    }
    if (providerKey === "google-workspace.driveChanged" || providerKey === "drive-changes-channel") {
      // A renewal gets a new provider channel and callback token. Never copy a persisted token
      // into configuration: a stale channel must not remain able to authenticate deliveries.
      const renewalConfig = { ...config, driveChannelId: channelId || "", driveChannelToken: channelToken || "" };
      const renewed = await subscribe({
        kind: "drive-changes-channel", credentials, connection, publicBaseUrl, webhookUrl,
        channelId, channelToken, fetch: fetchFn, config: renewalConfig
      });
      // Google lets a channel remain live after replacement. Stop the prior one only after the
      // new channel exists, and do not turn a successful renewal into a failed one if cleanup
      // races with Google expiry.
      await stopDriveChannel({
        request: createApiRequest({ fetchFn: fetchFor(fetchFn), token: accessToken(credentials), endpoint }),
        subscription
      }).catch(() => {});
      return renewed;
    }
    throw new Error(`unsupported Google Workspace subscription: ${providerKey || "<empty>"}`);
  }

  async function revoke({ credentials, subscriptions = [], fetch: fetchFn } = {}) {
    const useFetch = fetchFor(fetchFn);
    const bearer = optionalText(credentials?.accessToken);
    const request = bearer ? createApiRequest({ fetchFn: useFetch, token: bearer, endpoint }) : null;
    const warnings = [];

    for (const subscription of Array.isArray(subscriptions) ? subscriptions : []) {
      if (!request) {
        warnings.push(subscriptionLabel(subscription));
        continue;
      }
      try {
        if (!await stopGoogleSubscription({ request, subscription })) warnings.push(subscriptionLabel(subscription));
      } catch {
        warnings.push(subscriptionLabel(subscription));
      }
    }

    const revocationToken = optionalText(credentials?.refreshToken) || bearer;
    if (!revocationToken) return {
      revoked: false,
      warnings: uniqueWarnings([...warnings, "Google credentials were unavailable for revocation."])
    };
    try {
      const response = await useFetch(GOOGLE_REVOKE, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        // Prefer the refresh token so disconnect works even after the short-lived access token
        // has expired. Neither token is included in a return value or warning.
        body: new URLSearchParams({ token: revocationToken }).toString()
      });
      return response?.ok
        ? { revoked: true, ...(warnings.length ? { warnings: uniqueWarnings(warnings) } : {}) }
        : { revoked: false, warnings: uniqueWarnings([...warnings, "Google token revocation failed."]) };
    } catch {
      return { revoked: false, warnings: uniqueWarnings([...warnings, "Google token revocation failed."]) };
    }
  }

  async function exchangeToken(values, fetchFn, previous = {}) {
    const response = await fetchFn(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values).toString()
    });
    const payload = await parseJson(response);
    if (!response.ok || !payload?.access_token) throw new Error(`Google OAuth token exchange failed: ${String(payload?.error || response.status || "unknown error")}`);
    const expiresAt = payload.expires_in ? new Date(Number(now()) + (Number(payload.expires_in) * 1000)).toISOString() : previous.expiresAt;
    const scopes = String(payload.scope || previous.scopes || "").split(/\s+/).filter(Boolean);
    return {
      // Host-private credentials: store directly in the encrypted vault and never pass this
      // object to connectionMetadata(), a role, a console response, or audit output.
      credentials: {
        accessToken: String(payload.access_token),
        ...(payload.refresh_token || previous.refreshToken ? { refreshToken: String(payload.refresh_token || previous.refreshToken) } : {}),
        ...(payload.id_token ? { idToken: String(payload.id_token) } : {}),
        ...(expiresAt ? { expiresAt } : {})
      },
      scopes,
      ...(expiresAt ? { expiresAt } : {})
    };
  }

  return { authorizationUrl, exchangeCode, refreshCredentials, identifyAccount, invoke, subscribe, renew, revoke };
}

function createApiRequest({ fetchFn, token, endpoint }) {
  async function json(path, { method = "GET", query = {}, body } = {}) {
    const url = new URL(path, `${endpoint}/`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value == null) continue;
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
      else url.searchParams.set(key, String(value));
    }
    const response = await fetchFn(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body == null ? {} : { "content-type": "application/json" }) },
      ...(body == null ? {} : { body: JSON.stringify(body) })
    });
    const payload = await parseJson(response);
    if (!response.ok) throw new Error(`Google API ${method} ${url.pathname} failed (${response.status || "unknown"})`);
    return payload;
  }
  return { json };
}

async function gmailSubscription({ request, connection, connectionId, topicName, labelIds }) {
  const labels = Array.isArray(labelIds) ? labelIds.map((value) => String(value)).filter(Boolean).slice(0, 50) : [];
  const payload = await request.json("/gmail/v1/users/me/watch", {
    method: "POST",
    body: { topicName, ...(labels.length ? { labelIds: labels } : {}) }
  });
  return {
    id: `gmail-${connectionId}`,
    providerKey: "google-workspace.gmailMailboxChanged",
    resource: { kind: "gmail" },
    metadata: {
      topicName,
      historyId: String(payload.historyId || ""),
      accountId: String(connection?.account?.id || ""),
      ...(labels.length ? { labelIds: labels } : {})
    },
    expiresAt: epochMillis(payload.expiration),
    status: "active"
  };
}

async function driveSubscription({ request, connectionId, publicBaseUrl, webhookUrl, channelId, channelToken }) {
  const start = await request.json("/drive/v3/changes/startPageToken", { query: { supportsAllDrives: "false" } });
  const id = String(channelId || `crewrun-${connectionId}-${randomUUID()}`).slice(0, 256);
  const token = String(channelToken || randomBytes(32).toString("base64url"));
  const callback = String(webhookUrl || `${required(publicBaseUrl, "publicBaseUrl").replace(/\/$/, "")}/integrations/webhooks/google-workspace/${encodeURIComponent(connectionId)}`);
  const payload = await request.json(`/drive/v3/changes/watch?pageToken=${encodeURIComponent(required(start.startPageToken, "Google Drive start page token"))}`, {
    method: "POST",
    body: { id, type: "web_hook", address: callback, token }
  });
  return {
    id: `drive-${connectionId}`,
    providerKey: "google-workspace.driveChanged",
    resource: { kind: "drive" },
    metadata: { channelId: String(payload.id || id), resourceId: String(payload.resourceId || "") },
    // The host state encrypts this field at rest. It is intentionally not console metadata,
    // a provider event, or a return value of a role-facing tool.
    secret: { channelToken: token, startPageToken: String(start.startPageToken) },
    expiresAt: epochMillis(payload.expiration),
    status: "active"
  };
}

async function stopGoogleSubscription({ request, subscription = {} }) {
  const providerKey = String(subscription?.providerKey || subscription?.kind || "");
  if (providerKey === "google-workspace.gmailMailboxChanged" || providerKey === "gmail-pubsub-watch") {
    await request.json("/gmail/v1/users/me/stop", { method: "POST", body: {} });
    return true;
  }
  if (providerKey === "google-workspace.driveChanged" || providerKey === "drive-changes-channel") {
    return await stopDriveChannel({ request, subscription });
  }
  return false;
}

async function stopDriveChannel({ request, subscription = {} }) {
  const channelId = optionalText(subscription?.metadata?.channelId || subscription?.channelId);
  const resourceId = optionalText(subscription?.metadata?.resourceId || subscription?.resourceId);
  if (!channelId || !resourceId) return false;
  await request.json("/drive/v3/channels/stop", { method: "POST", body: { id: channelId, resourceId } });
  return true;
}

function subscriptionLabel(subscription = {}) {
  return String(subscription?.providerKey || subscription?.kind || "Google subscription") === "google-workspace.driveChanged"
    ? "Google Drive change channel could not be stopped remotely."
    : "Google Gmail watch could not be stopped remotely.";
}

function uniqueWarnings(warnings) {
  return [...new Set((Array.isArray(warnings) ? warnings : []).map((warning) => String(warning || "").trim()).filter(Boolean))];
}

async function searchMail(request, input) {
  const payload = await request.json("/gmail/v1/users/me/messages", { query: { q: input.query, maxResults: input.maxResults } });
  return { messages: Array.isArray(payload.messages) ? payload.messages.slice(0, input.maxResults).map((message) => ({ id: String(message.id || ""), threadId: String(message.threadId || "") })) : [] };
}

async function getMailMetadata(request, input) {
  const payload = await request.json(`/gmail/v1/users/me/messages/${encodeURIComponent(input.messageId)}`, {
    query: { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] }
  });
  const headers = Array.isArray(payload.payload?.headers) ? payload.payload.headers : [];
  const lookup = (name) => String(headers.find((header) => String(header?.name || "").toLowerCase() === name.toLowerCase())?.value || "").slice(0, 2048);
  return {
    id: String(payload.id || input.messageId),
    threadId: String(payload.threadId || ""),
    labelIds: Array.isArray(payload.labelIds) ? payload.labelIds.map((value) => String(value)).slice(0, 50) : [],
    internalDate: String(payload.internalDate || ""),
    headers: { from: lookup("From"), to: lookup("To"), subject: lookup("Subject"), date: lookup("Date") }
  };
}

async function createMailDraft(request, input) {
  const raw = encodeBase64Url(`To: ${input.to.join(", ")}\r\nSubject: ${input.subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${input.text}`);
  const payload = await request.json("/gmail/v1/users/me/drafts", { method: "POST", body: { message: { raw } } });
  return { draftId: String(payload.id || ""), messageId: String(payload.message?.id || ""), threadId: String(payload.message?.threadId || "") };
}

async function sendMailDraft(request, input) {
  const payload = await request.json(`/gmail/v1/users/me/drafts/${encodeURIComponent(input.draftId)}/send`, { method: "POST", body: {} });
  return { id: String(payload.id || ""), threadId: String(payload.threadId || ""), labelIds: Array.isArray(payload.labelIds) ? payload.labelIds.map(String).slice(0, 50) : [] };
}

async function searchDrive(request, input) {
  const query = `fullText contains '${input.query.replace(/'/g, "\\'")}' and trashed = false`;
  const payload = await request.json("/drive/v3/files", {
    query: { q: query, pageSize: input.maxResults, fields: "files(id,name,mimeType,modifiedTime,webViewLink)" }
  });
  return {
    files: Array.isArray(payload.files) ? payload.files.slice(0, input.maxResults).map((file) => ({
      id: String(file.id || ""), name: String(file.name || ""), mimeType: String(file.mimeType || ""), modifiedAt: String(file.modifiedTime || ""), ...(file.webViewLink ? { url: String(file.webViewLink) } : {})
    })) : []
  };
}

async function getDocument(request, input) {
  const payload = await request.json(`/v1/documents/${encodeURIComponent(input.documentId)}`);
  return { documentId: String(payload.documentId || input.documentId), title: String(payload.title || ""), text: documentText(payload.body?.content) };
}

async function createDocument(request, input) {
  const payload = await request.json("/v1/documents", { method: "POST", body: { title: input.title } });
  return { documentId: String(payload.documentId || ""), title: String(payload.title || input.title) };
}

async function appendDocumentText(request, input) {
  const document = await request.json(`/v1/documents/${encodeURIComponent(input.documentId)}`);
  const content = Array.isArray(document.body?.content) ? document.body.content : [];
  const endIndex = content.reduce((largest, item) => Math.max(largest, Number(item?.endIndex) || 1), 1);
  await request.json(`/v1/documents/${encodeURIComponent(input.documentId)}:batchUpdate`, {
    method: "POST",
    body: { requests: [{ insertText: { location: { index: Math.max(1, endIndex - 1) }, text: input.text } }] }
  });
  return { documentId: input.documentId, appendedCharacters: input.text.length };
}

async function getSheetRange(request, input) {
  const payload = await request.json(`/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.range)}`);
  return { spreadsheetId: input.spreadsheetId, range: String(payload.range || input.range), majorDimension: String(payload.majorDimension || "ROWS"), values: clipCells(payload.values) };
}

async function createSpreadsheet(request, input) {
  const payload = await request.json("/v4/spreadsheets", { method: "POST", body: { properties: { title: input.title } } });
  return { spreadsheetId: String(payload.spreadsheetId || ""), title: String(payload.properties?.title || input.title), ...(payload.spreadsheetUrl ? { url: String(payload.spreadsheetUrl) } : {}) };
}

async function appendSheetRows(request, input) {
  const payload = await request.json(`/v4/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.range)}:append`, {
    method: "POST",
    // Values stay values; roles cannot turn an approved row append into a formula execution or
    // an IMPORT*/external-reference request by prefixing a cell with "=".
    query: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
    body: { majorDimension: "ROWS", values: input.rows }
  });
  const updates = payload.updates || {};
  return { spreadsheetId: input.spreadsheetId, updatedRange: String(updates.updatedRange || ""), updatedRows: Number(updates.updatedRows || 0), updatedCells: Number(updates.updatedCells || 0) };
}

function scopesForCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) return googleWorkspaceOAuth.defaultScopes;
  const scopes = new Set(["openid", "email"]);
  const map = {
    "gmail-read": "https://www.googleapis.com/auth/gmail.readonly",
    "gmail-send": "https://www.googleapis.com/auth/gmail.compose",
    drive: "https://www.googleapis.com/auth/drive.metadata.readonly",
    "docs-read": "https://www.googleapis.com/auth/documents.readonly",
    "docs-write": "https://www.googleapis.com/auth/documents",
    "sheets-read": "https://www.googleapis.com/auth/spreadsheets.readonly",
    "sheets-write": "https://www.googleapis.com/auth/spreadsheets"
  };
  for (const capability of capabilities) if (map[String(capability || "").trim()]) scopes.add(map[String(capability).trim()]);
  return [...scopes];
}

function subscriptionKindsFor(connection = {}) {
  // A connection's granted capabilities are the host's authority boundary. Do not attempt a
  // Drive watch merely because the plugin supports one: a Gmail-only or Docs-only connection
  // should finish OAuth successfully without requiring unrelated Drive scope.
  if (!Array.isArray(connection?.capabilities) || connection.capabilities.length === 0) {
    return ["gmail-pubsub-watch", "drive-changes-channel"];
  }
  const capabilities = new Set(connection.capabilities.map((value) => String(value || "").trim()));
  return [
    ...(capabilities.has("gmail-read") ? ["gmail-pubsub-watch"] : []),
    ...(capabilities.has("drive") ? ["drive-changes-channel"] : [])
  ];
}

function documentText(content) {
  let text = "";
  for (const element of Array.isArray(content) ? content : []) {
    for (const child of element?.paragraph?.elements || []) {
      if (typeof child?.textRun?.content === "string") text += child.textRun.content;
      if (text.length >= 60_000) return text.slice(0, 60_000);
    }
  }
  return text.slice(0, 60_000);
}

function clipCells(values) {
  const rows = [];
  let count = 0;
  for (const row of Array.isArray(values) ? values : []) {
    if (!Array.isArray(row) || rows.length >= 1_000) break;
    const cells = [];
    for (const value of row) {
      if (count >= 10_000) break;
      cells.push(typeof value === "string" ? value.slice(0, 10_000) : value == null ? "" : String(value));
      count += 1;
    }
    rows.push(cells);
    if (count >= 10_000) break;
  }
  return rows;
}

function encodeBase64Url(value) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function epochMillis(value) {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.trunc(milliseconds) : null;
}

function accessToken(credentials) {
  return required(credentials?.accessToken, "Google access token");
}

function needsRefresh(credentials, clock) {
  const expires = new Date(String(credentials?.expiresAt || "")).getTime();
  return Number.isFinite(expires) && expires <= Number(clock()) + 60_000;
}

async function parseJson(response) {
  if (!response) throw new Error("provider did not return a response");
  const payload = await response.json().catch(() => ({}));
  return payload && typeof payload === "object" ? payload : {};
}

function required(value, name) {
  const text = optionalText(value);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function optionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}
