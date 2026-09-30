import { esc } from "./shell.js";
import { reviewableResult, taskOrigin, paginate, pageOptions } from "./views.js";

const time = (value) => value ? new Date(value).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
const label = (value) => String(value || "").replaceAll("_", " ");
const control = (path, id, action, title) => `<form class="inline" method="post" action="${path}"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="action" value="${action}"><button class="tiny">${title}</button></form>`;

export const taskUrl = (id) => `/inbox?run=${encodeURIComponent(id)}`;

export function taskStatus(r) {
  if (r.accepted_at) return "accepted";
  if (r.desired !== "active") return r.desired;
  if ((r.questions || []).some((q) => !q.answered_at)) return "waiting for you";
  if (r.blocked) return "blocked";
  for (const [state, title] of [["uncertain", "delivery uncertain"], ["failed", "delivery failed"], ["rejected", "delivery rejected"], ["awaiting_approval", "awaiting approval"], ["retry_wait", "delivery retry scheduled"], ["dispatching", "sending"], ["queued", "awaiting delivery"]]) {
    if ((r.actions || []).some((a) => a.status === state && !a.superseded_at)) return title;
  }
  return r.status === "completed" ? "ready to accept" : r.status;
}

// A compact list of tasks for one Inbox view. `params` keep the view's own query
// (tab and page key) in pagination links.
export function renderTaskList(runs, options = {}, { params = {}, key = "page", emptyText = "Nothing here." } = {}) {
  const paging = paginate(runs, pageOptions("/inbox", options, params, key));
  if (!runs.length) return `<div class="empty">${esc(emptyText)}</div>`;
  return `<div class="task-list">${paging.items.map((r) => `<section class="card"><div class="card-head"><a href="${esc(taskUrl(r.id))}"><strong>${esc((r.title || r.prompt).slice(0, 160))}</strong></a><span class="pill">${esc(label(taskStatus(r)))}</span></div><p class="faint">${esc(r.agent)} · ${esc(taskOrigin(r))} · ${time(r.created_at)}</p><p>${esc(r.nextAction)}</p></section>`).join("")}</div>${paging.html}`;
}

export function renderTaskDetail(run, options = {}) {
  const { canManageTasks = false, canCheckDelivery = false } = options;
  const canAccept = reviewableResult(run);
  const detailPage = (items, key) => paginate(items, pageOptions("/inbox", options, { run: run.id }, key));
  const artifacts = detailPage(run.artifacts, "results_page");
  const deliveries = detailPage(run.actions, "deliveries_page");
  const timeline = detailPage(run.timeline, "timeline_page");
  const buttons = !canManageTasks || run.accepted_at ? "" : [
    canAccept ? control("/tasks/control", run.id, "accept", "Accept result") : "",
    run.desired === "paused" && run.status !== "running" ? control("/tasks/control", run.id, "resume", "Resume") : "",
    ["failed", "interrupted"].includes(run.status) && run.desired === "active" ? control("/tasks/control", run.id, "retry", "Retry task") : "",
    run.desired === "active" ? control("/tasks/control", run.id, "pause", "Pause") : "",
    run.desired !== "cancelled" ? control("/tasks/control", run.id, "cancel", "Cancel") : ""
  ].join(" ");
  const questions = (run.questions || []).map((q) => `<section class="card"><h2>${q.answered_at ? "Answered question" : "Your answer is needed"}</h2><p>${esc(q.question)}</p>${q.answered_at ? `<p>${esc(q.answer)}</p>` : `<form method="post" action="/tasks/answer" class="form-grid"><input type="hidden" name="id" value="${esc(q.id)}">${(q.options || []).map((answer) => `<button class="secondary" name="answer" value="${esc(answer)}">${esc(answer)}</button>`).join("")}</form><form method="post" action="/tasks/answer" class="form-grid"><input type="hidden" name="id" value="${esc(q.id)}"><div class="field wide"><label>Your answer<textarea name="answer" required maxlength="10000" rows="3"></textarea></label></div><button>Answer and continue</button></form>`}</section>`).join("");
  const revision = canManageTasks && canAccept ? `<section class="card"><form method="post" action="/tasks/control" class="form-grid"><input type="hidden" name="id" value="${esc(run.id)}"><input type="hidden" name="action" value="request_changes"><div class="field wide"><label>What needs changing?<textarea name="feedback" rows="3" required maxlength="10000"></textarea></label></div><p class="help">Previously rejected sends remain unsent and become historical requests. Any new external write still requires its own approval.</p><button class="secondary">Request changes</button></form></section>` : "";
  return `<section class="hero"><div><h1>${esc(run.title || "Task")}</h1><p class="sub">${esc(run.agent)} · ${esc(taskOrigin(run))} · ${esc(label(taskStatus(run)))} · ${time(run.created_at)}</p><a href="/inbox">Back to inbox</a>${run.workflow?.startsWith("schedule:") ? ` · <a href="/scheduled?role=${encodeURIComponent(run.agent)}&task=${encodeURIComponent(run.workflow.split(":").slice(2).join(":"))}">Open scheduled task</a>` : ""}</div><div>${buttons}</div></section>
    ${questions}${canAccept ? '<div class="notice">This result is finished. Accept it, or request changes below.</div>' : ""}${revision}<section class="card"><h2>${esc(run.title || "Requested result")}</h2><p class="approval-preview">${esc(run.prompt)}</p><p>Priority: ${esc(run.priority || "normal")}</p>${run.outcome ? `<p><strong>Outcome:</strong> ${esc(run.outcome)}</p>` : ""}${run.criteria ? `<p><strong>Completion criteria:</strong> ${esc(run.criteria)}</p>` : ""}${run.progress ? `<p><strong>Progress:</strong> ${esc(run.progress)}</p>` : ""}${(run.blockers || []).map((b) => `<p>Blocked: ${esc(b.reason)}</p>`).join("")}${run.parent_id ? `<p><a href="${esc(taskUrl(run.parent_id))}">Parent task</a></p>` : ""}<p><strong>Next action:</strong> ${esc(run.nextAction)}</p>${run.error ? `<p class="approval-preview">${esc(run.error)}</p>` : ""}${run.dependencies.length ? `<p>Dependencies: ${run.dependencies.map((d) => `<a href="${esc(taskUrl(d.id))}">${esc(d.id)}</a> (${d.accepted ? "accepted" : "awaiting acceptance"})`).join(", ")}</p>` : ""}</section>
    <section class="section-heading"><h2>Saved results</h2></section>${run.artifacts.length ? artifacts.items.map((a) => `<details class="card" open><summary>${esc(a.name)}</summary><p class="faint">${time(a.created_at)} · <a href="/tasks/artifact?id=${esc(a.id)}">Download</a></p><pre class="approval-preview">${esc(a.content)}</pre></details>`).join("") : `<div class="empty">No result has been saved yet.</div>`}${artifacts.html}
    <section class="section-heading"><h2>Deliveries</h2></section>${deliveries.items.map((a) => `<section class="card"><h3>${esc(a.action)} <span class="pill">${esc(a.status === "delivered" ? "provider accepted" : label(a.status))}</span></h3><pre class="approval-preview">${esc(a.summary)}</pre>
      <p class="faint">Attempt ${a.attempt}${a.status === "retry_wait" ? ` · Retry after ${time(a.available_at)}` : ""}</p>${a.error ? `<p>${esc(a.error)}</p>` : ""}${a.receipt ? `<p><strong>External receipt</strong></p><pre class="approval-preview">${esc(JSON.stringify(a.receipt, null, 2))}</pre>` : ""}
      ${a.status === "awaiting_approval" ? `<a class="button" href="/inbox?tab=approvals&review=${encodeURIComponent(a.id)}">Review action</a>` : ""}
      ${canManageTasks && ["uncertain", "failed"].includes(a.status) ? `${a.status === "uncertain" && canCheckDelivery ? control("/tasks/check-delivery", a.id, "check", "Check provider for receipt") : ""}<details><summary>Record what happened</summary><form method="post" action="/tasks/reconcile" class="form-grid"><input type="hidden" name="id" value="${esc(a.id)}"><div class="field"><label for="outcome-${a.id}">Delivery outcome</label><select id="outcome-${a.id}" name="outcome"><option value="delivered">Delivered</option><option value="not_sent">Verified not sent — request a new approval</option></select></div><div class="field"><label for="receipt-${a.id}">Receipt or message link</label><input id="receipt-${a.id}" name="receipt" maxlength="2000"></div><div class="field wide"><label for="evidence-${a.id}">Evidence</label><textarea id="evidence-${a.id}" name="evidence" required maxlength="4000" placeholder="Describe what you checked at the provider. An empty search alone does not prove non-delivery."></textarea></div><button>Save reconciliation</button></form></details>` : ""}</section>`).join("") || `<div class="empty">No external deliveries requested.</div>`}
    ${deliveries.html}<section class="section-heading"><h2>Timeline</h2></section><div class="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Details</th></tr></thead><tbody>${timeline.items.map((e) => `<tr><td>${time(e.created_at)}</td><td>${esc(label(e.type.replaceAll(".", " ")))}</td><td><pre class="approval-preview">${esc(JSON.stringify(e.data, null, 2))}</pre></td></tr>`).join("")}</tbody></table></div>${timeline.html}`;
}
