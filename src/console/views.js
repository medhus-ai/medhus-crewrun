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

export function readyForReview(run) {
  return !run.accepted_at && run.desired === "active" && run.status === "completed"
    && (run.actions || []).every((action) => action.status === "delivered" || action.superseded_at);
}

export function reviewableResult(run) {
  return !run.accepted_at && run.desired === "active" && run.status === "completed"
    && (run.actions || []).every((action) => ["delivered", "rejected"].includes(action.status));
}

export function needsAttention(run) {
  return !run.accepted_at && run.desired !== "cancelled" && (
    run.desired === "paused" || run.blocked || ["failed", "interrupted"].includes(run.status)
    || readyForReview(run) || (run.actions || []).some((action) => !action.superseded_at && ["uncertain", "failed", "rejected", "awaiting_approval"].includes(action.status))
  );
}

export function taskOrigin(run) {
  const workflow = String(run.workflow || "manual");
  if (workflow.startsWith("schedule:")) return "Scheduled";
  if (workflow.startsWith("heartbeat")) return "Check-in";
  if (["integration-event", "hook"].includes(workflow)) return "Integration event";
  if (workflow === "connector") return "Integration action";
  return "Manual";
}

export function pendingReviewCount(models) {
  return models.operations.approvals.filter((entry) => entry.status === "pending").length
    + (models.operations.workspaceProposals || []).filter((p) => ["pending", "applying"].includes(p.status)).length
    + models.operations.runs.filter(reviewableResult).length
    + models.skillProposals.length + models.prefProposals.length + models.reflectionProposals.length;
}
