const GMAIL_ID = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_QUERY_LENGTH = 500;

// Gmail reads are deliberately opt-in in the connector registry. They use gmail.readonly
// because Gmail's metadata-only scope cannot perform arbitrary `q` searches. Hosts should make
// the restricted-scope consent and any result-redaction policy visible to their operator.
export const gmailConnectorActions = Object.freeze([
  Object.freeze({
    id: "gmail.sendDraft",
    provider: "gmail",
    label: "Send Gmail draft",
    description: "Send one existing Gmail draft by opaque draft id. Delivery requires operator approval.",
    scopes: ["https://www.googleapis.com/auth/gmail.compose"],
    scopeSets: [
      ["https://www.googleapis.com/auth/gmail.compose"],
      ["https://www.googleapis.com/auth/gmail.modify"],
      ["https://mail.google.com/"]
    ],
    risk: "external-write",
    approval: "required",
    inputSchema: (z) => ({ draftId: z.string() }),
    validate: validateGmailSendDraft
  }),
  Object.freeze({
    id: "gmail.searchMetadata",
    provider: "gmail",
    label: "Search Gmail metadata",
    description: "Search message metadata only. This read action is disabled unless the host explicitly enables Gmail reads.",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    scopeSets: [
      ["https://www.googleapis.com/auth/gmail.readonly"],
      ["https://www.googleapis.com/auth/gmail.modify"],
      ["https://mail.google.com/"]
    ],
    risk: "read",
    approval: "none",
    read: true,
    inputSchema: (z) => ({ query: z.string(), maxResults: z.number().int().min(1).max(25).optional() }),
    validate: validateGmailSearchMetadata
  }),
  Object.freeze({
    id: "gmail.getMessage",
    provider: "gmail",
    label: "Get Gmail message",
    description: "Get one previously identified Gmail message. The host controls any body redaction; this read action is disabled unless enabled explicitly.",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    scopeSets: [
      ["https://www.googleapis.com/auth/gmail.readonly"],
      ["https://www.googleapis.com/auth/gmail.modify"],
      ["https://mail.google.com/"]
    ],
    risk: "read",
    approval: "none",
    read: true,
    inputSchema: (z) => ({ messageId: z.string() }),
    validate: validateGmailGetMessage
  })
]);

export function validateGmailSendDraft(input = {}) {
  const draftId = opaqueId(input.draftId, "draftId");
  return draftId.ok ? { ok: true, input: { draftId: draftId.value } } : draftId;
}

export function validateGmailSearchMetadata(input = {}) {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) return { ok: false, error: "query is required" };
  if (query.length > MAX_QUERY_LENGTH) return { ok: false, error: `query must not exceed ${MAX_QUERY_LENGTH} characters` };
  const maxResults = input.maxResults == null ? 10 : Number(input.maxResults);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 25) {
    return { ok: false, error: "maxResults must be an integer from 1 through 25" };
  }
  return { ok: true, input: { query, maxResults } };
}

export function validateGmailGetMessage(input = {}) {
  const messageId = opaqueId(input.messageId, "messageId");
  return messageId.ok ? { ok: true, input: { messageId: messageId.value } } : messageId;
}

function opaqueId(value, name) {
  const id = String(value || "").trim();
  if (!GMAIL_ID.test(id)) return { ok: false, error: `${name} must be an opaque Gmail id` };
  return { ok: true, value: id };
}
