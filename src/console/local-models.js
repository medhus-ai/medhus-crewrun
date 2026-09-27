import { LOCAL_MODEL_CATALOG, catalogModel, setupSteps } from "../local-models.js";
import { esc } from "./shell.js";

const FIT_TONE = { unified: "success", gpu: "success", "gpu+ram": "info", ram: "warn" };

// Settings → Local models. `state` comes from the console server:
// { recommendation, runtimeInstalled, runners, selected, status, message }.
export function renderLocalModels(state = {}) {
  const { recommendation, runtimeInstalled = false, runners = [], status = "", message = "" } = state;
  const runtime = recommendation?.runtime || null;
  const hardware = recommendation?.hardware || {};
  const selectedId = catalogModel(state.selected)?.id || recommendation?.recommended || "";
  const selected = recommendation?.options.find((option) => option.model.id === selectedId && (option.model.id === recommendation.recommended || (option.fit && option.diskOk))) || recommendation?.options.find((option) => option.model.id === recommendation?.recommended) || null;
  const statusNotice = status ? `<div class="notice ${status === "ok" ? "" : "warn"}">${esc(message || (status === "ok" ? "Saved." : "Something went wrong."))}</div>` : "";

  const gpuText = hardware.gpus?.length
    ? hardware.gpus.map((gpu) => `${esc(gpu.name)} (${esc(gpu.memoryGb)} GB)`).join(", ")
    : hardware.unifiedMemory ? "Apple Silicon (shared memory)" : "No NVIDIA GPU detected";
  const machine = `<div class="card flat"><div class="section-heading" style="margin-top:0"><h2>This computer</h2></div><div class="list">
    <div class="list-row"><span>Memory</span><span>${esc(hardware.memoryGb)} GB</span></div>
    <div class="list-row"><span>Graphics</span><span>${gpuText}</span></div>
    <div class="list-row"><span>Free disk</span><span>${hardware.freeDiskGb == null ? "unknown" : `${esc(hardware.freeDiskGb)} GB`}</span></div>
    <div class="list-row"><span>Local runtime</span><span>${runtime ? `${esc(runtime.label)} · <span class="pill ${runtimeInstalled ? "success" : "warn"}">${runtimeInstalled ? "installed" : "not installed"}</span>` : "not supported on this computer"}</span></div>
  </div></div>`;

  if (!runtime) {
    return `${statusNotice}<section class="section-heading"><h2>Local models</h2></section>${machine}
<div class="notice warn">Local models run with oMLX on Apple Silicon Macs and with llama.cpp on Linux and Windows. Use a cloud model profile on this computer.</div>`;
  }

  const rows = (recommendation?.options || []).map((option) => {
    const size = runtime.format === "mlx" ? option.model.mlx.sizeGb : option.model.gguf.sizeGb;
    const recommended = option.model.id === recommendation.recommended;
    return `<tr><td><strong>${esc(option.model.label)}</strong>${recommended ? ' <span class="pill success">recommended</span>' : ""}<br><span class="help">${esc(option.model.notes)}</span></td>
      <td>${esc(size)} GB</td><td>${esc(option.model.memoryGb)} GB</td>
      <td><span class="pill ${!option.fit ? "" : !option.diskOk ? "warn" : FIT_TONE[option.fit]}">${esc(option.diskOk ? option.fitLabel : "not enough free disk")}</span></td>
      <td>${option.fit && option.diskOk ? `<a class="button secondary tiny" href="/settings?tab=local&model=${encodeURIComponent(option.model.id)}#setup">Set up</a>` : ""}</td></tr>`;
  }).join("");
  const catalogTable = `<div class="table-wrap"><table><thead><tr><th>model</th><th>download</th><th>memory needed</th><th>on this computer</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;

  const steps = selected?.fit ? setupSteps(runtime, selected.model, { fit: selected.fit, platform: hardware.platform }) : [];
  const setup = selected
    ? `<section id="setup" class="section-heading"><h2>Set up ${esc(selected.model.label)}</h2></section>
<div class="card flat">${steps.length
      ? `<ol class="setup-steps">${steps.map((step) => `<li><p><strong>${esc(step.title)}</strong></p><pre><code>${esc(step.command)}</code></pre>${step.note ? `<p class="help">${esc(step.note)}</p>` : ""}</li>`).join("")}</ol>
<p class="help">Run these once in a terminal and leave the server running. CrewRun does not download weights or start the server for you yet.</p>`
      : '<p class="help">This model is too large for this computer.</p>'}</div>`
    : `<div class="notice warn">None of the supported local models fit this computer's memory and free disk. Use a cloud model profile, or free disk space and check again.</div>`;

  const defaultModel = selected ? (runtime.id === "llama-cpp" ? selected.model.id : "") : "";
  const connect = `<section class="section-heading"><h2>Connect the running server</h2></section>
<form method="post" action="/settings/local/connect" autocomplete="off" class="card flat">
  <input type="hidden" name="runtime" value="${esc(runtime.id)}">
  <div class="form-grid">
    <div class="field"><label for="local-base-url">Server address</label><input id="local-base-url" name="base_url" value="${esc(runtime.defaultBaseUrl)}" spellcheck="false"><span class="help">${esc(runtime.label)} listens on ${esc(runtime.defaultBaseUrl)} by default.</span></div>
    <div class="field"><label for="local-model">Model name</label><input id="local-model" name="model" value="${esc(defaultModel)}" spellcheck="false" placeholder="first model the server lists"><span class="help">${runtime.id === "llama-cpp" ? "The --alias from the start command." : "Leave blank to use the model oMLX lists first."}</span></div>
  </div>
  <p><button>Check and connect</button></p>
  <p class="help">CrewRun sends two short test requests. The first request may take a minute while the model loads.</p>
</form>`;

  const connected = `<section class="section-heading"><h2>Connected local models</h2></section>
${runners.length ? `<div class="table-wrap"><table><thead><tr><th>name</th><th>address</th><th>last check</th><th></th></tr></thead><tbody>${runners.map((runner) => {
    const check = runner.last_check;
    const state = !check ? "not checked" : !check.ok ? "failed" : check.tools ? "ready" : "no tool use";
    return `<tr><td><strong>${esc(runner.display_name || runner.id)}</strong><br><code>${esc(runner.model)}</code></td><td><code>${esc(runner.base_url)}</code></td>
      <td><span class="pill ${state === "ready" ? "success" : "warn"}">${esc(state)}</span></td>
      <td><form method="post" action="/settings/local/connect" style="display:inline"><input type="hidden" name="base_url" value="${esc(runner.base_url)}"><input type="hidden" name="model" value="${esc(runner.model)}"><input type="hidden" name="runtime" value="${esc(runner.local_runtime || runtime.id)}"><button class="secondary tiny">Check again</button></form>
      <form method="post" action="/settings/local/remove" style="display:inline"><input type="hidden" name="id" value="${esc(runner.id)}"><button class="secondary tiny">Remove</button></form></td></tr>`;
  }).join("")}</tbody></table></div>
<p class="help">Assign a connected model to an agent from that agent's behavior settings. Local models run on this computer; prompts and files do not leave it.</p>`
    : '<p class="muted">No local models connected yet.</p>'}`;

  return `${statusNotice}<section class="section-heading"><h2>Local models</h2><a class="button secondary tiny" href="/settings?tab=local">Refresh</a></section>
<p class="help">CrewRun supports a small set of tested models and recommends one for this computer. ${esc(runtime.label)} serves them locally through the same governed tool bridge as cloud models.</p>
${machine}
<section class="section-heading"><h2>Supported models</h2><span class="muted">${LOCAL_MODEL_CATALOG.length} tested</span></section>
${catalogTable}
${setup}
${connect}
${connected}`;
}
