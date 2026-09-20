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
${state.busy ? '<script>setTimeout(() => { if (!document.hidden && !document.querySelector("form:focus-within")) location.reload(); }, 3000);</script>' : ""}`;
}
