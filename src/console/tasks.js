import { esc } from "./shell.js";

const time = (value) => value ? new Date(value).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
const label = (value) => String(value || "").replaceAll("_", " ");
const control = (path, id, action, title) => `<form class="inline" method="post" action="${path}"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="action" value="${action}"><button class="tiny">${title}</button></form>`;

export function renderTasks(models, { selectedRun = "", canManageTasks = false } = {}) {
  const runs = models.operations.runs || [];
  const run = runs.find((r) => r.id === selectedRun);
  const status = (r) => {
    if (r.accepted_at) return "accepted";
    if (r.desired !== "active") return r.desired;
    if (r.blocked) return "blocked by dependencies";
    for (const [state, title] of [["uncertain", "delivery uncertain"], ["failed", "delivery failed"], ["rejected", "delivery rejected"], ["awaiting_approval", "awaiting approval"], ["retry_wait", "delivery retry scheduled"], ["dispatching", "sending"], ["queued", "awaiting delivery"]]) if (r.actions.some((a) => a.status === state)) return title;
    return r.status === "completed" ? "ready for review" : r.status;
  };
  const form = canManageTasks ? `<details class="card"><summary>Create a task</summary><form method="post" action="/tasks/create" class="form-grid">
    <div class="field"><label for="task-agent">Agent</label><select id="task-agent" name="agent" required>${Object.keys(models.specs).map((id) => `<option value="${esc(id)}">${esc(models.specs[id].title || id)}</option>`).join("")}</select></div>
    <div class="field wide"><label for="task-prompt">What should be delivered?</label><textarea id="task-prompt" name="prompt" required maxlength="100000" rows="4" placeholder="Describe the result you need and how you will judge it."></textarea></div>
    <div class="field wide"><label for="task-dependencies">Depends on tasks</label><select id="task-dependencies" name="dependency"><option value="">No dependency</option>${runs.map((r) => `<option value="${esc(r.id)}">${esc(r.agent)} · ${esc(r.prompt.slice(0, 70))}</option>`).join("")}</select><span class="help">The dependency must be accepted before this task starts.</span></div><button>Create task</button></form></details>` : "";
  if (!run) return `<section class="hero"><div><p class="eyebrow">Tasks</p><h1>Tasks and results</h1><p class="sub">Follow work from request to accepted deliverable. Review results, delivery receipts, and the next action.</p></div></section>${form}
    <section class="section-heading"><h2>Recent work</h2><span class="muted">${runs.length} tasks</span></section>
    ${runs.length ? runs.map((r) => `<section class="card"><div class="card-head"><a href="/tasks?run=${esc(r.id)}"><strong>${esc(r.prompt.slice(0, 160))}</strong></a><span class="pill">${esc(label(status(r)))}</span></div><p class="faint">${esc(r.agent)} · ${time(r.created_at)}</p><p>${esc(r.nextAction)}</p></section>`).join("") : `<div class="empty">No tasks yet. Create one here or enable an agent's scheduled work.</div>`}`;

  const canAccept = !run.accepted_at && run.desired === "active" && run.status === "completed" && run.actions.every((a) => a.status === "delivered");
  const buttons = !canManageTasks || run.accepted_at ? "" : [
    canAccept ? control("/tasks/control", run.id, "accept", "Accept deliverable") : "",
    run.desired === "paused" && run.status !== "running" ? control("/tasks/control", run.id, "resume", "Resume") : "",
    ["failed", "interrupted"].includes(run.status) && run.desired === "active" ? control("/tasks/control", run.id, "retry", "Retry task") : "",
    run.desired === "active" ? control("/tasks/control", run.id, "pause", "Pause") : "",
    run.desired !== "cancelled" ? control("/tasks/control", run.id, "cancel", "Cancel") : ""
  ].join(" ");
  return `<section class="hero"><div><p class="eyebrow"><a href="/tasks">Tasks</a> / ${esc(run.agent)}</p><h1>Task result</h1><p class="sub">${esc(label(status(run)))} · ${time(run.created_at)}</p></div><div>${buttons}</div></section>
    <section class="card"><h2>Requested result</h2><p class="approval-preview">${esc(run.prompt)}</p><p><strong>Next action:</strong> ${esc(run.nextAction)}</p>${run.error ? `<p class="approval-preview">${esc(run.error)}</p>` : ""}${run.dependencies.length ? `<p>Dependencies: ${run.dependencies.map((d) => `<a href="/tasks?run=${esc(d.id)}">${esc(d.id)}</a> (${d.accepted ? "accepted" : "awaiting acceptance"})`).join(", ")}</p>` : ""}</section>
    <section class="section-heading"><h2>Saved results</h2></section>${run.artifacts.length ? run.artifacts.map((a) => `<details class="card" open><summary>${esc(a.name)}</summary><p class="faint">${time(a.created_at)} · <a href="/tasks/artifact?id=${esc(a.id)}">Download</a></p><pre class="approval-preview">${esc(a.content)}</pre></details>`).join("") : `<div class="empty">No result has been saved yet.</div>`}
    <section class="section-heading"><h2>Deliveries</h2></section>${run.actions.map((a) => `<section class="card"><h3>${esc(a.action)} <span class="pill">${esc(a.status === "delivered" ? "provider accepted" : label(a.status))}</span></h3><pre class="approval-preview">${esc(a.summary)}</pre>
      <p class="faint">Attempt ${a.attempt}${a.status === "retry_wait" ? ` · Retry after ${time(a.available_at)}` : ""}</p>${a.error ? `<p>${esc(a.error)}</p>` : ""}${a.receipt ? `<p><strong>External receipt</strong></p><pre class="approval-preview">${esc(JSON.stringify(a.receipt, null, 2))}</pre>` : ""}
      ${a.status === "awaiting_approval" ? `<a class="button" href="/approvals">Review approval</a>` : ""}
      ${canManageTasks && ["uncertain", "failed"].includes(a.status) ? `${a.status === "uncertain" ? control("/tasks/check-delivery", a.id, "check", "Check provider for receipt") : ""}<details><summary>Record what happened</summary><form method="post" action="/tasks/reconcile" class="form-grid"><input type="hidden" name="id" value="${esc(a.id)}"><div class="field"><label for="outcome-${a.id}">Delivery outcome</label><select id="outcome-${a.id}" name="outcome"><option value="delivered">Delivered</option><option value="not_sent">Verified not sent — request a new approval</option></select></div><div class="field"><label for="receipt-${a.id}">Receipt or message link</label><input id="receipt-${a.id}" name="receipt" maxlength="2000"></div><div class="field wide"><label for="evidence-${a.id}">Evidence</label><textarea id="evidence-${a.id}" name="evidence" required maxlength="4000" placeholder="Describe what you checked at the provider. An empty search alone does not prove non-delivery."></textarea></div><button>Save reconciliation</button></form></details>` : ""}</section>`).join("") || `<div class="empty">No external deliveries requested.</div>`}
    <section class="section-heading"><h2>Timeline</h2></section><div class="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Details</th></tr></thead><tbody>${run.timeline.map((e) => `<tr><td>${time(e.created_at)}</td><td>${esc(label(e.type.replaceAll(".", " ")))}</td><td><pre class="approval-preview">${esc(JSON.stringify(e.data, null, 2))}</pre></td></tr>`).join("")}</tbody></table></div>`;
}
