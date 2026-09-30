import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;

export const slackEvents = Object.freeze([
  Object.freeze({
    id: "slack.appMention",
    capability: "mentions",
    label: "Slack app mention",
    description: "A human mentioned the installed Slack app.",
    scopes: ["app_mentions:read"],
    delivery: "webhook",
    retention: "metadata"
  }),
  Object.freeze({
    id: "slack.channelMessage",
    capability: "messages",
    label: "Slack channel message",
    description: "A human posted a channel message visible to the installed app.",
    scopes: ["channels:history"],
    delivery: "webhook",
    retention: "metadata"
  })
]);

// Slack signs the exact HTTP bytes. Parse only after this function succeeds; accepting parsed
// JSON here would make whitespace or encoding changes invalidate the security boundary.
export function verifySlackWebhook({ headers = {}, rawBody, signingSecret, now = Date.now, toleranceMs = DEFAULT_REPLAY_WINDOW_MS } = {}) {
  const secret = String(signingSecret || "");
  const timestamp = header(headers, "x-slack-request-timestamp");
  const signature = header(headers, "x-slack-signature");
  const timestampSeconds = Number(timestamp);
  const current = Number(typeof now === "function" ? now() : now);
  if (!secret || !/^\d+$/.test(timestamp) || !Number.isSafeInteger(timestampSeconds) || !Number.isFinite(current)) {
    return { ok: false, error: "missing or invalid Slack signature headers" };
  }
  if (Math.abs(current - (timestampSeconds * 1000)) > Math.max(0, Number(toleranceMs) || 0)) {
    return { ok: false, error: "stale Slack request" };
  }
  const body = asBuffer(rawBody);
  const expected = `v0=${createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`v0:${timestamp}:`, "utf8"), body])).digest("hex")}`;
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return { ok: false, error: "invalid Slack signature" };
  }
  return { ok: true };
}

export function slackWebhookResponse(rawBody) {
  const envelope = parseEnvelope(rawBody);
  if (!envelope.ok) return envelope;
  if (envelope.value.type !== "url_verification") return { ok: true, response: null, envelope: envelope.value };
  const challenge = text(envelope.value.challenge, 4096);
  return challenge
    ? { ok: true, response: { status: 200, contentType: "text/plain; charset=utf-8", body: challenge }, envelope: envelope.value }
    : { ok: false, error: "Slack URL verification is missing challenge" };
}

// The normalized event has stable provider identifiers and only routing metadata. Event text,
// raw request bytes, authorizations, and signatures stay at the host boundary. A role that needs
// message content must use its separately authorized Slack read tool.
export function normalizeSlackEvent(delivery) {
  const wrapped = typeof delivery === "string" || Buffer.isBuffer(delivery) || delivery instanceof Uint8Array
    ? { rawBody: delivery }
    : delivery || {};
  const source = wrapped.envelope ?? wrapped.payload ?? wrapped.rawBody ?? wrapped;
  const envelope = typeof source === "string" || Buffer.isBuffer(source) || source instanceof Uint8Array
    ? parseEnvelope(source)
    : { ok: true, value: source };
  if (!envelope.ok) return null;
  const payload = envelope.value;
  if (!payload || typeof payload !== "object" || payload.type !== "event_callback") return null;
  const event = payload.event;
  if (!event || typeof event !== "object" || event.bot_id || event.subtype === "bot_message") return null;
  const eventId = text(payload.event_id, 255);
  const channelId = text(event.channel, 128);
  const messageTs = text(event.ts, 64);
  const connectionId = connection(wrapped.connectionId);
  const workspaceId = text(payload.team_id, 128);
  // Slack's Events API normally has one app callback URL rather than a connection-specific
  // path. A signed team_id is enough for the host to select one connected workspace; a path
  // connection still works for deployments that choose per-connection callbacks.
  if (!eventId || !channelId || !messageTs || (!connectionId && !workspaceId)) return null;
  const type = event.type === "app_mention"
    ? "slack.appMention"
    : event.type === "message" && !event.subtype
      ? "slack.channelMessage"
      : "";
  if (!type) return null;
  const threadTs = text(event.thread_ts, 64) || messageTs;
  const occurredAt = numericUnixTime(payload.event_time) || iso(wrapped.receivedAt) || new Date().toISOString();
  return {
    id: eventId,
    type,
    ...(connectionId ? { connectionId } : { accountId: workspaceId }),
    occurredAt,
    ...(iso(wrapped.receivedAt) ? { receivedAt: iso(wrapped.receivedAt) } : {}),
    subject: { id: channelId, label: "Slack channel" },
    metadata: {
      workspaceId,
      channelId,
      messageTs,
      threadTs,
      senderId: text(event.user, 128)
    }
  };
}

export const slackSubscription = Object.freeze({
  kind: "slack-events-api",
  delivery: "webhook",
  manual: true,
  endpoint: "/integrations/webhooks/slack",
  events: ["app_mention", "message.channels"],
  note: "Configure the app Event Subscriptions URL in Slack. The reference host verifies each signed delivery."
});

function parseEnvelope(rawBody) {
  try {
    const value = JSON.parse(asBuffer(rawBody).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value }
      : { ok: false, error: "Slack payload must be an object" };
  } catch {
    return { ok: false, error: "invalid Slack JSON" };
  }
}

function header(headers, name) {
  const expected = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() !== expected) continue;
    return Array.isArray(value) ? String(value[0] || "") : String(value || "");
  }
  return "";
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value ?? ""), "utf8");
}

function text(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function numericUnixTime(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function connection(value) {
  const id = text(value, 128);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : "";
}

function iso(value) {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
