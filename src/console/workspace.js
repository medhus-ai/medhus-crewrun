import { esc } from "./shell.js";
import { paginate, pageOptions } from "./views.js";

export function renderWorkspaceReviews(models, options) {
  const proposals = (models.operations.workspaceProposals || []).filter((p) => ["pending", "applying"].includes(p.status));
  const selected = proposals.find((p) => p.id === options.selectedReview);
  const paging = paginate(proposals, pageOptions("/reviews", options, { tab: "workspace" }));
  if (!selected) return `<section class="section-heading"><h2>Workspace changes</h2><span class="muted">${proposals.length} pending</span></section>
    <p class="muted">Use the side helper to prepare setup, agent, skill, and knowledge changes. Existing agent and scheduled-task forms remain available without a model.</p>
    ${paging.items.map((p) => `<section class="card"><a href="/reviews?tab=workspace&review=${encodeURIComponent(p.id)}"><strong>${esc(p.title)}</strong></a><p>${esc(p.role)} · ${p.changes.length} files · ${esc(p.status)}</p></section>`).join("") || '<div class="empty">No workspace changes need review.</div>'}${paging.html}`;
  return `<section class="card"><h2>${esc(selected.title)}</h2><p>${esc(selected.role)} · ${esc(selected.status)}</p><p>Inspect every change. Approval applies this exact content; it does not authorize broader changes.</p>${selected.error ? `<p class="error">${esc(selected.error)}</p>` : ""}<a href="/reviews?tab=workspace">Back to workspace reviews</a></section>
    ${selected.changes.map((change) => `<section class="card"><h3>${esc(change.path)}</h3><details><summary>Current base</summary><pre class="approval-preview">${esc(change.before ?? "New file")}</pre></details><h4>Proposed content</h4><pre class="approval-preview">${esc(change.content)}</pre></section>`).join("")}
    <section class="card"><form class="inline" method="post" action="/workspace/decide"><input type="hidden" name="id" value="${esc(selected.id)}"><input type="hidden" name="action" value="approve"><button>${selected.status === "applying" ? "Retry recovery" : "Approve changes"}</button></form>
    ${selected.status === "pending" ? `<form class="inline" method="post" action="/workspace/decide"><input type="hidden" name="id" value="${esc(selected.id)}"><input type="hidden" name="action" value="reject"><button class="danger">Reject</button></form>
    <details><summary>Edit proposal before approval</summary><form method="post" action="/workspace/revise" class="form-grid"><input type="hidden" name="id" value="${esc(selected.id)}"><div class="field wide"><label>Title<input name="title" value="${esc(selected.title)}" required maxlength="160"></label></div>${selected.changes.map((change, index) => `<div class="field wide"><input type="hidden" name="path_${index}" value="${esc(change.path)}"><label>${esc(change.path)}<textarea name="content_${index}" rows="12" required>${esc(change.content)}</textarea></label></div>`).join("")}<button>Save revised proposal</button></form></details>` : ""}</section>`;
}
