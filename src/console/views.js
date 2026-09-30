import { esc } from "./shell.js";
import { nextRun, parseCron } from "../schedules.js";

export function pageNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, 1000) : 1;
}

export function pageOptions(base, options = {}, params = {}, key = "page") {
  return { base, page: key === "page" ? options.page : options.pageParams?.[key], key, params: { ...options.pageParams, ...params } };
}

export function paginate(items, { page = 1, size = 10, base, params = {}, key = "page", openEnded = false } = {}) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(pageNumber(page), pages);
  const offset = (current - 1) * size;
  const url = (number) => esc(`${base}?${new URLSearchParams({ ...params, [key]: number })}`);
  const html = items.length > size ? `<nav class="pagination" aria-label="Pagination">
    ${current > 1 ? `<a class="button secondary tiny" href="${url(current - 1)}" rel="prev">Previous</a>` : '<span class="muted">Previous</span>'}
    <span class="muted">${offset + 1}–${Math.min(offset + size, items.length)}${openEnded ? "" : ` of ${items.length}`} · Page ${current}${openEnded ? "" : ` of ${pages}`}</span>
    ${current < pages ? `<a class="button secondary tiny" href="${url(current + 1)}" rel="next">Next</a>` : '<span class="muted">Next</span>'}
  </nav>` : "";
  return { items: items.slice(offset, offset + size), html, page: current };
}

// Project recurring definitions through the existing cron parser; never enqueue work.
export function upcomingOccurrences(schedules, { from = new Date(), limit = 4 } = {}) {
  const queue = schedules.filter((task) => task.enabled).flatMap((task) => {
    const cron = parseCron(task.cron);
    const next = nextRun(cron, from, { timezone: task.timezone });
    return next ? [{ task, cron, next }] : [];
  });
  const results = [];
  while (queue.length && results.length < limit) {
    queue.sort((a, b) => a.next - b.next || `${a.task.role}:${a.task.id}`.localeCompare(`${b.task.role}:${b.task.id}`));
    const entry = queue.shift();
    results.push({ ...entry.task, nextRunAt: entry.next.toISOString() });
    entry.next = nextRun(entry.cron, entry.next, { timezone: entry.task.timezone });
    if (entry.next) queue.push(entry);
  }
  return results;
}

export function tabs(base, entries, active, params = {}) {
  return `<nav class="agent-tabs" aria-label="Page views">${entries.map(([id, label]) => {
    const query = new URLSearchParams({ ...params, tab: id });
    return `<a class="agent-tab${active === id ? " active" : ""}"${active === id ? ' aria-current="page"' : ""} href="${esc(`${base}?${query}`)}">${esc(label)}</a>`;
  }).join("")}</nav>`;
}

export function reviewableResult(run) {
  return !run.accepted_at && run.desired === "active" && run.status === "completed"
    && (run.actions || []).every((action) => ["delivered", "rejected"].includes(action.status));
}

// Where a task belongs in the Inbox. Approvals themselves are listed under the
// Approvals tab; their tasks stay "in progress" until the owner decides.
//   answer   — the agent asked the owner a question
//   accept   — finished work waits for the owner to accept it
//   problem  — paused, blocked, failed, interrupted, or a delivery to reconcile
//   progress — queued, running, or waiting on an approval
//   done     — accepted, cancelled, or completed with nothing left to decide
export function inboxState(run) {
  if (run.accepted_at || run.desired === "cancelled") return "done";
  if ((run.questions || []).some((question) => !question.answered_at)) return "answer";
  if (reviewableResult(run)) return "accept";
  const actions = (run.actions || []).filter((action) => !action.superseded_at);
  if (run.desired === "paused" || run.blocked || ["failed", "interrupted"].includes(run.status)
    || actions.some((action) => ["uncertain", "failed", "rejected"].includes(action.status))) return "problem";
  if (run.status === "completed" && !actions.some((action) => action.status !== "delivered")) return "done";
  return "progress";
}

export function needsOwner(run) {
  return ["answer", "accept", "problem"].includes(inboxState(run));
}

export function taskOrigin(run) {
  const workflow = String(run.workflow || "manual");
  if (workflow.startsWith("schedule:")) return "Scheduled";
  if (workflow.startsWith("heartbeat")) return "Check-in";
  if (["integration-event", "hook"].includes(workflow)) return "Integration event";
  if (workflow === "connector") return "Integration action";
  return "Manual";
}

export function pendingApprovalCount(models) {
  return models.operations.approvals.filter((entry) => entry.status === "pending").length
    + (models.operations.workspaceProposals || []).filter((p) => ["pending", "applying"].includes(p.status)).length
    + models.skillProposals.length + models.prefProposals.length + models.reflectionProposals.length;
}

// Setup items that need the owner: agent configuration problems and broken connections.
export function setupAttention(models) {
  const items = [
    ...(models.validation?.problems || []).map((text) => ({ kind: "configuration", text, href: "/agents" })),
    ...(models.validation?.warnings || []).map((text) => ({ kind: "configuration", text, href: "/agents" }))
  ];
  for (const connector of models.operations.connectors || []) {
    if (connector.status === "needs_reconnect" || connector.state === "needs_reconnect") {
      items.push({ kind: "integration", text: `${connector.label || connector.id} needs to be reconnected.`, href: `/integrations?integration=${encodeURIComponent(connector.id)}` });
    }
  }
  return items;
}

export function inboxCount(models) {
  return models.operations.runs.filter(needsOwner).length + setupAttention(models).length + pendingApprovalCount(models);
}
