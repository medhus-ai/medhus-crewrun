// Local models: one supported runtime per platform, a short curated model list,
// and a hardware-based recommendation. llama.cpp (`llama-server`) runs local
// models on Linux and Windows; oMLX runs them on Apple Silicon macOS. Both expose
// the Anthropic Messages API (`/v1/messages`) and `/v1/models`, so a connected
// server becomes an ordinary `provider: "local"` runner on the Claude engine.
//
// This module only detects, recommends, checks and registers. Installing the
// runtime and downloading weights stay explicit owner steps shown in Settings;
// a managed install/download flow is tracked in docs/local-models.md.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { crewHome } from "./crew-dirs.js";
import { resolveExecutable } from "./platform.js";
import { globalRunnerConfigPath, loadGlobalRunnerConfig, saveGlobalRunnerConfig } from "./runner-config.js";

const GB = 1e9;
const MODELS_TIMEOUT_MS = 5_000;
const MESSAGE_TIMEOUT_MS = 120_000; // first request may load weights from disk

export const LOCAL_RUNTIMES = {
  "llama-cpp": {
    id: "llama-cpp",
    label: "llama.cpp",
    command: "llama-server",
    defaultBaseUrl: "http://127.0.0.1:8080",
    docsUrl: "https://github.com/ggml-org/llama.cpp",
    format: "gguf"
  },
  omlx: {
    id: "omlx",
    label: "oMLX",
    command: "omlx",
    defaultBaseUrl: "http://127.0.0.1:8000",
    docsUrl: "https://github.com/jundot/omlx",
    format: "mlx"
  }
};

// Curated, tool-capable, openly licensed models. Sizes are the published file
// sizes of the named quantization; `memoryGb` is a conservative working-set
// estimate (weights, KV cache for ~32k context, runtime overhead). Ordered from
// strongest to lightest; the recommender takes the first entry that fits.
export const LOCAL_MODEL_CATALOG = [
  {
    id: "gpt-oss-120b",
    label: "gpt-oss 120B",
    notes: "Strongest local option; mixture-of-experts (5.1B active).",
    license: "apache-2.0",
    moe: true,
    memoryGb: 72,
    gguf: { repo: "ggml-org/gpt-oss-120b-GGUF", quant: "MXFP4", file: "gpt-oss-120b-MXFP4.gguf", sizeGb: 63.4 },
    mlx: { repo: "mlx-community/gpt-oss-120b-MXFP4-Q8", sizeGb: 63.4 }
  },
  {
    id: "qwen3.6-35b-a3b",
    label: "Qwen3.6 35B-A3B",
    notes: "Fast mixture-of-experts (3B active); good coding and tool use.",
    license: "apache-2.0",
    moe: true,
    memoryGb: 28,
    gguf: { repo: "unsloth/Qwen3.6-35B-A3B-GGUF", quant: "UD-Q4_K_M", file: "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", sizeGb: 22.1 },
    mlx: { repo: "lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit", sizeGb: 20.4 }
  },
  {
    id: "qwen3.8-27b",
    label: "Qwen3.8 27B",
    notes: "Dense 27B; strong agent quality, slower without a large GPU.",
    license: "apache-2.0",
    moe: false,
    memoryGb: 22,
    gguf: { repo: "unsloth/Qwen3.8-27B-GGUF", quant: "UD-Q4_K_M", file: "Qwen3.8-27B-UD-Q4_K_M.gguf", sizeGb: 16.5 },
    mlx: { repo: "lmstudio-community/Qwen3.8-27B-MLX-4bit", sizeGb: 16.1 }
  },
  {
    id: "gemma-4-26b-a4b",
    label: "Gemma 4 26B-A4B",
    notes: "Mixture-of-experts (4B active); balanced speed and quality.",
    license: "apache-2.0",
    moe: true,
    memoryGb: 22,
    gguf: { repo: "unsloth/gemma-4-26B-A4B-it-GGUF", quant: "UD-Q4_K_M", file: "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf", sizeGb: 17.0 },
    mlx: { repo: "lmstudio-community/gemma-4-26B-A4B-it-MLX-4bit", sizeGb: 15.6 }
  },
  {
    id: "gpt-oss-20b",
    label: "gpt-oss 20B",
    notes: "Runs on 16 GB machines; mixture-of-experts (3.6B active).",
    license: "apache-2.0",
    moe: true,
    memoryGb: 16,
    gguf: { repo: "ggml-org/gpt-oss-20b-GGUF", quant: "MXFP4", file: "gpt-oss-20b-MXFP4.gguf", sizeGb: 12.1 },
    mlx: { repo: "mlx-community/gpt-oss-20b-MXFP4-Q8", sizeGb: 12.1 }
  },
  {
    id: "gemma-4-e4b",
    label: "Gemma 4 E4B",
    notes: "Smallest option; light drafting and triage, limited tool use.",
    license: "apache-2.0",
    moe: false,
    memoryGb: 11,
    gguf: { repo: "ggml-org/gemma-4-E4B-it-GGUF", quant: "Q8_0", file: "gemma-4-E4B-it-Q8_0.gguf", sizeGb: 8.0 },
    mlx: { repo: "lmstudio-community/gemma-4-E4B-it-MLX-4bit", sizeGb: 6.9 }
  }
];

export function catalogModel(id) {
  return LOCAL_MODEL_CATALOG.find((entry) => entry.id === id) || null;
}

// ── Hardware ────────────────────────────────────────────────────────────────

export function runtimeForPlatform({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin") return arch === "arm64" ? LOCAL_RUNTIMES.omlx : null;
  if (platform === "linux" || platform === "win32") return LOCAL_RUNTIMES["llama-cpp"];
  return null;
}

// Parses `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`.
export function parseNvidiaSmi(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, mib] = line.split(",").map((part) => part.trim());
      const memoryMiB = Number(mib);
      return Number.isFinite(memoryMiB) && name ? { name, memoryGb: round1(memoryMiB * 1048576 / GB) } : null;
    })
    .filter(Boolean);
}

function detectNvidiaGpus({ platform, env }) {
  const smi = resolveExecutable("nvidia-smi", { env, platform });
  if (!smi.available) return [];
  try {
    return parseNvidiaSmi(execFileSync(smi.path, ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], {
      encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true
    }));
  } catch {
    return [];
  }
}

function freeDiskGb(location) {
  try {
    const stats = statfsSync(location);
    return round1(Number(stats.bavail) * Number(stats.bsize) / GB);
  } catch {
    return null;
  }
}

export function detectLocalHardware({ platform = process.platform, arch = process.arch, env = process.env, totalMemoryBytes = os.totalmem(), gpus } = {}) {
  const unified = platform === "darwin" && arch === "arm64";
  const detectedGpus = gpus ?? (unified ? [] : detectNvidiaGpus({ platform, env }));
  const home = crewHome(env);
  return {
    platform,
    arch,
    unifiedMemory: unified,
    memoryGb: round1(totalMemoryBytes / GB),
    gpus: detectedGpus,
    vramGb: round1(detectedGpus.reduce((sum, gpu) => sum + gpu.memoryGb, 0)),
    freeDiskGb: freeDiskGb(existsSync(home) ? home : os.homedir())
  };
}

// ── Recommendation ──────────────────────────────────────────────────────────

// Fit levels, fastest first. `null` means the model should not be offered.
//   unified  — Apple Silicon unified memory holds the whole working set
//   gpu      — the working set fits in NVIDIA VRAM
//   gpu+ram  — mixture-of-experts with experts kept in system RAM (slower)
//   ram      — CPU only (slow; small or MoE models only)
export function modelFit(model, hardware) {
  const need = model.memoryGb;
  if (hardware.unifiedMemory) return need <= hardware.memoryGb * 0.7 ? "unified" : null;
  if (hardware.vramGb && need <= hardware.vramGb - 1) return "gpu";
  const ramBudget = hardware.memoryGb * 0.6;
  if (hardware.vramGb && model.moe && need <= ramBudget + hardware.vramGb) return "gpu+ram";
  if ((model.moe || need <= 12) && need <= ramBudget) return "ram";
  return null;
}

const FIT_RANK = { unified: 0, gpu: 0, "gpu+ram": 1, ram: 2 };
const FIT_LABEL = {
  unified: "fits in memory",
  gpu: "fits on the GPU",
  "gpu+ram": "runs with experts in system memory (slower)",
  ram: "runs on the CPU (slow)"
};

export function fitLabel(fit) {
  return fit ? FIT_LABEL[fit] : "too large for this computer";
}

export function recommendLocalModels(hardware = detectLocalHardware(), runtime = runtimeForPlatform(hardware)) {
  const format = runtime?.format || "gguf";
  const options = LOCAL_MODEL_CATALOG.map((model) => {
    const fit = runtime ? modelFit(model, hardware) : null;
    const download = model[format];
    const diskOk = hardware.freeDiskGb == null || download.sizeGb + 2 <= hardware.freeDiskGb;
    const needsGpu = !fit && runtime && !hardware.unifiedMemory && !model.moe && model.memoryGb <= hardware.memoryGb * 0.6;
    return { model, fit, fitLabel: needsGpu ? "needs a larger GPU (too slow on the CPU)" : fitLabel(fit), download, diskOk };
  });
  const usable = options.filter((option) => option.fit && option.diskOk);
  // Prefer the fastest fit class, then catalog order (strongest first).
  const best = [...usable].sort((a, b) => FIT_RANK[a.fit] - FIT_RANK[b.fit])[0] || null;
  return { runtime, hardware, options, recommended: best?.model.id || "" };
}

// Exact owner-facing setup steps for one catalog model on this platform.
export function setupSteps(runtime, model, { fit = "", platform = process.platform } = {}) {
  if (!runtime || !model) return [];
  if (runtime.id === "omlx") {
    const dir = `~/.crew/models/mlx/${model.mlx.repo.split("/")[1]}`;
    return [
      { title: "Install oMLX", command: "brew tap jundot/omlx https://github.com/jundot/omlx && brew install jundot/omlx/omlx" },
      { title: `Download ${model.label} (${model.mlx.sizeGb} GB)`, command: `hf download ${model.mlx.repo} --local-dir ${dir}`, note: "Needs the Hugging Face CLI (pip install -U huggingface_hub). You can also download the model from the oMLX dashboard." },
      { title: "Start the server", command: "omlx serve --model-dir ~/.crew/models/mlx --port 8000" }
    ];
  }
  const offload = fit === "gpu+ram" ? " --n-cpu-moe 99" : "";
  return [
    { title: "Install llama.cpp", command: platform === "win32" ? "winget install llama.cpp" : "brew install llama.cpp   # or unpack a release from github.com/ggml-org/llama.cpp/releases" },
    {
      title: `Download and start ${model.label} (${model.gguf.sizeGb} GB, downloaded on first start)`,
      command: `llama-server -hf ${model.gguf.repo}:${model.gguf.quant} --alias ${model.id} --jinja -c 32768 --host 127.0.0.1 --port 8080${offload}`
    }
  ];
}

export function detectLocalRuntime(runtime, { env = process.env, platform = process.platform } = {}) {
  if (!runtime) return { available: false, path: "" };
  const found = resolveExecutable(runtime.command, { env, platform });
  if (found.available) return { available: true, path: found.path };
  if (runtime.id === "omlx" && platform === "darwin" && existsSync("/Applications/oMLX.app")) {
    return { available: true, path: "/Applications/oMLX.app" };
  }
  return { available: false, path: "" };
}

// ── Checking a running server ───────────────────────────────────────────────

export function normalizeBaseUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  let url;
  try { url = new URL(text); } catch { throw new Error("Enter the server address, for example http://127.0.0.1:8080"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The server address must start with http:// or https://");
  if (url.username || url.password) throw new Error("Do not put credentials in the server address");
  return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}

const TOOL_PROBE = {
  name: "record_answer",
  description: "Record the final answer.",
  input_schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
};

async function postMessages(fetchImpl, baseUrl, body, timeoutMs) {
  const response = await fetchImpl(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "local" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status === 404) throw new Error("this server does not provide the Anthropic Messages API (/v1/messages); use llama.cpp's llama-server or oMLX");
  if (!response.ok) throw new Error(`/v1/messages responded ${response.status}`);
  return response.json();
}

// Lists models, sends one plain message and one tool-use request. The plain
// message must succeed; tool use is reported separately because agents need
// it (llama-server must run with --jinja).
export async function checkLocalServer({ baseUrl, model = "", fetchImpl = fetch, messageTimeoutMs = MESSAGE_TIMEOUT_MS } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const wanted = String(model || "").trim();
  // Keep the requested model on early failures so a re-check can be recorded against it.
  const result = { ok: false, baseUrl: base, models: [], model: wanted, messages: false, tools: false, detail: "" };
  try {
    const response = await fetchImpl(`${base}/v1/models`, { signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`/v1/models responded ${response.status}`);
    const parsed = await response.json();
    result.models = (Array.isArray(parsed?.data) ? parsed.data : [])
      .map((entry) => String(entry?.id || "").trim())
      .filter(Boolean);
  } catch (error) {
    result.detail = `Could not reach ${base}: ${error.message}. Start the local model server first.`;
    return result;
  }
  result.model = wanted && result.models.includes(wanted) ? wanted : wanted || result.models[0] || "";
  if (!result.model) {
    result.detail = "The server is running but lists no models. Load a model and check again.";
    return result;
  }
  try {
    const reply = await postMessages(fetchImpl, base, {
      model: result.model, max_tokens: 32, messages: [{ role: "user", content: "Reply with the word OK." }]
    }, messageTimeoutMs);
    result.messages = Array.isArray(reply?.content) && reply.content.some((block) => block?.type === "text" || block?.type === "thinking");
  } catch (error) {
    result.detail = `Messages test failed: ${error.message}`;
    return result;
  }
  if (!result.messages) {
    result.detail = "The server answered without any text content.";
    return result;
  }
  try {
    const reply = await postMessages(fetchImpl, base, {
      model: result.model,
      max_tokens: 256,
      tools: [TOOL_PROBE],
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: "Use the record_answer tool to record the answer: 4." }]
    }, messageTimeoutMs);
    result.tools = Array.isArray(reply?.content) && reply.content.some((block) => block?.type === "tool_use");
  } catch {
    result.tools = false;
  }
  result.ok = true;
  result.detail = result.tools
    ? `Connected to ${result.model}; messages and tool use work.`
    : `Connected to ${result.model}, but it did not call a tool. Agents need tool use: start llama-server with --jinja or pick a tool-capable model.`;
  return result;
}

// ── Runner registration ─────────────────────────────────────────────────────

export function localRunnerId(model) {
  const slug = String(model || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "model";
  return `local-${slug}`;
}

export function listLocalRunners() {
  return (loadGlobalRunnerConfig().runners || []).filter((runner) => runner.provider === "local");
}

// Adds or replaces the saved local runner for `model` at `baseUrl`.
export function saveLocalRunner({ baseUrl, model, runtime = "", label = "", check = null }) {
  const base = normalizeBaseUrl(baseUrl);
  const modelId = String(model || "").trim();
  if (!modelId) throw new Error("model is required");
  const catalog = catalogModel(modelId);
  const id = localRunnerId(modelId);
  const runner = {
    id,
    display_name: label || `Local · ${catalog?.label || modelId}`,
    engine: "claude-agent",
    kind: "agent-sdk",
    provider: "local",
    model: modelId,
    base_url: base,
    ...(runtime ? { local_runtime: runtime } : {}),
    ...(check ? { last_check: { status: check.ok ? "pass" : "fail", ok: Boolean(check.ok), tools: Boolean(check.tools), message: String(check.detail || "").slice(0, 300), at: new Date().toISOString() } } : {})
  };
  const config = loadGlobalRunnerConfig();
  const runners = (config.runners || []).filter((entry) => entry.id !== id);
  saveGlobalRunnerConfig({ ...config, runners: [...runners, runner] });
  return runner;
}

export function removeLocalRunner(id) {
  const config = loadGlobalRunnerConfig();
  const runners = config.runners || [];
  const target = runners.find((runner) => runner.id === id);
  if (!target || target.provider !== "local") return false;
  const remaining = runners.filter((runner) => runner.id !== id);
  if (remaining.length) {
    saveGlobalRunnerConfig({ ...config, runners: remaining });
  } else {
    // The validated writer requires at least one runner; an empty saved list is still valid.
    const file = globalRunnerConfigPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ version: config.version || 1, setup_note: config.setup_note, runners: [] }, null, 2)}\n`, "utf8");
  }
  return true;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
