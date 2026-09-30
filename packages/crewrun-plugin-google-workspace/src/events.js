import { timingSafeEqual } from "node:crypto";

import { verifyGoogleOidcToken } from "./oidc.js";

export const googleWorkspaceEvents = Object.freeze([
  Object.freeze({
    id: "google-workspace.gmailMailboxChanged",
    capability: "gmail-read",
    label: "Gmail mailbox changed",
    description: "Gmail published a mailbox-history notification. A host may reconcile it into new-mail metadata.",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    delivery: "webhook",
    retention: "metadata"
  }),
  Object.freeze({
    id: "google-workspace.driveChanged",
    capability: "drive",
    label: "Google Drive changed",
    description: "Google Drive delivered a verified change-channel notification. A host may reconcile it into changed Docs or Sheets metadata.",
    scopes: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
    delivery: "webhook",
    retention: "metadata"
  })
]);

// Gmail Pub/Sub push requests are authenticated with a Google-issued OIDC token. A host may
// inject a verifier for a specialized trust policy, otherwise the plugin verifies Google's
// signed RS256 token against the official JWKS endpoint and never trusts an unverified body.
export async function verifyGmailPubSubWebhook({ headers = {}, rawBody, connectionId, audience, serviceAccountEmail, verifyOidcToken: customVerifier, fetch } = {}) {
  const authorization = header(headers, "authorization");
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const verifyOidcToken = typeof customVerifier === "function" ? customVerifier : verifyGoogleOidcToken;
  const trustedServiceAccount = trustedServiceAccountEmail(serviceAccountEmail);
  if (!match || !trustedServiceAccount) return { ok: false, error: "Gmail Pub/Sub webhook requires a configured OIDC audience and push service account" };
  let verified;
  try {
    verified = await verifyOidcToken({ token: match[1], audience, serviceAccountEmail: trustedServiceAccount, fetch });
  } catch {
    return { ok: false, error: "Gmail Pub/Sub OIDC token is invalid" };
  }
  if (verified !== true && !verified?.ok) return { ok: false, error: "Gmail Pub/Sub OIDC token is invalid" };
  let envelope;
  try { envelope = JSON.parse(asBuffer(rawBody).toString("utf8")); } catch { return { ok: false, error: "invalid Gmail Pub/Sub JSON" }; }
  const message = envelope?.message;
  const messageId = text(message?.messageId, 255);
  const data = decodeJson(message?.data);
  const emailAddress = text(data?.emailAddress, 320);
  const historyId = text(data?.historyId, 255);
  if (!messageId || !emailAddress || !historyId) return { ok: false, error: "Gmail Pub/Sub notification is incomplete" };
  return {
    ok: true,
    delivery: {
      kind: "gmail-pubsub",
      ...(optionalConnectionId(connectionId) ? { connectionId: optionalConnectionId(connectionId) } : {}),
      messageId,
      emailAddress,
      historyId,
      publishedAt: dateOrNow(message.publishTime)
    }
  };
}

// Drive's channel token is a host-generated shared secret. It is checked in constant time and
// intentionally excluded from the resulting delivery and normalized event.
export function verifyDriveChannelWebhook({ headers = {}, connectionId, subscription = {} } = {}) {
  const storedSecret = subscription?.secret && typeof subscription.secret === "object" ? subscription.secret.channelToken : subscription?.secret;
  const privateSubscription = subscription?.metadata
    ? { ...subscription.metadata, channelToken: storedSecret || subscription.channelToken }
    : subscription;
  const channelId = header(headers, "x-goog-channel-id");
  const suppliedToken = header(headers, "x-goog-channel-token");
  const expectedChannel = text(privateSubscription.channelId, 255);
  const expectedToken = String(privateSubscription.channelToken || "");
  if (!channelId || !expectedChannel || channelId !== expectedChannel || !safeEqual(suppliedToken, expectedToken)) {
    return { ok: false, error: "invalid Google Drive channel" };
  }
  const resourceId = header(headers, "x-goog-resource-id");
  const resourceState = header(headers, "x-goog-resource-state");
  const messageNumber = header(headers, "x-goog-message-number");
  if (!resourceId || !resourceState || !messageNumber) return { ok: false, error: "incomplete Google Drive channel notification" };
  return {
    ok: true,
    delivery: {
      kind: "drive-channel",
      connectionId: requiredConnectionId(connectionId),
      channelId,
      resourceId: text(resourceId, 512),
      resourceState: text(resourceState, 128),
      messageNumber: text(messageNumber, 128),
      receivedAt: new Date().toISOString()
    }
  };
}

export async function verifyGoogleWorkspaceWebhook(request = {}) {
  const headers = request.headers || {};
  if (header(headers, "x-goog-channel-id")) {
    const configured = request.config || {};
    return verifyDriveChannelWebhook({
      ...request,
      subscription: request.subscription || driveSubscriptionFor(request) || {
        ...configured,
        channelId: configured.channelId || configured.driveChannelId,
        channelToken: configured.channelToken || configured.driveChannelToken
      }
    });
  }
  return await verifyGmailPubSubWebhook({
    ...request,
    audience: request.audience ?? request.config?.gmailPushAudience,
    serviceAccountEmail: request.serviceAccountEmail ?? request.config?.gmailPushServiceAccount,
    verifyOidcToken: request.verifyOidcToken ?? request.config?.verifyOidcToken ?? verifyGoogleOidcToken
  });
}

// The inbox receives metadata-only canonical events. Gmail gives history ids rather than a
// trustworthy "new mail" object; Drive gives change-channel headers rather than file contents.
// A host reconciles either signal through separately authorized provider calls before routing.
export function normalizeGoogleWorkspaceEvent(delivery) {
  if (!delivery || typeof delivery !== "object") return null;
  if (delivery.kind === "gmail-pubsub") {
    return {
      id: `gmail:${delivery.messageId}`,
      type: "google-workspace.gmailMailboxChanged",
      connectionId: requiredConnectionId(delivery.connectionId),
      occurredAt: dateOrNow(delivery.publishedAt),
      subject: { id: delivery.emailAddress, label: "Gmail mailbox" },
      metadata: { historyId: delivery.historyId, emailAddress: delivery.emailAddress }
    };
  }
  if (delivery.kind === "drive-channel") {
    return {
      id: `drive:${delivery.channelId}:${delivery.messageNumber}`,
      type: "google-workspace.driveChanged",
      connectionId: requiredConnectionId(delivery.connectionId),
      occurredAt: dateOrNow(delivery.receivedAt),
      subject: { id: delivery.resourceId, label: "Google Drive change" },
      metadata: { resourceState: delivery.resourceState, channelId: delivery.channelId, resourceId: delivery.resourceId }
    };
  }
  return null;
}

export const googleWorkspaceSubscription = Object.freeze({
  gmail: {
    kind: "gmail-pubsub-watch",
    delivery: "webhook",
    requires: ["configured Pub/Sub topic", "OIDC-authenticated push subscription"],
    renewBeforeHours: 24
  },
  drive: {
    kind: "drive-changes-channel",
    delivery: "webhook",
    requires: ["public HTTPS callback", "host-generated channel id and token"],
    renewBeforeHours: 24
  }
});

function header(headers, name) {
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() !== target) continue;
    return Array.isArray(value) ? String(value[0] || "") : String(value || "");
  }
  return "";
}

function decodeJson(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function requiredConnectionId(value) {
  const id = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error("connectionId is required");
  return id;
}

function optionalConnectionId(value) {
  const id = text(value, 128);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : "";
}

function driveSubscriptionFor(request) {
  if (!request?.state?.listSubscriptions || !request.connectionId) return null;
  try {
    const subscription = request.state.listSubscriptions({ connectionId: request.connectionId })
      .find((entry) => entry.providerKey === "google-workspace.driveChanged");
    if (!subscription) return null;
    const secret = request.state.getSubscriptionSecret?.({
      provider: "google-workspace", subscriptionId: subscription.id, connectionId: request.connectionId
    });
    return { ...subscription, ...(secret ? { secret } : {}) };
  } catch {
    return null;
  }
}

function dateOrNow(value) {
  const parsed = new Date(String(value || ""));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function text(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function trustedServiceAccountEmail(value) {
  const email = text(value, 320).toLowerCase();
  return /^[a-z0-9][a-z0-9._%+-]{0,127}@[a-z0-9.-]{1,190}\.[a-z]{2,63}$/i.test(email) ? email : "";
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value ?? ""), "utf8");
}
