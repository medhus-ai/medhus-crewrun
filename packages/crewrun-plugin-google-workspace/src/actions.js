const OPAQUE_ID = /^[A-Za-z0-9_-]{1,512}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_QUERY_LENGTH = 500;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 50_000;

// The Google APIs remain behind specifically-shaped actions. In particular, roles cannot submit
// raw MIME, Drive query expressions, Docs batchUpdate payloads, or arbitrary Sheets values APIs.
export const googleWorkspaceActions = Object.freeze([
  Object.freeze({
    id: "google-workspace.searchMail",
    capability: "gmail-read",
    label: "Search Gmail metadata",
    description: "Search Gmail message metadata only; message bodies are not returned.",
    risk: "read",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    scopeSets: [["https://www.googleapis.com/auth/gmail.readonly"], ["https://www.googleapis.com/auth/gmail.modify"], ["https://mail.google.com/"]],
    inputSchema: (z) => ({ query: z.string(), maxResults: z.number().int().min(1).max(25).optional() }),
    validate: validateSearchMail
  }),
  Object.freeze({
    id: "google-workspace.getMailMetadata",
    capability: "gmail-read",
    label: "Get Gmail metadata",
    description: "Get headers and labels for one known Gmail message, without its body.",
    risk: "read",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    scopeSets: [["https://www.googleapis.com/auth/gmail.readonly"], ["https://www.googleapis.com/auth/gmail.modify"], ["https://mail.google.com/"]],
    inputSchema: (z) => ({ messageId: z.string() }),
    validate: (input) => opaqueInput(input, "messageId")
  }),
  Object.freeze({
    id: "google-workspace.createMailDraft",
    capability: "gmail-send",
    label: "Create Gmail draft",
    description: "Create one plain-text Gmail draft. Creating the draft requires host approval.",
    risk: "external-write",
    approval: "required",
    scopes: ["https://www.googleapis.com/auth/gmail.compose"],
    scopeSets: [["https://www.googleapis.com/auth/gmail.compose"], ["https://www.googleapis.com/auth/gmail.modify"], ["https://mail.google.com/"]],
    inputSchema: (z) => ({ to: z.array(z.string()), subject: z.string(), text: z.string() }),
    validate: validateMailDraft
  }),
  Object.freeze({
    id: "google-workspace.sendMailDraft",
    capability: "gmail-send",
    label: "Send Gmail draft",
    description: "Send one existing Gmail draft by opaque id. Delivery requires host approval.",
    risk: "external-write",
    approval: "required",
    scopes: ["https://www.googleapis.com/auth/gmail.compose"],
    scopeSets: [["https://www.googleapis.com/auth/gmail.compose"], ["https://www.googleapis.com/auth/gmail.modify"], ["https://mail.google.com/"]],
    inputSchema: (z) => ({ draftId: z.string() }),
    validate: (input) => opaqueInput(input, "draftId")
  }),
  Object.freeze({
    id: "google-workspace.searchDrive",
    capability: "drive",
    label: "Search Drive",
    description: "Search Google Drive file metadata by plain text.",
    risk: "read",
    scopes: ["https://www.googleapis.com/auth/drive.metadata.readonly"],
    scopeSets: [["https://www.googleapis.com/auth/drive.metadata.readonly"], ["https://www.googleapis.com/auth/drive.readonly"], ["https://www.googleapis.com/auth/drive"]],
    inputSchema: (z) => ({ query: z.string(), maxResults: z.number().int().min(1).max(25).optional() }),
    validate: validateSearchDrive
  }),
  Object.freeze({
    id: "google-workspace.getDocument",
    capability: "docs-read",
    label: "Read Google Doc",
    description: "Read the plain text of one known Google Doc.",
    risk: "read",
    scopes: ["https://www.googleapis.com/auth/documents.readonly"],
    scopeSets: [["https://www.googleapis.com/auth/documents.readonly"], ["https://www.googleapis.com/auth/documents"]],
    inputSchema: (z) => ({ documentId: z.string() }),
    validate: (input) => opaqueInput(input, "documentId")
  }),
  Object.freeze({
    id: "google-workspace.createDocument",
    capability: "docs-write",
    label: "Create Google Doc",
    description: "Create a new empty Google Doc with a title. Creation requires host approval.",
    risk: "external-write",
    approval: "required",
    scopes: ["https://www.googleapis.com/auth/documents"],
    inputSchema: (z) => ({ title: z.string() }),
    validate: validateTitle
  }),
  Object.freeze({
    id: "google-workspace.appendDocumentText",
    capability: "docs-write",
    label: "Append Google Doc text",
    description: "Append plain text to the end of one Google Doc. Update requires host approval.",
    risk: "external-write",
    approval: "required",
    scopes: ["https://www.googleapis.com/auth/documents"],
    inputSchema: (z) => ({ documentId: z.string(), text: z.string() }),
    validate: validateDocumentAppend
  }),
  Object.freeze({
    id: "google-workspace.getSheetRange",
    capability: "sheets-read",
    label: "Read Google Sheet range",
    description: "Read one A1-notated range from a known Google Sheet.",
    risk: "read",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    scopeSets: [["https://www.googleapis.com/auth/spreadsheets.readonly"], ["https://www.googleapis.com/auth/spreadsheets"]],
    inputSchema: (z) => ({ spreadsheetId: z.string(), range: z.string() }),
    validate: validateSheetRange
  }),
  Object.freeze({
    id: "google-workspace.createSpreadsheet",
    capability: "sheets-write",
    label: "Create Google Sheet",
    description: "Create a new Google Sheet with a title. Creation requires host approval.",
    risk: "external-write",
    approval: "required",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    inputSchema: (z) => ({ title: z.string() }),
    validate: validateTitle
  }),
  Object.freeze({
    id: "google-workspace.appendSheetRows",
    capability: "sheets-write",
    label: "Append Google Sheet rows",
    description: "Append up to 100 rows of plain values to a known sheet range. Update requires host approval.",
    risk: "external-write",
    approval: "required",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    inputSchema: (z) => ({ spreadsheetId: z.string(), range: z.string(), rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1).max(100) }),
    validate: validateSheetAppend
  })
]);

export function validateSearchMail(input = {}) {
  return searchInput(input, "query");
}

export function validateSearchDrive(input = {}) {
  return searchInput(input, "query");
}

export function validateMailDraft(input = {}) {
  const to = Array.isArray(input.to) ? input.to : [];
  const recipients = [...new Set(to.map((value) => String(value || "").trim()).filter(Boolean))];
  if (!recipients.length || recipients.length > 25 || recipients.some((address) => !EMAIL.test(address))) {
    return { ok: false, error: "to must contain 1 through 25 valid email addresses" };
  }
  const subject = plainText(input.subject, "subject", MAX_TITLE_LENGTH, { allowEmpty: true });
  if (!subject.ok) return subject;
  const text = plainText(input.text, "text", MAX_TEXT_LENGTH);
  return text.ok ? { ok: true, input: { to: recipients, subject: subject.value, text: text.value } } : text;
}

export function validateTitle(input = {}) {
  const title = plainText(input.title, "title", MAX_TITLE_LENGTH);
  return title.ok ? { ok: true, input: { title: title.value } } : title;
}

export function validateDocumentAppend(input = {}) {
  const document = opaqueInput(input, "documentId");
  if (!document.ok) return document;
  const text = plainText(input.text, "text", MAX_TEXT_LENGTH);
  return text.ok ? { ok: true, input: { ...document.input, text: text.value } } : text;
}

export function validateSheetRange(input = {}) {
  const spreadsheet = opaqueInput(input, "spreadsheetId");
  if (!spreadsheet.ok) return spreadsheet;
  const range = a1Range(input.range);
  return range.ok ? { ok: true, input: { ...spreadsheet.input, range: range.value } } : range;
}

export function validateSheetAppend(input = {}) {
  const range = validateSheetRange(input);
  if (!range.ok) return range;
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (!rows.length || rows.length > 100 || rows.some((row) => !Array.isArray(row) || row.length > 100)) {
    return { ok: false, error: "rows must contain 1 through 100 rows with at most 100 values each" };
  }
  const normalized = [];
  for (const row of rows) {
    const values = [];
    for (const value of row) {
      if (!["string", "number", "boolean"].includes(typeof value) && value !== null) return { ok: false, error: "sheet values must be strings, numbers, booleans, or null" };
      if (typeof value === "string" && value.length > 10_000) return { ok: false, error: "sheet string values must not exceed 10000 characters" };
      values.push(value == null ? "" : value);
    }
    normalized.push(values);
  }
  return { ok: true, input: { ...range.input, rows: normalized } };
}

function searchInput(input, field) {
  const query = plainText(input[field], field, MAX_QUERY_LENGTH);
  if (!query.ok) return query;
  const maxResults = input.maxResults == null ? 10 : Number(input.maxResults);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 25) return { ok: false, error: "maxResults must be an integer from 1 through 25" };
  return { ok: true, input: { [field]: query.value, maxResults } };
}

function opaqueInput(input, field) {
  const value = String(input[field] || "").trim();
  return OPAQUE_ID.test(value)
    ? { ok: true, input: { [field]: value } }
    : { ok: false, error: `${field} must be an opaque Google resource id` };
}

function a1Range(value) {
  const range = String(value || "").trim();
  if (!range || range.length > 256 || /[\r\n]/.test(range)) return { ok: false, error: "range must be an A1 notation string up to 256 characters" };
  return { ok: true, value: range };
}

function plainText(value, name, maxLength, { allowEmpty = false } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text && !allowEmpty) return { ok: false, error: `${name} is required` };
  if (text.length > maxLength) return { ok: false, error: `${name} must not exceed ${maxLength} characters` };
  if (/[\r\n]/.test(text) && name === "subject") return { ok: false, error: "subject must not contain line breaks" };
  return { ok: true, value: text };
}
