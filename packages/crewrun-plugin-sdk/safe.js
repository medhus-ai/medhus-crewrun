const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const EVENT_ID = /^[a-z][a-z0-9-]{0,63}\.[A-Za-z][A-Za-z0-9]*$/;
const CONNECTION_STATES = new Set(["connected", "needs_reconnect", "revoked", "disconnected"]);
const SENSITIVE_KEYS = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "apikey",
  "privatekey",
  "password",
  "credential",
  "credentials",
  "secret",
  "secretref",
  "webhooksecret",
  "signingsecret",
  "authorizationheader",
  "authorization",
  "headers",
  "rawbody",
  "payload",
  "cookie",
  "setcookie",
  "session",
  "jwt",
  "bearer"
]);
const REDACTED_VALUE = "[redacted]";
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"']+/gi;
const SENSITIVE_VALUE_PATTERNS = Object.freeze([
  /\bbearer[ \t]+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|ya29\.[A-Za-z0-9._-]{10,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})\b/g,
  /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|authorization|password|secret)\s*[:=]\s*(?:bearer\s+)?[^\s,;]{8,}/gi
]);

// Return display-safe connection metadata. This is intentionally a whitelist rather than a
// sanitizer: host vault fields and provider credentials cannot accidentally reach the console,
// an MCP bridge, audit context, or an agent prompt.
export function connectionMetadata(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("connection metadata must be an object");
  }
  const id = normalizedConnectionId(record.id);
  const provider = normalizedProvider(record.provider);
  const status = String(record.status || "connected").trim();
  if (!CONNECTION_STATES.has(status)) throw new Error(`invalid connection status: ${status || "<empty>"}`);

  const account = record.account && typeof record.account === "object" && !Array.isArray(record.account)
    ? record.account
    : record;
  const accountId = safeText(account.id ?? record.accountId, 256);
  const accountLabel = safeText(account.label ?? record.accountLabel, 256);
  const accountEmail = safeText(account.email ?? record.accountEmail, 320);
  const metadata = {
    id,
    provider,
    status,
    account: accountId || accountLabel || accountEmail
      ? {
        ...(accountId ? { id: accountId } : {}),
        ...(accountLabel ? { label: accountLabel } : {}),
        ...(accountEmail ? { email: accountEmail } : {})
      }
      : null,
    scopes: normalizedStrings(record.scopes ?? record.grantedScopes),
    capabilities: normalizedStrings(record.capabilities)
  };
  for (const [key, value] of [
    ["createdAt", record.createdAt],
    ["updatedAt", record.updatedAt],
    ["expiresAt", record.expiresAt],
    ["lastEventAt", record.lastEventAt]
  ]) {
    const text = safeText(value, 64);
    if (text) metadata[key] = text;
  }
  const errorCode = safeText(record.errorCode, 128);
  if (errorCode) metadata.errorCode = errorCode;
  return deepFreeze(metadata);
}

// Normalize a provider delivery into the durable, metadata-only event shape a host may queue.
// Callers must deliberately pass `metadata`; raw bodies, headers, and provider payload objects
// have no route into the normalized event.
export function normalizeIntegrationEvent(value, { provider, eventIds } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("integration event must be an object");
  }
  const eventProvider = normalizedProvider(provider ?? value.provider ?? eventPrefix(value.type ?? value.eventType));
  const type = normalizedEventType(value.type ?? value.eventType, eventProvider);
  if (eventIds && !new Set(eventIds).has(type)) {
    throw new Error(`event ${type} is not declared by ${eventProvider}`);
  }
  const id = requiredText(value.id ?? value.eventId, "event id", 256);
  const connectionId = normalizedConnectionId(value.connectionId);
  const occurredAt = normalizedTimestamp(value.occurredAt, "occurredAt");
  const receivedAt = value.receivedAt == null
    ? new Date().toISOString()
    : normalizedTimestamp(value.receivedAt, "receivedAt");
  const subject = normalizedSubject(value.subject);
  const metadata = safeMetadata(value.metadata ?? {});
  return deepFreeze({ id, provider: eventProvider, type, connectionId, occurredAt, receivedAt, subject, metadata });
}

export function eventReceiptKey(event) {
  const normalized = normalizeIntegrationEvent(event);
  return `${normalized.provider}:${normalized.connectionId}:${normalized.id}`;
}

// Metadata is opt-in and rejects credential-shaped fields recursively. It is useful for benign
// information such as an email subject, repository name, or document URL, but is never a raw
// provider delivery or a place to store OAuth material.
export function safeMetadata(value, { maxDepth = 5, maxEntries = 64 } = {}) {
  const seen = new WeakSet();
  let entries = 0;
  return clone(value, 0);

  function clone(input, depth) {
    if (input == null || typeof input === "boolean") return input;
    if (typeof input === "string") return redactMetadataText(input).slice(0, 4_096);
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error("metadata numbers must be finite");
      return input;
    }
    if (Array.isArray(input)) {
      if (depth >= maxDepth) throw new Error("metadata is too deeply nested");
      return input.slice(0, maxEntries).map((item) => clone(item, depth + 1));
    }
    if (!input || typeof input !== "object") throw new Error("metadata must contain JSON-compatible values");
    if (seen.has(input)) throw new Error("metadata cannot be circular");
    if (depth >= maxDepth) throw new Error("metadata is too deeply nested");
    seen.add(input);
    const result = {};
    for (const [key, item] of Object.entries(input)) {
      entries += 1;
      if (entries > maxEntries) throw new Error("metadata has too many entries");
      assertSafeMetadataKey(key);
      result[key] = clone(item, depth + 1);
    }
    seen.delete(input);
    return result;
  }
}

export function normalizedConnectionId(value) {
  const id = String(value || "").trim();
  if (!CONNECTION_ID.test(id)) throw new Error(`invalid connection id: ${id || "<empty>"}`);
  return id;
}

export function normalizedProvider(value) {
  const provider = String(value || "").trim();
  if (!PROVIDER_ID.test(provider)) throw new Error(`invalid integration provider: ${provider || "<empty>"}`);
  return provider;
}

export function normalizedStrings(value, { maxLength = 2_048 } = {}) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  return [...new Set(values.map((item) => safeText(item, maxLength)).filter(Boolean))];
}

export function requiredText(value, name, maxLength = 2_048) {
  const text = safeText(value, maxLength);
  if (!text) throw new Error(`${name} is required`);
  return text;
}

export function safeText(value, maxLength = 1_024) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

// Provider errors can echo bearer tokens, callback URLs, or malformed request fragments. Hosts
// may retain a short operator-facing reason, but must use the same redaction rules as durable
// event metadata before it reaches SQLite, an audit record, or a console snapshot.
export function redactIntegrationText(value, maxLength = 1_024) {
  return redactMetadataText(safeText(value, maxLength)).slice(0, maxLength);
}

export function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function normalizedEventType(value, provider) {
  const type = requiredText(value, "event type", 256);
  if (!EVENT_ID.test(type) || !type.startsWith(`${provider}.`)) {
    throw new Error(`invalid integration event type: ${type}`);
  }
  return type;
}

function eventPrefix(value) {
  const type = String(value || "");
  return type.split(".", 1)[0];
}

function normalizedTimestamp(value, name) {
  const text = requiredText(value, name, 64);
  const timestamp = new Date(text);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${name} must be an ISO timestamp`);
  return timestamp.toISOString();
}

function normalizedSubject(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("event subject must be an object");
  const id = safeText(value.id, 256);
  const label = redactMetadataText(safeText(value.label, 512));
  const url = safeUrl(value.url);
  return id || label || url ? deepFreeze({ ...(id ? { id } : {}), ...(label ? { label } : {}), ...(url ? { url } : {}) }) : null;
}

function safeUrl(value) {
  const text = safeText(value, 2_048);
  if (!text) return "";
  let url;
  try { url = new URL(text); } catch { throw new Error("event subject URL must be an absolute URL"); }
  if (url.protocol !== "https:") throw new Error("event subject URL must use https");
  // A callback, download, or OAuth URL can carry credentials in its query or fragment. Subject
  // links are navigation hints only, so retain the durable location and discard credentials.
  url.username = "";
  url.password = "";
  url.search = "";
  if (hasSensitiveFragment(url.hash)) url.hash = "";
  return url.toString();
}

function redactMetadataText(value) {
  let result = String(value || "").replace(URL_IN_TEXT, redactUrlInText);
  for (const pattern of SENSITIVE_VALUE_PATTERNS) result = result.replace(pattern, REDACTED_VALUE);
  return result;
}

function redactUrlInText(candidate) {
  const suffix = candidate.match(/[),.;!?]+$/)?.[0] || "";
  const source = suffix ? candidate.slice(0, -suffix.length) : candidate;
  let url;
  try { url = new URL(source); } catch { return candidate; }
  if (!["http:", "https:"].includes(url.protocol)) return candidate;
  const needsRedaction = Boolean(url.username || url.password || url.search || hasSensitiveFragment(url.hash));
  if (!needsRedaction) return candidate;
  url.username = "";
  url.password = "";
  url.search = "";
  if (hasSensitiveFragment(url.hash)) url.hash = "";
  return `${url}${suffix}`;
}

function hasSensitiveFragment(fragment) {
  const value = String(fragment || "").replace(/^#/, "");
  return /(?:token|secret|password|credential|authorization|apikey|privatekey|cookie|session|jwt|bearer)\s*(?:=|:)/i.test(value)
    || SENSITIVE_VALUE_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    });
}

function assertSafeMetadataKey(key) {
  const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!normalized || normalized.length > 128) throw new Error("metadata key is invalid");
  // This is intentionally broader than the explicit list. Integration event metadata is a
  // display-and-routing projection, never a credential container; a plugin must not be able to
  // smuggle a provider token through a creative key such as `providerToken` or `sessionKey`.
  if (SENSITIVE_KEYS.has(normalized) || /(?:token|secret|password|credential|authorization|apikey|privatekey|cookie|session|jwt|bearer)/.test(normalized)) {
    throw new Error(`metadata must not include credential field ${key}`);
  }
}
