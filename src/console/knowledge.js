import { esc } from "./shell.js";

export function renderKnowledge(models) {
  const state = models.operations.knowledge;
  if (!state) return '<div class="notice">Knowledge setup needs the bundled running host.</div>';
  const form = (action, body) => `<form method="post" action="/settings/knowledge"><input type="hidden" name="action" value="${action}">${body}</form>`;
  const agents = Object.values(models.specs).filter((spec) => spec.contract?.authority?.tools?.some((tool) => tool.name === "workspace.search"));
  const disabled = state.busy || !state.supported;
  return `<section class="section-heading"><h2>Local knowledge search</h2><a class="button secondary tiny" href="/settings?tab=knowledge">Refresh status</a></section>
<div class="card flat"><h3>${esc(state.model)}</h3><p>Find relevant passages in authorized files without sending documents to a cloud model. No API key or Ollama service required.</p>
<div class="list"><div class="list-row"><span>Model and job health</span><span class="pill">${esc(state.status)}</span></div>
<div class="list-row"><span>Search mode</span><span>${state.enabled && state.ready ? "Local hybrid" : "Keyword only"}</span></div>
<div class="list-row"><span>Office/PDF extraction</span><span>${state.docling ? "Docling installed" : "Docling unavailable — see workspace knowledge setup docs"}</span></div></div>
${state.total ? `<p>${esc(state.agent ? "Agent: " + state.agent + " · " : "")}${esc(state.completed)} / ${esc(state.total)} ${state.status === "downloading" ? "bytes" : "items"}</p><progress max="${Number(state.total)}" value="${Number(state.completed)}"></progress>` : ""}
${state.error ? `<p class="notice warn">${esc(state.error)}</p>` : ""}
${!state.supported ? '<p class="notice warn">This host needs Node 22+, QMD and Linux bubblewrap. Unsupported platforms stay disabled.</p>' : ""}
<p class="help"><a href="https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/tree/0f741b5a6585bd53aeb15cd1372c56f2a0f65e12" target="_blank" rel="noopener noreferrer">Pinned model source</a> · Download: approximately ${Math.ceil(state.bytes / 1000000)} MB, plus local indexes. Allow roughly 1–2 GB of memory headroom for one CPU worker; actual use varies. Weights download only after consent. Document text is extracted by Docling, not the embedding model. OCR and spreadsheet calculation are not included.</p>
${form("install", `<label><input type="checkbox" name="consent" value="1" required ${disabled ? "disabled" : ""}> I accept the <a href="https://ai.google.dev/gemma/terms" target="_blank" rel="noopener noreferrer">Gemma model terms</a> and local download.</label><p><button ${disabled ? "disabled" : ""}>${state.ready ? "Verify / repair model" : "Download and set up"}</button></p>`)}
${state.busy ? form("cancel", '<button class="secondary">Cancel job</button><p class="help">Stopping safely may take a few seconds. Retry restarts an incomplete download.</p>') : ""}</div>
<section class="section-heading"><h2>Search preferences</h2></section>
${form("configure", `<div class="form-grid"><div class="field"><label for="knowledge-mode">Embeddings</label><select id="knowledge-mode" name="enabled"><option value="" ${!state.enabled ? "selected" : ""}>None — keyword only</option><option value="1" ${state.enabled ? "selected" : ""} ${!state.ready ? "disabled" : ""}>Local EmbeddingGemma</option></select></div>
<div class="field"><label for="knowledge-fallback">If embeddings are unavailable</label><select id="knowledge-fallback" name="fallback"><option value="1" ${state.fallback ? "selected" : ""}>Use keyword search and report degraded mode</option><option value="" ${!state.fallback ? "selected" : ""}>Fail the hybrid request</option></select></div></div><p><button ${state.busy ? "disabled" : ""}>Save preferences</button></p>`)}
<section class="section-heading"><h2>Build agent index</h2></section><p class="help">Indexes contain only files the selected agent may read. New or changed sources queue a bounded background build; searches use keyword results until it finishes. No shared cross-agent document index. One job runs at a time.</p>
${form("build", `<div class="form-grid"><div class="field"><label for="knowledge-agent">Agent</label><select id="knowledge-agent" name="role">${agents.map((agent) => `<option value="${esc(agent.role)}">${esc(agent.title || agent.role)}</option>`).join("")}</select></div><div class="field"><label for="knowledge-paths">Optional file paths, one per line</label><textarea id="knowledge-paths" name="paths" placeholder="knowledge/notes.md"></textarea><span class="help">Up to 50 authorized files. Leave empty for bounded discovery (100 files; ten changed Office/PDF files).</span></div></div><label><input type="checkbox" name="rebuild" value="1"> Rebuild existing vectors</label><p><button ${disabled || !state.ready || !state.enabled || !agents.length ? "disabled" : ""}>Build / rebuild index</button></p>`)}
${renderWebSources(state.sources || [])}
${state.busy ? '<script>setTimeout(() => { if (!document.hidden && !document.querySelector("form:focus-within")) location.reload(); }, 3000);</script>' : ""}`;
}

const when = (value) => value ? new Date(value).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";
const every = (hours) => ({ 1: "Hourly", 6: "Every 6 hours", 24: "Daily", 168: "Weekly" })[hours] || `Every ${hours} hours`;

// Owner-added public pages and sitemaps saved as Markdown in the workspace for search.
export function renderWebSources(sources) {
  const form = (action, body) => `<form method="post" action="/settings/knowledge" class="inline-form"><input type="hidden" name="action" value="${action}">${body}</form>`;
  const rows = sources.map((source) => {
    const first = source.pages[0]?.file;
    return `<div class="list-row"><div><strong>${esc(source.url)}</strong><p class="faint">${source.kind === "sitemap" ? `Sitemap · up to ${esc(source.maxPages)} pages` : "Web page"} · ${esc(every(source.intervalHours))} · ${esc(source.pages.length)} saved · last checked ${esc(when(source.lastAttemptAt))}${source.lastChangedAt ? ` · changed ${esc(when(source.lastChangedAt))}` : ""}</p>
<p class="faint">Folder: ${first ? `<a href="/workspace?file=${encodeURIComponent(first)}">${esc(source.folder)}</a>` : esc(source.folder)}</p>${source.error ? `<p class="notice warn">${esc(source.error)}</p>` : ""}</div>
<div class="actions"><span class="pill">${esc(source.status)}</span>${form("source_refresh", `<input type="hidden" name="id" value="${esc(source.id)}"><button class="secondary tiny" ${source.status === "refreshing" ? "disabled" : ""}>Refresh now</button>`)}${form("source_remove", `<input type="hidden" name="id" value="${esc(source.id)}"><button class="secondary tiny" title="Removes the saved pages too">Remove</button>`)}</div></div>`;
  }).join("");
  return `<section class="section-heading"><h2>Web sources</h2><span class="faint">${sources.length} source${sources.length === 1 ? "" : "s"}</span></section>
<p class="help">Save public web pages as Markdown in <code>knowledge/sources/</code> and keep them up to date. Agents that can read that folder can search the pages with the same local keyword and embedding search. HTTPS only; private and local network addresses are blocked. A failed refresh keeps the last good copy. Pages are external content: agents treat them as data, not instructions.</p>
${rows ? `<div class="card flat"><div class="list">${rows}</div></div>` : '<div class="empty">No web sources yet.</div>'}
<form method="post" action="/settings/knowledge"><input type="hidden" name="action" value="source_add"><div class="form-grid"><div class="field wide"><label for="source-url">Address</label><input id="source-url" name="url" type="url" required placeholder="https://docs.example.com/guide" maxlength="2000"></div>
<div class="field"><label for="source-kind">Type</label><select id="source-kind" name="kind"><option value="page">Web page</option><option value="sitemap">Sitemap (sitemap.xml)</option></select></div>
<div class="field"><label for="source-interval">Refresh</label><select id="source-interval" name="interval"><option value="1">Hourly</option><option value="6">Every 6 hours</option><option value="24" selected>Daily</option><option value="168">Weekly</option></select></div>
<div class="field"><label for="source-pages">Sitemap page limit</label><input id="source-pages" name="max_pages" type="number" min="1" max="100" value="25"><span class="help">Only pages on the sitemap's own host are saved.</span></div></div><p><button>Add source</button></p></form>`;
}
