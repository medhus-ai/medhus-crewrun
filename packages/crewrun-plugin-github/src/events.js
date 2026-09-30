import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const githubEvents = Object.freeze([
  event("github.push", "repository-events", "Push", "A branch or tag was pushed to an installed repository."),
  event("github.pullRequest", "pull-requests", "Pull request", "A pull request changed in an installed repository."),
  event("github.issue", "issues", "Issue", "An issue changed in an installed repository."),
  event("github.issueComment", "issues", "Issue comment", "An issue or pull-request comment changed in an installed repository."),
  event("github.pullRequestReview", "pull-requests", "Pull-request review", "A pull-request review changed in an installed repository."),
  event("github.repository", "repository-events", "Repository", "A repository installation event was delivered.")
]);

export const githubSubscription = Object.freeze({
  kind: "github-app-webhooks",
  delivery: "webhook",
  manual: true,
  endpoint: "/integrations/webhooks/github",
  events: ["push", "pull_request", "issues", "issue_comment", "pull_request_review", "repository"],
  note: "Configure the GitHub App webhook URL and secret. Each delivery is signed with X-Hub-Signature-256."
});

// GitHub signs exact request bytes. A valid delivery is parsed only after this check succeeds.
export function verifyGitHubWebhook({ headers = {}, rawBody, webhookSecret, connectionId = "" } = {}) {
  const secret = String(webhookSecret || "");
  const signature = header(headers, "x-hub-signature-256");
  const eventName = header(headers, "x-github-event");
  const deliveryId = header(headers, "x-github-delivery");
  if (!secret || !signature || !eventName || !deliveryId) return { ok: false, error: "missing GitHub webhook signature headers" };
  const body = asBuffer(rawBody);
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  if (!equal(signature, expected)) return { ok: false, error: "invalid GitHub webhook signature" };
  let payload;
  try { payload = JSON.parse(body.toString("utf8")); } catch { return { ok: false, error: "invalid GitHub webhook JSON" }; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "GitHub webhook payload must be an object" };
  const normalized = normalizeGitHubEvent({ eventName, deliveryId, payload, connectionId });
  return { ok: true, events: normalized ? [normalized] : [], responseBody: "" };
}

// This is deliberately a metadata-only envelope. It provides routing data but no commit
// message bodies, issue/comment bodies, file contents, headers, or webhook secret.
export function normalizeGitHubEvent({ eventName, deliveryId, payload = {}, connectionId = "" } = {}) {
  const type = eventType(eventName);
  if (!type) return null; // ping and unsupported deliveries are valid but intentionally ignored.
  const repository = repositoryMetadata(payload.repository);
  const installationId = text(payload?.installation?.id, 64);
  const eventId = text(deliveryId, 255) || eventHash({ eventName, repository, installationId, action: text(payload.action, 64) });
  const resource = { ...(repository ? { repository } : {}), ...(numberedSubject(payload) ? { subject: numberedSubject(payload) } : {}), ...(text(payload.ref, 512) ? { ref: text(payload.ref, 512) } : {}) };
  const summary = {
    ...(text(payload.action, 64) ? { action: text(payload.action, 64) } : {}),
    ...(sender(payload.sender) ? { sender: sender(payload.sender) } : {}),
    ...(text(payload?.installation?.account?.login, 128) ? { installationAccount: text(payload.installation.account.login, 128) } : {})
  };
  const occurredAt = githubTime(payload);
  const item = {
    providerEventId: `github:${eventId}`,
    id: `github:${eventId}`,
    provider: "github",
    type,
    ...(connectionId ? { connectionId: String(connectionId) } : {}),
    ...(installationId ? { accountId: installationId } : {}),
    resource,
    summary,
    occurredAt
  };
  // Registry consumers expect a safe integration event shape. These redundant fields make the
  // same normalizer useful both at raw webhook ingress and in the generic SDK registry.
  if (connectionId) {
    item.subject = repository ? { id: String(repository.id || ""), label: repository.fullName, ...(repository.url ? { url: repository.url } : {}) } : null;
    item.metadata = { ...resource, ...summary };
    item.receivedAt = new Date().toISOString();
  }
  return item;
}

function event(id, capability, label, description) { return Object.freeze({ id, capability, label, description, delivery: "webhook", retention: "metadata", scopes: ["webhooks:read"] }); }
function eventType(value) {
  return ({ push: "github.push", pull_request: "github.pullRequest", issues: "github.issue", issue_comment: "github.issueComment", pull_request_review: "github.pullRequestReview", repository: "github.repository" })[String(value || "")] || "";
}
function repositoryMetadata(value) {
  if (!value || typeof value !== "object") return null;
  const id = text(value.id, 64); const fullName = text(value.full_name, 256); const url = safeUrl(value.html_url);
  return id || fullName || url ? { ...(id ? { id } : {}), ...(fullName ? { fullName } : {}), ...(url ? { url } : {}) } : null;
}
function numberedSubject(payload) {
  const source = payload.pull_request || payload.issue || payload.comment;
  const number = Number(payload.number || source?.number || 0);
  const url = safeUrl(source?.html_url || payload.comment?.html_url);
  return Number.isInteger(number) && number > 0 ? { number, ...(url ? { url } : {}) } : null;
}
function sender(value) { const login = text(value?.login, 128); const id = text(value?.id, 64); return login || id ? { ...(login ? { login } : {}), ...(id ? { id } : {}) } : null; }
function githubTime(payload) { const source = payload.pull_request || payload.issue || payload.repository || {}; const candidate = source.updated_at || source.pushed_at || payload?.head_commit?.timestamp || payload?.repository?.updated_at; const parsed = new Date(candidate); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString(); }
function header(headers, name) { const expected = name.toLowerCase(); for (const [key, value] of Object.entries(headers || {})) if (String(key).toLowerCase() === expected) return Array.isArray(value) ? String(value[0] || "") : String(value || ""); return ""; }
function asBuffer(value) { return Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value ?? ""), "utf8"); }
function equal(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }
function text(value, max) { return typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, max) : ""; }
function safeUrl(value) { const result = text(value, 2_048); try { const url = new URL(result); return url.protocol === "https:" ? url.toString() : ""; } catch { return ""; } }
function eventHash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 48); }
