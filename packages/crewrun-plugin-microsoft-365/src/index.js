import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { defineIntegrationPlugin, oauthAuthorizationUrl } from "@medhus-ai/crewrun-plugin-sdk";

const GRAPH_URL = "https://graph.microsoft.com/v1.0";
const MAX_QUERY = 500;
const MAX_TEXT = 50_000;
const MAX_FILE_CONTENT = 256_000;
const MAX_VALUES = 10_000;
// Graph lifts values below 45 minutes to 45 minutes and some Teams resources require a
// lifecycle endpoint above one hour. Keep renewal safely between those limits so one common
// renewal path stays valid for every curated event type.
const GRAPH_RENEWAL_LIFETIME_MS = 55 * 60 * 1000;
const OPAQUE_ID = /^[A-Za-z0-9._~!$&'()*+,;=:@-]{1,1024}$/;
const FILE_NAME = /^[^/\\\u0000-\u001f]{1,128}$/;
const RANGE = /^[A-Za-z]{1,3}[1-9]\d{0,5}(?::[A-Za-z]{1,3}[1-9]\d{0,5})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BASE_SCOPES = Object.freeze(["openid", "profile", "offline_access", "User.Read"]);

export const microsoft365Capabilities = Object.freeze([
  Object.freeze({
    id: "outlook",
    label: "Outlook mail",
    description: "Read selected messages and create or send plain-text drafts.",
    direction: "both",
    scopes: ["Mail.Read", "Mail.ReadWrite", "Mail.Send"]
  }),
  Object.freeze({
    id: "onedrive",
    label: "OneDrive files",
    description: "Search, inspect, and create small text files in the connected user's OneDrive.",
    direction: "both",
    scopes: ["Files.Read", "Files.ReadWrite"]
  }),
  Object.freeze({
    id: "excel",
    label: "Excel",
    description: "Read or update bounded worksheet ranges in OneDrive-hosted workbooks.",
    direction: "both",
    scopes: ["Files.Read", "Files.ReadWrite"]
  }),
  Object.freeze({
    id: "teams",
    label: "Microsoft Teams",
    description: "Read selected channel messages and post plain-text channel messages.",
    direction: "both",
    scopes: ["ChannelMessage.Read.All", "ChannelMessage.Send", "Team.ReadBasic.All"]
  })
]);

export const microsoft365Actions = Object.freeze([
  action({
    id: "microsoft365.searchMail", capability: "outlook", label: "Search Outlook mail",
    description: "Search the connected mailbox and return selected message metadata.", risk: "read", scopes: ["Mail.Read"],
    inputSchema: (z) => ({ query: z.string(), maxResults: z.number().int().min(1).max(25).optional() }), validate: validateSearchMail
  }),
  action({
    id: "microsoft365.getMail", capability: "outlook", label: "Get Outlook mail",
    description: "Read one selected Outlook message.", risk: "read", scopes: ["Mail.Read"],
    inputSchema: (z) => ({ messageId: z.string() }), validate: validateGetMail
  }),
  action({
    id: "microsoft365.createMailDraft", capability: "outlook", label: "Create Outlook draft",
    description: "Create a plain-text Outlook draft. This changes an external account and requires approval.", risk: "external-write", approval: "required", scopes: ["Mail.ReadWrite"],
    inputSchema: (z) => ({ to: z.array(z.string()), subject: z.string(), body: z.string() }), validate: validateCreateMailDraft
  }),
  action({
    id: "microsoft365.sendMailDraft", capability: "outlook", label: "Send Outlook draft",
    description: "Send one existing Outlook draft by opaque id. Delivery requires approval.", risk: "external-write", approval: "required", scopes: ["Mail.Send"],
    inputSchema: (z) => ({ messageId: z.string() }), validate: validateGetMail
  }),
  action({
    id: "microsoft365.searchDriveItems", capability: "onedrive", label: "Search OneDrive files",
    description: "Search file metadata in the connected user's OneDrive.", risk: "read", scopes: ["Files.Read"],
    inputSchema: (z) => ({ query: z.string(), maxResults: z.number().int().min(1).max(25).optional() }), validate: validateSearchDriveItems
  }),
  action({
    id: "microsoft365.getDriveItem", capability: "onedrive", label: "Get OneDrive file metadata",
    description: "Get metadata for one selected OneDrive item.", risk: "read", scopes: ["Files.Read"],
    inputSchema: (z) => ({ itemId: z.string() }), validate: validateGetDriveItem
  }),
  action({
    id: "microsoft365.createTextFile", capability: "onedrive", label: "Create OneDrive text file",
    description: "Create a new bounded plain-text OneDrive file without replacing an existing file. This external write requires approval.", risk: "external-write", approval: "required", scopes: ["Files.ReadWrite"],
    inputSchema: (z) => ({ parentItemId: z.string(), name: z.string(), content: z.string() }), validate: validateCreateTextFile
  }),
  action({
    id: "microsoft365.getWorkbookRange", capability: "excel", label: "Read Excel range",
    description: "Read a bounded A1 range from a selected OneDrive-hosted workbook.", risk: "read", scopes: ["Files.Read"],
    inputSchema: (z) => ({ itemId: z.string(), worksheet: z.string(), range: z.string() }), validate: validateWorkbookRange
  }),
  action({
    id: "microsoft365.updateWorkbookRange", capability: "excel", label: "Update Excel range",
    description: "Replace plain values in a bounded A1 range; formulas are not accepted. This external write requires approval.", risk: "external-write", approval: "required", scopes: ["Files.ReadWrite"],
    inputSchema: (z) => ({ itemId: z.string(), worksheet: z.string(), range: z.string(), values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))) }), validate: validateUpdateWorkbookRange
  }),
  action({
    id: "microsoft365.listTeamsChannelMessages", capability: "teams", label: "List Teams channel messages",
    description: "Read a bounded list of messages from one selected Teams channel.", risk: "read", scopes: ["ChannelMessage.Read.All"],
    inputSchema: (z) => ({ teamId: z.string(), channelId: z.string(), maxResults: z.number().int().min(1).max(25).optional() }), validate: validateTeamsChannel
  }),
  action({
    id: "microsoft365.postTeamsChannelMessage", capability: "teams", label: "Post Teams channel message",
    description: "Post one plain-text message to a selected Teams channel. Delivery requires approval.", risk: "external-write", approval: "required", scopes: ["ChannelMessage.Send"],
    inputSchema: (z) => ({ teamId: z.string(), channelId: z.string(), text: z.string() }), validate: validatePostTeamsChannelMessage
  })
]);

export const microsoft365Events = Object.freeze([
  event({ id: "microsoft365.outlookMessageCreated", capability: "outlook", label: "New Outlook mail", scopes: ["Mail.Read"], resource: "/me/mailFolders('Inbox')/messages", changeType: "created" }),
  event({ id: "microsoft365.onedriveItemCreated", capability: "onedrive", label: "New OneDrive file", scopes: ["Files.Read"], resource: "/me/drive/root", changeType: "created" }),
  event({ id: "microsoft365.onedriveItemUpdated", capability: "onedrive", label: "Changed OneDrive file", scopes: ["Files.Read"], resource: "/me/drive/root", changeType: "updated" }),
  event({ id: "microsoft365.teamsChannelMessageCreated", capability: "teams", label: "New Teams channel message", scopes: ["ChannelMessage.Read.All"], resourceTemplate: "/teams/{teamId}/channels/{channelId}/messages", changeType: "created" })
]);

export const microsoft365Subscription = Object.freeze({
  provider: "microsoft-graph",
  webhookPath: "/integrations/webhooks/microsoft365/{connectionId}",
  validation: "Echo the validationToken query value as plain text before processing notifications.",
  clientState: "A per-subscription opaque host secret must be checked in constant time.",
  renewal: "Graph subscriptions expire; the host renews them with a fresh, Graph-valid future expiration.",
  retention: "metadata"
});

export const microsoft365OAuth = Object.freeze({
  authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  defaultScopes: BASE_SCOPES,
  scopeSeparator: " ",
  pkce: "required",
  authorizationParams: { response_mode: "query", prompt: "select_account" }
});

// The host chooses capabilities before redirecting. OAuth receives the corresponding bounded
// delegated scopes rather than asking for a blanket Graph scope or a raw provider escape hatch.
export function microsoftScopesForCapabilities(capabilities) {
  const selected = Array.isArray(capabilities)
    ? new Set(capabilities.map((capability) => String(capability || "").trim()).filter(Boolean))
    : new Set();
  const enabled = selected.size ? microsoft365Capabilities.filter((capability) => selected.has(capability.id)) : microsoft365Capabilities;
  return [...new Set([...BASE_SCOPES, ...enabled.flatMap((capability) => capability.scopes)])];
}

export function createMicrosoft365Plugin(options = {}) {
  return defineIntegrationPlugin({
    apiVersion: "crewrun.integration/v1",
    id: "microsoft365",
    label: "Microsoft 365",
    description: "Governed delegated Microsoft Graph access for Outlook, OneDrive, Excel, and Teams.",
    oauth: microsoft365OAuth,
    capabilities: microsoft365Capabilities,
    actions: microsoft365Actions,
    events: microsoft365Events,
    subscription: microsoft365Subscription,
    metadata: {
      connectionKind: "delegated-oauth",
      supportedAccounts: ["personal", "work-or-school"],
      unsupported: ["SharePoint", "tenant-wide application permissions", "raw Graph requests"]
    },
    adapter: createMicrosoft365Adapter(options)
  });
}

// This default contains no app credentials. A host constructs a configured instance with
// createMicrosoft365Plugin({ clientId, clientSecret, fetch }) and keeps those values private.
export const microsoft365Plugin = createMicrosoft365Plugin();
export default microsoft365Plugin;

// The adapter receives dependencies from the host. It does not read environment variables,
// expose an access token, or retain OAuth client credentials in any console-facing object.
export function createMicrosoft365Adapter({ fetch: defaultFetch = globalThis.fetch, clientId = "", clientSecret = "", graphUrl = GRAPH_URL, now = Date.now } = {}) {
  async function authorizationUrl({ redirectUri, state, scopes, capabilities, codeChallenge, clientId: requestedClientId, config = {} } = {}) {
    const runtime = adapterConfig({ config, clientId: requestedClientId });
    return oauthAuthorizationUrl({
      oauth: microsoft365OAuth,
      clientId: requiredText(runtime.clientId || clientId, "Microsoft 365 clientId", 1_024),
      redirectUri,
      state,
      scopes: Array.isArray(scopes) && scopes.length ? scopes : microsoftScopesForCapabilities(capabilities),
      codeChallenge
    });
  }

  async function exchangeCode({ code, verifier, redirectUri, clientId: requestedClientId, clientSecret: requestedClientSecret, fetch, graphUrl: requestedGraphUrl, tokenEndpoint: requestedTokenEndpoint, config = {} } = {}) {
    const runtime = adapterConfig({ config, clientId: requestedClientId, clientSecret: requestedClientSecret, fetch, graphUrl: requestedGraphUrl, tokenEndpoint: requestedTokenEndpoint });
    const payload = await microsoftTokenRequest({
      fetch: runtime.fetch || defaultFetch,
      clientId: runtime.clientId || clientId,
      clientSecret: runtime.clientSecret || clientSecret,
      tokenEndpoint: runtime.tokenEndpoint,
      grant_type: "authorization_code",
      code: requiredText(code, "Microsoft 365 OAuth code", 8_192),
      redirect_uri: requiredText(redirectUri, "redirectUri", 2_048),
      code_verifier: requiredText(verifier, "PKCE verifier", 8_192)
    });
    const credentials = microsoftCredentials(payload);
    const account = await identifyAccount({ credentials, fetch: runtime.fetch || defaultFetch, config: runtime });
    return { credentials, account, scopes: microsoftScopes(payload), status: "connected" };
  }

  async function refreshCredentials({ credentials, connection, clientId: requestedClientId, clientSecret: requestedClientSecret, fetch, tokenEndpoint: requestedTokenEndpoint, config = {} } = {}) {
    const runtime = adapterConfig({ config, clientId: requestedClientId, clientSecret: requestedClientSecret, fetch, tokenEndpoint: requestedTokenEndpoint });
    const privateCredentials = privateCredentialsFor({ credentials, connection, config });
    const payload = await microsoftTokenRequest({
      fetch: runtime.fetch || defaultFetch,
      clientId: runtime.clientId || clientId,
      clientSecret: runtime.clientSecret || clientSecret,
      tokenEndpoint: runtime.tokenEndpoint,
      grant_type: "refresh_token",
      refresh_token: requiredText(privateCredentials.refreshToken, "Microsoft 365 refresh token", 16_384)
    });
    return microsoftCredentials(payload, privateCredentials);
  }

  async function identifyAccount({ credentials, connection, fetch, graphUrl: requestedGraphUrl, config = {} } = {}) {
    const runtime = adapterConfig({ config, fetch, graphUrl: requestedGraphUrl });
    const privateCredentials = privateCredentialsFor({ credentials, connection, config });
    const account = await graphRequest({
      fetch: runtime.fetch || defaultFetch,
      accessTokenFor: async () => privateCredentials.accessToken,
      connectionId: connection?.id || "identity",
      graphUrl: runtime.graphUrl || graphUrl,
      path: "/me?$select=id,displayName,mail,userPrincipalName"
    });
    return {
      id: text(account?.id, 256),
      label: text(account?.displayName, 256) || text(account?.mail, 320) || text(account?.userPrincipalName, 320),
      ...(text(account?.mail, 320) || text(account?.userPrincipalName, 320) ? { email: text(account?.mail, 320) || text(account?.userPrincipalName, 320) } : {})
    };
  }

  async function invoke({ connection, credentials, action, input = {}, fetch, graphUrl: requestedGraphUrl, config = {} } = {}) {
    const runtime = adapterConfig({ config, fetch, graphUrl: requestedGraphUrl });
    const privateCredentials = privateCredentialsFor({ credentials, connection, config });
    return await invokeMicrosoft365Action({
      action,
      connectionId: connection?.id || "connection",
      input,
      fetch: runtime.fetch || defaultFetch,
      graphUrl: runtime.graphUrl || graphUrl,
      accessTokenFor: async () => privateCredentials.accessToken
    });
  }

  async function subscribe({ connection, credentials, publicBaseUrl, fetch, graphUrl: requestedGraphUrl, config = {}, eventIds = null, resourceFor, clientStateFor } = {}) {
    const runtime = adapterConfig({ config, fetch, graphUrl: requestedGraphUrl });
    const privateCredentials = privateCredentialsFor({ credentials, connection, config });
    const connectionId = requiredText(connection?.id, "connection.id", 256);
    const webhookUrl = `${httpsUrl(publicBaseUrl, "publicBaseUrl").replace(/\/$/, "")}/integrations/webhooks/microsoft365/${encodeURIComponent(connectionId)}`;
    const selectedCapabilities = new Set(Array.isArray(connection?.capabilities)
      ? connection.capabilities.map((capability) => text(capability, 64)).filter(Boolean)
      : []);
    // Connect-time subscriptions follow the explicit OAuth capability selection. Only events
    // with a concrete resource are automatic: Teams needs an operator-selected team/channel
    // resource, so its template can never turn a normal connection into a failed OAuth flow.
    const defaults = microsoft365Events
      .filter((event) => event.resource && (!selectedCapabilities.size || selectedCapabilities.has(event.capability)))
      .map((event) => event.id);
    const requested = [...new Set(Array.isArray(eventIds) ? eventIds.map((id) => text(id, 128)).filter(Boolean) : defaults)];
    const result = [];
    for (const eventId of requested) {
      const descriptor = microsoft365Events.find((event) => event.id === eventId);
      if (!descriptor) continue;
      if (selectedCapabilities.size && !selectedCapabilities.has(descriptor.capability)) continue;
      const resource = typeof resourceFor === "function" ? await resourceFor({ connectionId, eventId }) : "";
      if (descriptor.resourceTemplate && !resource) continue;
      const clientState = typeof clientStateFor === "function" ? await clientStateFor({ connectionId, eventId }) : randomBytes(32).toString("base64url");
      const subscription = await subscribeMicrosoft365({
        eventId,
        connectionId,
        notificationUrl: webhookUrl,
        clientState,
        resource,
        fetch: runtime.fetch || defaultFetch,
        graphUrl: runtime.graphUrl || graphUrl,
        accessTokenFor: async () => privateCredentials.accessToken
      });
      result.push({
        id: subscription.id,
        providerKey: eventId,
        resource: { graph: subscription.resource },
        metadata: { eventId, changeType: subscription.changeType },
        secret: clientState,
        expiresAt: Date.parse(subscription.expiresAt),
        status: "active"
      });
    }
    return result;
  }

  async function renew({ subscription, connection, credentials, fetch, graphUrl: requestedGraphUrl, config = {} } = {}) {
    const runtime = adapterConfig({ config, fetch, graphUrl: requestedGraphUrl });
    const privateCredentials = privateCredentialsFor({ credentials, connection, config });
    const value = await renewMicrosoft365Subscription({
      subscriptionId: subscription?.id,
      connectionId: connection?.id,
      fetch: runtime.fetch || defaultFetch,
      graphUrl: runtime.graphUrl || graphUrl,
      accessTokenFor: async () => privateCredentials.accessToken,
      now
    });
    return { ...subscription, id: value.id, expiresAt: Date.parse(value.expiresAt), status: "active" };
  }

  async function revoke({ subscriptions = [], connection, credentials, fetch, graphUrl: requestedGraphUrl, config = {} } = {}) {
    const runtime = adapterConfig({ config, fetch, graphUrl: requestedGraphUrl });
    const privateCredentials = privateCredentialsFor({ credentials, connection, config });
    return await disconnectMicrosoft365({
      subscriptionIds: subscriptions.map((subscription) => typeof subscription === "string" ? subscription : subscription?.id).filter(Boolean),
      connectionId: connection?.id,
      fetch: runtime.fetch || defaultFetch,
      graphUrl: runtime.graphUrl || graphUrl,
      accessTokenFor: async () => privateCredentials.accessToken
    });
  }

  function verifyWebhook(request = {}) {
    // A host must resolve this from encrypted subscription state. The fallback exists only for
    // narrowly scoped tests or a single static development subscription, never for production.
    const configured = request?.config?.clientState;
    const stateResolver = typeof request?.state?.getSubscriptionSecret === "function"
      ? (subscriptionId) => request.state.getSubscriptionSecret({ provider: "microsoft365", subscriptionId, connectionId: request.connectionId || "" })
      : null;
    return verifyMicrosoft365Webhook({
      ...request,
      resolveClientState: request.resolveClientState ?? request?.config?.resolveClientState ?? stateResolver,
      clientState: configured
    });
  }

  function adapterConfig({ config = {}, clientId: requestedClientId = "", clientSecret: requestedClientSecret = "", fetch, graphUrl: requestedGraphUrl = "", tokenEndpoint: requestedTokenEndpoint = "" } = {}) {
    const source = config && typeof config === "object" && !Array.isArray(config) ? config : {};
    return {
      clientId: text(requestedClientId, 1_024) || text(source.clientId, 1_024),
      clientSecret: text(requestedClientSecret, 8_192) || text(source.clientSecret, 8_192),
      ...(typeof fetch === "function" ? { fetch } : typeof source.fetch === "function" ? { fetch: source.fetch } : {}),
      ...(text(requestedGraphUrl || source.graphUrl || source.graphBaseUrl, 2_048) ? { graphUrl: text(requestedGraphUrl || source.graphUrl || source.graphBaseUrl, 2_048) } : {}),
      ...(text(requestedTokenEndpoint || source.tokenEndpoint, 2_048) ? { tokenEndpoint: text(requestedTokenEndpoint || source.tokenEndpoint, 2_048) } : {})
    };
  }

  return { authorizationUrl, exchangeCode, refreshCredentials, identifyAccount, invoke, verifyWebhook, normalizeEvent: normalizeMicrosoft365Event, subscribe, renew, revoke };
}

// Graph returns validationToken before it starts sending notifications. This result is designed
// for an HTTP adapter: return `response` immediately, then enqueue the safe `events` separately.
// `resolveClientState` is a vault-backed host callback; neither its value nor Graph's supplied
// clientState is returned to a role, audit record, or console snapshot.
export function verifyMicrosoft365Webhook({ query = {}, body, rawBody, connectionId = "", resolveClientState, clientState } = {}) {
  const validationToken = text(queryValue(query, "validationToken"), 8_192);
  if (validationToken) {
    return {
      ok: true,
      kind: "validation",
      events: [],
      challenge: validationToken,
      contentType: "text/plain; charset=utf-8"
    };
  }

  const payload = parseWebhookBody(body ?? rawBody);
  const notifications = Array.isArray(payload?.value) ? payload.value : null;
  if (!notifications?.length) return { ok: false, error: "Microsoft Graph webhook needs a non-empty value array" };
  if (typeof resolveClientState !== "function" && !text(clientState, 2_048)) {
    return { ok: false, error: "Microsoft Graph webhook needs a vault-backed client-state resolver" };
  }

  const events = [];
  for (const notification of notifications) {
    let subscriptionId;
    try { subscriptionId = opaque(notification?.subscriptionId, "subscriptionId"); }
    catch { return { ok: false, error: "Microsoft Graph webhook subscription id is invalid" }; }
    const supplied = text(notification?.clientState, 2_048);
    const expected = typeof resolveClientState === "function"
      ? secretText(resolveClientState(subscriptionId), 2_048)
      : text(clientState, 2_048);
    if (!subscriptionId || !supplied || !expected || !constantTimeEqual(supplied, expected)) {
      return { ok: false, error: "Microsoft Graph webhook clientState does not match" };
    }
    const normalized = normalizeMicrosoft365Event(notification, { connectionId });
    if (normalized) events.push(normalized);
  }
  return { ok: true, kind: "notifications", events, responseBody: "" };
}

// A normalized event intentionally contains only routing metadata. A role must use a separately
// granted read tool to retrieve any message or file content after it receives this event.
export function normalizeMicrosoft365Event(notification = {}, { connectionId = "", receivedAt = new Date().toISOString() } = {}) {
  let subscriptionId;
  try { subscriptionId = opaque(notification.subscriptionId, "subscriptionId"); } catch { return null; }
  const resource = text(notification.resource, 2_048);
  const changeType = text(notification.changeType, 64).toLowerCase();
  if (!subscriptionId || !resource || !changeType) return null;
  const resourceId = text(notification?.resourceData?.id, 1_024);
  const sequence = text(notification.sequenceNumber || notification?.resourceData?.["@odata.etag"], 1_024);
  const type = microsoftEventType(resource, changeType);
  if (!type) return null;
  const externalId = text(notification.id, 1_024) || hashEventIdentity({ subscriptionId, resource, resourceId, changeType, sequence });
  const event = {
    providerEventId: `microsoft365:${externalId}`,
    id: `microsoft365:${externalId}`,
    provider: "microsoft365",
    type,
    ...(connectionId ? { connectionId: text(connectionId, 256) } : {}),
    resource: {
      subscriptionId,
      resource,
      ...(resourceId ? { resourceId } : {}),
      ...(sequence ? { sequence } : {}),
    },
    summary: {
      changeType,
      ...(text(notification.tenantId, 256) ? { tenantId: text(notification.tenantId, 256) } : {})
    },
    occurredAt: timestamp(receivedAt)
  };
  // These safe fields let a generic plugin registry normalize a delivery as well. Inbound host
  // code uses providerEventId/resource/summary above; no raw notification is attached.
  const resolvedConnectionId = text(connectionId, 256) || text(notification.connectionId, 256);
  if (resolvedConnectionId) {
    event.connectionId = resolvedConnectionId;
    event.subject = resourceId ? { id: resourceId, label: type } : { id: subscriptionId, label: type };
    event.metadata = { ...event.resource, ...event.summary };
    event.receivedAt = timestamp(receivedAt);
  }
  return event;
}

// Host runtime adapters pass a credential resolver rather than a token. The token is held only
// inside graphRequest while an HTTPS call is made and is never part of a return value or error.
export async function invokeMicrosoft365Action({ action, connectionId, input = {}, fetch, accessTokenFor, graphUrl = GRAPH_URL } = {}) {
  const actionId = text(action, 128);
  const checked = validateMicrosoftAction(actionId, input);
  if (!checked.ok) throw new Error(checked.error);
  const graph = (path, options) => graphRequest({ fetch, accessTokenFor, connectionId, graphUrl, path, ...options });
  const value = checked.input;

  switch (actionId) {
    case "microsoft365.searchMail":
      return await graph(mailSearchPath(value.query, value.maxResults), { headers: { ConsistencyLevel: "eventual" } });
    case "microsoft365.getMail":
      return await graph(`/me/messages/${encodeURIComponent(value.messageId)}?$select=${mailSelect()}`);
    case "microsoft365.createMailDraft":
      return await graph("/me/messages", { method: "POST", json: { subject: value.subject, body: { contentType: "Text", content: value.body }, toRecipients: value.to.map((address) => ({ emailAddress: { address } })) } });
    case "microsoft365.sendMailDraft":
      return await graph(`/me/messages/${encodeURIComponent(value.messageId)}/send`, { method: "POST", json: {} });
    case "microsoft365.searchDriveItems":
      return await graph(`/me/drive/root/search(q='${encodeURIComponent(value.query)}')?$select=id,name,webUrl,file,folder,lastModifiedDateTime&$top=${value.maxResults}`);
    case "microsoft365.getDriveItem":
      return await graph(`/me/drive/items/${encodeURIComponent(value.itemId)}?$select=id,name,webUrl,file,folder,size,lastModifiedDateTime,parentReference`);
    case "microsoft365.createTextFile": {
      // Create the item with Graph's explicit conflict failure before writing its content. The
      // convenient path-based PUT endpoint overwrites an existing item, which is outside this
      // plugin's curated, non-destructive write contract.
      const created = await graph(`/me/drive/items/${encodeURIComponent(value.parentItemId)}/children`, {
        method: "POST",
        json: { name: value.name, file: {}, "@microsoft.graph.conflictBehavior": "fail" }
      });
      const itemId = opaque(created?.id, "created OneDrive item id");
      return await graph(`/me/drive/items/${encodeURIComponent(itemId)}/content`, {
        method: "PUT", body: value.content, headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }
    case "microsoft365.getWorkbookRange":
      return await graph(workbookRangePath(value));
    case "microsoft365.updateWorkbookRange":
      return await graph(workbookRangePath(value), { method: "PATCH", json: { values: value.values } });
    case "microsoft365.listTeamsChannelMessages":
      return await graph(`/teams/${encodeURIComponent(value.teamId)}/channels/${encodeURIComponent(value.channelId)}/messages?$top=${value.maxResults}`);
    case "microsoft365.postTeamsChannelMessage":
      return await graph(`/teams/${encodeURIComponent(value.teamId)}/channels/${encodeURIComponent(value.channelId)}/messages`, { method: "POST", json: { body: { contentType: "text", content: value.text } } });
    default:
      throw new Error(`unsupported Microsoft 365 action: ${actionId || "<empty>"}`);
  }
}

export async function subscribeMicrosoft365({ eventId, connectionId, notificationUrl, lifecycleNotificationUrl, clientState, resource, expirationDateTime, fetch, accessTokenFor, graphUrl = GRAPH_URL } = {}) {
  const eventDescriptor = microsoft365Events.find((event) => event.id === text(eventId, 128));
  if (!eventDescriptor) throw new Error(`unknown Microsoft 365 event: ${eventId || "<empty>"}`);
  const selectedResource = subscriptionResource(eventDescriptor, resource);
  const url = httpsUrl(notificationUrl, "notificationUrl");
  const state = requiredText(clientState, "clientState", 2_048);
  const expiration = graphExpiration(expirationDateTime);
  const body = {
    changeType: eventDescriptor.changeType,
    notificationUrl: url,
    resource: selectedResource,
    expirationDateTime: expiration,
    clientState: state
  };
  if (lifecycleNotificationUrl) body.lifecycleNotificationUrl = httpsUrl(lifecycleNotificationUrl, "lifecycleNotificationUrl");
  const result = await graphRequest({ fetch, accessTokenFor, connectionId, graphUrl, path: "/subscriptions", method: "POST", json: body });
  return publicSubscription(result, connectionId, eventDescriptor.id);
}

export async function renewMicrosoft365Subscription({ subscriptionId, connectionId, fetch, accessTokenFor, graphUrl = GRAPH_URL, now = Date.now } = {}) {
  const id = opaque(subscriptionId, "subscriptionId");
  const expiration = freshGraphExpiration(now);
  const result = await graphRequest({ fetch, accessTokenFor, connectionId, graphUrl, path: `/subscriptions/${encodeURIComponent(id)}`, method: "PATCH", json: { expirationDateTime: expiration } });
  return publicSubscription(result, connectionId);
}

// Revoking OAuth credentials remains host-owned. This only removes the subscriptions CrewRun
// created, leaving a host free to revoke the underlying connection in its vault transaction.
export async function disconnectMicrosoft365({ subscriptionIds = [], connectionId, fetch, accessTokenFor, graphUrl = GRAPH_URL } = {}) {
  const ids = [...new Set((Array.isArray(subscriptionIds) ? subscriptionIds : [subscriptionIds]).map((id) => opaque(id, "subscriptionId")).filter(Boolean))];
  for (const id of ids) {
    await graphRequest({ fetch, accessTokenFor, connectionId, graphUrl, path: `/subscriptions/${encodeURIComponent(id)}`, method: "DELETE" });
  }
  return { disconnected: true, subscriptionsRemoved: ids.length };
}

export function validateMicrosoftAction(actionId, input = {}) {
  const descriptor = microsoft365Actions.find((action) => action.id === text(actionId, 128));
  if (!descriptor) return { ok: false, error: `unknown Microsoft 365 action: ${actionId || "<empty>"}` };
  return descriptor.validate(input);
}

function action(value) { return Object.freeze(value); }
function event(value) { return Object.freeze({ delivery: "webhook", retention: "metadata", ...value }); }

function validateSearchMail(input) { return validateQuery(input); }
function validateSearchDriveItems(input) { return validateQuery(input); }
function validateQuery(input = {}) {
  const query = requiredText(input.query, "query", MAX_QUERY);
  const maxResults = boundedInteger(input.maxResults, 10, 1, 25, "maxResults");
  return { ok: true, input: { query, maxResults } };
}
function validateGetMail(input = {}) { return idInput(input, "messageId"); }
function validateGetDriveItem(input = {}) { return idInput(input, "itemId"); }
function idInput(input, field) {
  try { return { ok: true, input: { [field]: opaque(requiredText(input[field], field, 1_024), field) } }; }
  catch (error) { return failure(error); }
}
function validateCreateMailDraft(input = {}) {
  try {
    const to = emailList(input.to);
    return { ok: true, input: { to, subject: requiredText(input.subject, "subject", 998), body: requiredText(input.body, "body", MAX_TEXT) } };
  } catch (error) { return failure(error); }
}
function validateCreateTextFile(input = {}) {
  try {
    const parentItemId = opaque(requiredText(input.parentItemId, "parentItemId", 1_024), "parentItemId");
    const name = requiredText(input.name, "name", 128);
    if (!FILE_NAME.test(name) || name === "." || name === "..") throw new Error("name must be a file name, not a path");
    return { ok: true, input: { parentItemId, name, content: requiredText(input.content, "content", MAX_FILE_CONTENT) } };
  } catch (error) { return failure(error); }
}
function validateWorkbookRange(input = {}) {
  try {
    return { ok: true, input: { itemId: opaque(requiredText(input.itemId, "itemId", 1_024), "itemId"), worksheet: safeWorksheet(input.worksheet), range: safeRange(input.range) } };
  } catch (error) { return failure(error); }
}
function validateUpdateWorkbookRange(input = {}) {
  const range = validateWorkbookRange(input);
  if (!range.ok) return range;
  try { return { ok: true, input: { ...range.input, values: excelValues(input.values) } }; }
  catch (error) { return failure(error); }
}
function validateTeamsChannel(input = {}) {
  try {
    return { ok: true, input: { teamId: opaque(requiredText(input.teamId, "teamId", 1_024), "teamId"), channelId: opaque(requiredText(input.channelId, "channelId", 1_024), "channelId"), maxResults: boundedInteger(input.maxResults, 10, 1, 25, "maxResults") } };
  } catch (error) { return failure(error); }
}
function validatePostTeamsChannelMessage(input = {}) {
  const channel = validateTeamsChannel(input);
  if (!channel.ok) return channel;
  try { return { ok: true, input: { teamId: channel.input.teamId, channelId: channel.input.channelId, text: requiredText(input.text, "text", MAX_TEXT) } }; }
  catch (error) { return failure(error); }
}

async function microsoftTokenRequest({ fetch, clientId, clientSecret, tokenEndpoint = microsoft365OAuth.tokenEndpoint, ...values } = {}) {
  if (typeof fetch !== "function") throw new Error("Microsoft 365 host needs an injected fetch implementation");
  const body = new URLSearchParams({
    client_id: requiredText(clientId, "Microsoft 365 clientId", 1_024),
    ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value ?? "")]))
  });
  // A confidential web host normally provides a client secret; development public-client apps
  // may omit it and still use PKCE. The secret is sent only to the Microsoft token endpoint.
  if (text(clientSecret, 8_192)) body.set("client_secret", text(clientSecret, 8_192));
  const response = await fetch(httpsUrl(tokenEndpoint, "Microsoft 365 tokenEndpoint"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const payload = await response?.json?.().catch(() => ({}));
  if (!response?.ok) throw new Error(`Microsoft 365 OAuth token exchange failed: ${providerError(payload, response?.status)}`);
  return payload && typeof payload === "object" ? payload : {};
}

function microsoftCredentials(payload, previous = {}) {
  const accessToken = requiredText(payload?.access_token, "Microsoft 365 access token", 16_384);
  const refreshToken = text(payload?.refresh_token, 16_384) || text(previous?.refreshToken, 16_384);
  const expiresIn = Number(payload?.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(Date.now() + (expiresIn * 1000)).toISOString()
    : text(previous?.expiresAt, 64);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {})
  };
}

function microsoftScopes(payload) {
  const source = Array.isArray(payload?.scope) ? payload.scope : String(payload?.scope || "").split(/[\s,]+/);
  return [...new Set(source.map((scope) => String(scope || "").trim()).filter(Boolean))];
}

function privateCredentialsFor({ credentials, connection, config } = {}) {
  const source = credentials && typeof credentials === "object"
    ? credentials
    : connection?.credentials && typeof connection.credentials === "object"
      ? connection.credentials
      : config?.credentials && typeof config.credentials === "object"
        ? config.credentials
        : null;
  if (!source) throw new Error("Microsoft 365 host did not provide private connection credentials");
  return { accessToken: requiredText(source.accessToken, "Microsoft 365 access token", 16_384), ...(text(source.refreshToken, 16_384) ? { refreshToken: text(source.refreshToken, 16_384) } : {}), ...(text(source.expiresAt, 64) ? { expiresAt: text(source.expiresAt, 64) } : {}) };
}

async function graphRequest({ fetch, accessTokenFor, connectionId, graphUrl = GRAPH_URL, path, method = "GET", headers = {}, json, body } = {}) {
  if (typeof fetch !== "function") throw new Error("Microsoft 365 host needs an injected fetch implementation");
  if (typeof accessTokenFor !== "function") throw new Error("Microsoft 365 host needs an accessTokenFor vault resolver");
  // The Graph base is deliberately pinned before a vault token is resolved. A configurable
  // endpoint must never turn a delegated bearer token into an SSRF or token-exfiltration path.
  const base = normalizedGraphUrl(graphUrl).replace(/\/$/, "");
  const token = requiredText(await accessTokenFor({ provider: "microsoft365", connectionId }), "Microsoft 365 access token", 16_384);
  const url = new URL(`${base}/${String(path || "").replace(/^\/+/, "")}`);
  const requestHeaders = { accept: "application/json", authorization: `Bearer ${token}`, ...headers };
  let requestBody = body;
  if (json !== undefined) {
    requestHeaders["content-type"] = "application/json";
    requestBody = JSON.stringify(json);
  }
  const response = await fetch(url, { method, headers: requestHeaders, ...(requestBody === undefined ? {} : { body: requestBody }) });
  const payload = await responsePayload(response);
  if (!response?.ok) throw new Error(`Microsoft Graph ${method} ${url.pathname} failed: ${providerError(payload, response?.status)}`);
  return payload;
}

function mailSearchPath(query, maxResults) {
  const params = new URLSearchParams({ "$search": `\"${query.replaceAll("\"", "\\\"")}\"`, "$select": "id,subject,from,receivedDateTime,webLink,hasAttachments", "$top": String(maxResults) });
  return `/me/messages?${params}`;
}
function mailSelect() { return "id,subject,from,toRecipients,receivedDateTime,body,webLink,hasAttachments"; }
function workbookRangePath({ itemId, worksheet, range }) {
  return `/me/drive/items/${encodeURIComponent(itemId)}/workbook/worksheets/${encodeURIComponent(worksheet)}/range(address='${encodeURIComponent(range)}')`;
}
function subscriptionResource(eventDescriptor, resource) {
  const selected = text(resource, 2_048) || eventDescriptor.resource;
  if (!selected && eventDescriptor.resourceTemplate) throw new Error(`${eventDescriptor.id} needs a selected Graph resource`);
  if (!selected || !selected.startsWith("/")) throw new Error("Graph subscription resource must start with /");
  if (selected.includes("{") || selected.includes("}")) throw new Error("Graph subscription resource has unresolved placeholders");
  return selected;
}
function graphExpiration(value) {
  const date = new Date(value || Date.now() + (60 * 60 * 1000));
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now() + 60_000) throw new Error("expirationDateTime must be at least one minute in the future");
  return date.toISOString();
}
function freshGraphExpiration(now) {
  const current = Number(typeof now === "function" ? now() : now);
  if (!Number.isFinite(current)) throw new Error("Microsoft 365 renewal clock must return a valid timestamp");
  return new Date(current + GRAPH_RENEWAL_LIFETIME_MS).toISOString();
}
function publicSubscription(value, connectionId, eventId = "") {
  const source = value && typeof value === "object" ? value : {};
  return {
    id: opaque(source.id, "subscriptionId"),
    provider: "microsoft365",
    ...(text(connectionId, 256) ? { connectionId: text(connectionId, 256) } : {}),
    ...(text(eventId, 128) ? { eventId: text(eventId, 128) } : {}),
    resource: text(source.resource, 2_048),
    changeType: text(source.changeType, 64),
    expiresAt: timestamp(source.expirationDateTime)
  };
}
function microsoftEventType(resource, changeType) {
  const lower = resource.toLowerCase();
  if ((lower.includes("mail") || lower.includes("messages")) && changeType === "created") return "microsoft365.outlookMessageCreated";
  if (lower.includes("drive") && changeType === "created") return "microsoft365.onedriveItemCreated";
  if (lower.includes("drive") && changeType === "updated") return "microsoft365.onedriveItemUpdated";
  if ((lower.includes("teams") || lower.includes("channels")) && changeType === "created") return "microsoft365.teamsChannelMessageCreated";
  return "";
}
function hashEventIdentity(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 48); }
function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
function parseWebhookBody(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return value;
  try { return JSON.parse(Buffer.from(value || "").toString("utf8")); } catch { return null; }
}
function queryValue(query, name) {
  if (query instanceof URLSearchParams) return query.get(name);
  if (typeof query?.get === "function") return query.get(name);
  return query?.[name];
}
function secretText(value, maximum) { return text(value?.secret ?? value?.clientState ?? value, maximum); }
function responsePayload(response) {
  const contentType = String(response?.headers?.get?.("content-type") || "");
  if (response?.status === 204 || response?.status === 202) return Promise.resolve({});
  return contentType.includes("json")
    ? response.json().catch(() => ({}))
    : response.text?.().then((body) => ({ body })).catch(() => ({})) || Promise.resolve({});
}
function providerError(payload, status) { return text(payload?.error?.message || payload?.error?.code || payload?.body || status || "unknown error", 1_000); }
function normalizedGraphUrl(value) {
  let url;
  try { url = new URL(String(value || GRAPH_URL)); }
  catch { throw new Error("Microsoft Graph URL must be https://graph.microsoft.com/v1.0"); }
  if (
    url.protocol !== "https:"
    || url.hostname.toLowerCase() !== "graph.microsoft.com"
    || url.username
    || url.password
    || url.port
    || !["/v1.0", "/v1.0/"].includes(url.pathname)
    || url.search
    || url.hash
  ) {
    throw new Error("Microsoft Graph URL must be https://graph.microsoft.com/v1.0");
  }
  return GRAPH_URL;
}
function opaque(value, name) { const id = String(value || "").trim(); if (!OPAQUE_ID.test(id)) throw new Error(`${name} must be an opaque provider id`); return id; }
function requiredText(value, name, max) { const result = text(value, max); if (!result) throw new Error(`${name} is required`); return result; }
function text(value, max = 1_024) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function boundedInteger(value, fallback, min, max, name) { const number = value == null ? fallback : Number(value); if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} through ${max}`); return number; }
function emailList(value) { const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : []; const unique = [...new Set(list.map((entry) => text(entry, 320)).filter(Boolean))]; if (!unique.length || unique.length > 25 || unique.some((entry) => !EMAIL.test(entry))) throw new Error("to must contain one through 25 email addresses"); return unique; }
function safeWorksheet(value) { const name = requiredText(value, "worksheet", 128); if (/[\\/\u0000-\u001f]/.test(name)) throw new Error("worksheet is invalid"); return name; }
function safeRange(value) { const range = requiredText(value, "range", 32); if (!RANGE.test(range)) throw new Error("range must be a bounded A1 range"); return range; }
function excelValues(value) { if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error("values must have one through 100 rows"); let count = 0; const rows = value.map((row) => { if (!Array.isArray(row) || !row.length || row.length > 100) throw new Error("each values row must have one through 100 cells"); return row.map((cell) => { count += 1; if (count > MAX_VALUES || !["string", "number", "boolean"].includes(typeof cell) && cell !== null) throw new Error("values cells must be string, number, boolean, or null"); if (typeof cell === "string" && cell.length > 32_000) throw new Error("values text cells must not exceed 32000 characters"); if (typeof cell === "string" && /^[=+\-@]/.test(cell)) throw new Error("values text cells must not begin with a spreadsheet formula prefix"); return cell; }); }); return rows; }
function failure(error) { return { ok: false, error: error?.message || String(error) }; }
function timestamp(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(); }
function httpsUrl(value, name) { const url = new URL(requiredText(value, name, 2_048)); if (url.protocol !== "https:") throw new Error(`${name} must use https`); return url.toString(); }
