import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { crewEnv, crewHome } from "./crew-dirs.js";
import { resolveExecutable, toolEnv } from "./platform.js";
import { getSecret, isUnlocked, secretValueForRunner } from "./secret-store.js";

// Live model discovery: refresh writes <crew home>/model-catalog.json and the
// runner catalog reads it synchronously, so new vendor models show up in the
// picker without a release. Sources are the vendors' own catalogs —
// the Claude Code runtime (`supportedModels`, respects the signed-in plan),
// the Codex CLI (`codex debug models`), and OpenAI-compatible `/v1/models`
// endpoints for GLM, Kimi, and saved local servers.

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 60000;
const FETCH_TIMEOUT_MS = 15000;

// Key-gated vendors: discovery runs only while the secret store is unlocked.
const OPENAI_COMPAT_PROVIDERS = {
  glm: { modelsUrl: "https://api.z.ai/api/paas/v4/models", secret: "GLM_API_KEY" },
  kimi: { modelsUrl: "https://api.moonshot.ai/v1/models", secret: "MOONSHOT_API_KEY" },
  // Server-side filter to tool-calling models: agent engines need tool use, and it keeps the picker sane.
  openrouter: { modelsUrl: "https://openrouter.ai/api/v1/models?supported_parameters=tools", secret: "OPENROUTER_API_KEY" }
};

// The catalog sits next to the global runner registry, so a CREW_RUNNERS_FILE
// override (used by tests and sandboxes) isolates both together.
export function modelCatalogPath() {
  const catalogFile = crewEnv("MODEL_CATALOG_FILE");
  if (catalogFile) return path.resolve(catalogFile);
  const runnersFile = crewEnv("RUNNERS_FILE");
  if (runnersFile) return path.join(path.dirname(path.resolve(runnersFile)), "model-catalog.json");
  return path.join(crewHome(), "model-catalog.json");
}

let cache = { file: "", stamp: "", catalog: null };

// { updated_at, providers: { anthropic: [{model,label,description,efforts}], openai: [...] } } or null.
// The cache key includes the size: two writes inside one mtime tick (Windows timestamp granularity)
// must not serve the earlier content.
export function loadModelCatalog() {
  const file = modelCatalogPath();
  try {
    const { mtimeNs, size } = statSync(file, { bigint: true });
    const stamp = `${mtimeNs}:${size}`;
    if (cache.file === file && cache.stamp === stamp) return cache.catalog;
    const catalog = normalizeCatalog(JSON.parse(readFileSync(file, "utf8")));
    cache = { file, stamp, catalog };
    return catalog;
  } catch {
    if (cache.file === file) cache = { file: "", stamp: "", catalog: null };
    return null;
  }
}

export function isCatalogFresh(catalog, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const at = Date.parse(catalog?.updated_at || "");
  return Number.isFinite(at) && Date.now() - at < maxAgeMs;
}

// Best effort per provider: a failed discovery keeps that provider's previous
// entries, a `null` result means "skipped" (locked store, no key, no servers)
// and stays silent, and nothing is written unless at least one provider succeeded.
export async function refreshModelCatalog({
  force = false,
  discoverClaude = discoverClaudeModels,
  discoverCodex = discoverCodexModels,
  discoverGlm = () => discoverKeyedModels("glm"),
  discoverKimi = () => discoverKeyedModels("kimi"),
  discoverOpenRouter = () => discoverKeyedModels("openrouter"),
  discoverLocal = discoverLocalModels
} = {}) {
  const existing = loadModelCatalog();
  if (!force && isCatalogFresh(existing)) return { catalog: existing, refreshed: false, errors: [] };

  const errors = [];
  const providers = { ...(existing?.providers || {}) };
  let refreshedAny = false;
  const jobs = [
    ["anthropic", "Claude", discoverClaude],
    ["openai", "Codex", discoverCodex],
    ["glm", "GLM", discoverGlm],
    ["kimi", "Kimi", discoverKimi],
    ["openrouter", "OpenRouter", discoverOpenRouter],
    ["local", "Local", discoverLocal]
  ];
  const results = await Promise.allSettled(jobs.map(([, , discover]) => discover()));
  for (const [index, [provider, label]] of jobs.entries()) {
    const result = results[index];
    if (result.status === "fulfilled" && result.value == null) continue; // skipped
    if (result.status === "fulfilled" && Array.isArray(result.value) && result.value.length) {
      providers[provider] = result.value;
      refreshedAny = true;
    } else {
      errors.push(`${label}: ${result.reason?.message || "no models discovered"}`);
    }
  }

  if (!refreshedAny) return { catalog: existing, refreshed: false, errors };
  const catalog = { version: 1, updated_at: new Date().toISOString(), providers };
  const file = modelCatalogPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  cache = { file: "", stamp: "", catalog: null };
  return { catalog, refreshed: true, errors };
}

export async function discoverClaudeModels({ loadSdk } = {}) {
  const sdk = await (loadSdk ? loadSdk() : import("@anthropic-ai/claude-agent-sdk"));
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), DISCOVERY_TIMEOUT_MS);
  // Streaming-input prompt that never yields: the session initializes (which
  // exposes the account's model list) without ever submitting a turn.
  const stream = sdk.query({
    prompt: (async function* () { await new Promise(() => {}); })(),
    options: { tools: [], permissionMode: "dontAsk", abortController }
  });
  const drain = (async () => { for await (const message of stream) void message; })().catch(() => {});
  try {
    return claudeCatalogEntries(await stream.supportedModels());
  } finally {
    clearTimeout(timer);
    abortController.abort();
    await drain;
  }
}

export async function discoverCodexModels({ run } = {}) {
  const env = toolEnv();
  const codex = resolveExecutable("codex", { env });
  if (!codex.available) throw new Error("codex CLI not found");
  const exec = run || promisify(execFile);
  const { stdout } = await exec(codex.path, ["debug", "models"], {
    env,
    timeout: DISCOVERY_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  });
  return codexCatalogEntries(JSON.parse(stdout));
}

// GLM/Kimi: OpenAI-compatible model listing with the stored key. Returns null
// (skip) while the store is locked or the key is missing.
async function discoverKeyedModels(provider) {
  const { modelsUrl, secret } = OPENAI_COMPAT_PROVIDERS[provider];
  if (!isUnlocked()) return null;
  const key = getSecret(secret);
  if (!key) return null;
  return openAiCompatEntries(await fetchJson(modelsUrl, key));
}

// Saved local servers (Settings → Runners → Local model server): list each
// server's models so they all become picker options. Returns null when no
// local runners exist.
export async function discoverLocalModels() {
  // Dynamic import avoids a static cycle (runner-config reads this module's catalog).
  const { loadGlobalRunnerConfig } = await import("./runner-config.js");
  const servers = new Map();
  for (const runner of loadGlobalRunnerConfig().runners || []) {
    if (runner.provider === "local" && runner.base_url) {
      servers.set(runner.base_url, secretValueForRunner(runner));
    }
  }
  if (!servers.size) return null;
  const entries = [];
  for (const [baseUrl, key] of servers) {
    const parsed = await fetchJson(`${baseUrl.replace(/\/+$/, "")}/v1/models`, key);
    entries.push(...openAiCompatEntries(parsed).map((entry) => ({ ...entry, base_url: baseUrl })));
  }
  return entries;
}

async function fetchJson(url, key) {
  const response = await fetch(url, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

export function openAiCompatEntries(parsed) {
  return (Array.isArray(parsed?.data) ? parsed.data : [])
    .filter((model) => typeof model?.id === "string" && model.id.trim())
    .map((model) => ({
      model: model.id.trim(),
      label: String(model.name || model.id).trim(),
      description: "",
      efforts: []
    }));
}

export function claudeCatalogEntries(models) {
  return (Array.isArray(models) ? models : [])
    .filter((model) => typeof model?.value === "string" && model.value.trim())
    .map((model) => ({
      model: model.value.trim(),
      label: String(model.displayName || model.value).trim(),
      description: String(model.description || "").trim(),
      efforts: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.map(String) : []
    }));
}

export function codexCatalogEntries(parsed) {
  return (Array.isArray(parsed?.models) ? parsed.models : [])
    .filter((model) => typeof model?.slug === "string" && model.slug.trim() && model.visibility === "list")
    .map((model) => ({
      model: model.slug.trim(),
      label: String(model.display_name || model.slug).trim(),
      description: String(model.description || "").trim(),
      efforts: (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
        .map((level) => String(level?.effort || ""))
        .filter(Boolean)
    }));
}

function normalizeCatalog(parsed) {
  if (!parsed || typeof parsed !== "object" || !parsed.providers || typeof parsed.providers !== "object") return null;
  const providers = {};
  for (const [provider, entries] of Object.entries(parsed.providers)) {
    if (!Array.isArray(entries)) continue;
    const list = entries
      .filter((entry) => typeof entry?.model === "string" && entry.model.trim())
      .map((entry) => ({
        model: entry.model.trim(),
        label: String(entry.label || entry.model).trim(),
        description: String(entry.description || "").trim(),
        efforts: Array.isArray(entry.efforts) ? entry.efforts.map(String).filter(Boolean) : [],
        ...(entry.base_url ? { base_url: String(entry.base_url).trim() } : {})
      }));
    if (list.length) providers[provider] = list;
  }
  return Object.keys(providers).length ? { updated_at: String(parsed.updated_at || ""), providers } : null;
}
