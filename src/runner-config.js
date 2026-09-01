import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CREW_DIR, crewEnv, crewHome } from "./crew-dirs.js";
import { resolveExecutable, toolEnv } from "./platform.js";
import { ENGINE_IDS, getEngine } from "./engines/index.js";
import { loadModelCatalog } from "./model-catalog.js";

const toolRequire = createRequire(import.meta.url);

const RUNNERS_REL = `${CREW_DIR}/memory/ai-runners.json`;
const RUNNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RUNNER_MODES = new Set(["propose", "execute"]);
// Vendor-documented Anthropic-protocol endpoints (Claude Code integration).
const GLM_ANTHROPIC_URL = "https://api.z.ai/api/anthropic";
const KIMI_ANTHROPIC_URL = "https://api.moonshot.ai/anthropic";
const OPENROUTER_ANTHROPIC_URL = "https://openrouter.ai/api";

export const BUILT_IN_RUNNER_PROFILES = [
  // Subscription CLIs — concrete profile ids used by generated projects.
  claudeCliProfile("claude-sonnet-high", "Claude Sonnet 4.6 · High", "sonnet", "high"),
  claudeCliProfile("claude-sonnet-max", "Claude Sonnet 4.6 · Max", "sonnet", "max"),
  codexCliProfile("codex-5.5-medium", "Codex CLI 5.5 · Medium", "gpt-5.5", "medium"),
  codexCliProfile("codex-5.5-high", "Codex CLI 5.5 · High", "gpt-5.5", "high"),
  // Claude profiles — Sonnet 4.6
  claudeAgentProfile("claude-agent-sonnet-high", "Claude Sonnet 4.6 · High", "sonnet", "high"),
  claudeAgentProfile("claude-agent-sonnet-medium", "Claude Sonnet 4.6 · Medium", "sonnet", "medium"),
  claudeAgentProfile("claude-agent-sonnet-low", "Claude Sonnet 4.6 · Low", "sonnet", "low"),
  claudeAgentProfile("claude-agent-sonnet-max", "Claude Sonnet 4.6 · Max", "sonnet", "max"),
  claudeAgentProfile("claude-agent-sonnet-very-high", "Claude Sonnet 4.6 · Very High", "sonnet", "very-high"),
  // Claude profiles — Opus 4.8
  claudeAgentProfile("claude-agent-opus-high", "Claude Opus 4.8 · High", "opus", "high"),
  claudeAgentProfile("claude-agent-opus-medium", "Claude Opus 4.8 · Medium", "opus", "medium"),
  claudeAgentProfile("claude-agent-opus-low", "Claude Opus 4.8 · Low", "opus", "low"),
  claudeAgentProfile("claude-agent-opus-max", "Claude Opus 4.8 · Max", "opus", "max"),
  // Codex profiles — 5.5 (default model)
  codexAgentProfile("codex-agent-high", "Codex 5.5 · High", "", "high"),
  codexAgentProfile("codex-agent-very-high", "Codex 5.5 · Very High", "", "xhigh"),
  codexAgentProfile("codex-agent-medium", "Codex 5.5 · Medium", "", "medium"),
  codexAgentProfile("codex-agent-low", "Codex 5.5 · Low", "", "low"),
  // Codex profiles — Code Spark
  codexAgentProfile("codex-agent-spark-high", "Codex Code Spark · High", "code-spark", "high"),
  codexAgentProfile("codex-agent-spark-very-high", "Codex Code Spark · Very High", "code-spark", "xhigh"),
  codexAgentProfile("codex-agent-spark-medium", "Codex Code Spark · Medium", "code-spark", "medium"),
  codexAgentProfile("codex-agent-spark-low", "Codex Code Spark · Low", "code-spark", "low"),
  // Anthropic-protocol providers — the Claude engine with a base-URL override and
  // the key from Settings → API Keys (both vendors document this integration).
  anthropicRouteProfile("glm-4.7", "GLM 4.7", "glm", GLM_ANTHROPIC_URL, "glm-4.7"),
  anthropicRouteProfile("kimi-k2.7", "Kimi K2.7 Code", "kimi", KIMI_ANTHROPIC_URL, "kimi-k2.7-code"),
  // OpenRouter: one key, many models. The auto-router alias is stable; concrete models are discovered.
  anthropicRouteProfile("openrouter-auto", "OpenRouter Auto Router", "openrouter", OPENROUTER_ANTHROPIC_URL, "openrouter/auto"),
];

// Profiles generated from the discovered model catalog (see model-catalog.js).
// Discovered profiles win over built-ins with the same id, so labels track the
// vendors' current names; built-ins stay resolvable as a fallback for role
// mappings that reference a model no longer in the vendor list.
export function discoveredRunnerProfiles(catalog = loadModelCatalog()) {
  const profiles = [];
  const providers = catalog?.providers || {};
  for (const entry of providers.anthropic || []) {
    const slug = modelIdSlug(entry.model, "claude");
    for (const effort of entry.efforts?.length ? entry.efforts : [""]) {
      profiles.push(claudeAgentProfile(
        ["claude-agent", slug, effort].filter(Boolean).join("-"),
        `Claude ${entry.label} · ${effortLabel(effort)}`,
        entry.model,
        effort
      ));
    }
  }
  for (const entry of providers.openai || []) {
    const slug = modelIdSlug(entry.model);
    for (const effort of entry.efforts?.length ? entry.efforts : [""]) {
      profiles.push(codexAgentProfile(
        ["codex-agent", slug, effort].filter(Boolean).join("-"),
        `Codex ${entry.label} · ${effortLabel(effort)}`,
        entry.model,
        effort
      ));
    }
  }
  // lean: every model the vendor lists becomes a profile — ceiling: vendors listing
  // many non-chat models (embeddings, vision) bloat the picker — upgrade: filter on
  // vendor metadata once it exists.
  for (const entry of providers.glm || []) {
    profiles.push(anthropicRouteProfile(
      `glm-${modelIdSlug(entry.model, "glm")}`,
      `GLM ${entry.label}`,
      "glm",
      GLM_ANTHROPIC_URL,
      entry.model
    ));
  }
  for (const entry of providers.kimi || []) {
    profiles.push(anthropicRouteProfile(
      `kimi-${modelIdSlug(entry.model, "kimi")}`,
      `Kimi ${entry.label}`,
      "kimi",
      KIMI_ANTHROPIC_URL,
      entry.model
    ));
  }
  for (const entry of providers.openrouter || []) {
    profiles.push(anthropicRouteProfile(
      `openrouter-${modelIdSlug(entry.model)}`,
      `OpenRouter ${entry.label}`,
      "openrouter",
      OPENROUTER_ANTHROPIC_URL,
      entry.model
    ));
  }
  const seenLocal = new Set();
  for (const entry of providers.local || []) {
    const id = `local-${modelIdSlug(entry.model)}`;
    if (!entry.base_url || seenLocal.has(id)) continue;
    seenLocal.add(id);
    profiles.push(anthropicRouteProfile(id, `Local ${entry.label}`, "local", entry.base_url, entry.model));
  }
  return profiles;
}

// All resolvable agent profiles: discovered first, built-ins fill the gaps.
export function agentRunnerProfiles() {
  const discovered = discoveredRunnerProfiles();
  const seen = new Set(discovered.map((profile) => profile.id));
  return [...discovered, ...BUILT_IN_RUNNER_PROFILES.filter((profile) => !seen.has(profile.id))];
}

// Picker menu: once a provider has discovered models, its stale built-ins are
// hidden from the menu (they may name models the account can no longer run).
// User-created agent-sdk runners (e.g. local model servers) are appended so
// they are assignable from the same picker.
function menuRunnerProfiles() {
  const discovered = discoveredRunnerProfiles();
  const discoveredProviders = new Set(discovered.map((profile) => profile.provider));
  const menu = [
    ...discovered,
    ...BUILT_IN_RUNNER_PROFILES.filter((profile) => !discoveredProviders.has(profile.provider))
  ];
  const known = new Set([...discovered, ...BUILT_IN_RUNNER_PROFILES].map((profile) => profile.id));
  try {
    for (const runner of loadGlobalRunnerConfig().runners || []) {
      if (runner.kind !== "agent-sdk" || known.has(runner.id)) continue;
      menu.push({ id: runner.id, provider: runner.provider, displayName: runner.display_name || runner.id, runner });
    }
  } catch { /* menu still renders from built-ins */ }
  return menu;
}

export function detectRunnerTools() {
  return {
    codex: { ...detectCommand("codex"), sdk: sdkAvailable("@openai/codex-sdk") },
    claude: { ...detectCommand("claude"), sdk: sdkAvailable("@anthropic-ai/claude-agent-sdk") }
  };
}

// Returns "" only when neither vendor CLI is installed — the single legitimate "no runner" case.
export const DEFAULT_CLAUDE_PROFILE_ID = "claude-agent-sonnet-high";
export const DEFAULT_CODEX_PROFILE_ID = "codex-agent-high";

export function defaultRunnerProfileId(tools = detectRunnerTools()) {
  if (tools.claude?.available) return DEFAULT_CLAUDE_PROFILE_ID;
  if (tools.codex?.available) return DEFAULT_CODEX_PROFILE_ID;
  return "";
}

const PROVIDER_LABELS = { anthropic: "Claude", openai: "Codex", glm: "GLM", kimi: "Kimi", openrouter: "OpenRouter", local: "Local" };
const MODEL_LABELS = { sonnet: "Sonnet 4.6", opus: "Opus 4.8", "gpt-5.5": "GPT-5.5", "code-spark": "Code Spark", "openrouter/auto": "Auto Router" };
const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", "very-high": "Very High", xhigh: "Very High", max: "Max" };

// Thinking is always on: effort is the reasoning level, and there is no "off".
export function runnerCatalog() {
  const modelLabels = catalogModelLabels();
  const byProvider = new Map();
  for (const profile of menuRunnerProfiles()) {
    if (profile.runner.kind !== "agent-sdk") continue;
    const provider = profile.runner.provider;
    const model = profile.runner.model || "gpt-5.5";
    if (!byProvider.has(provider)) {
      byProvider.set(provider, { provider, label: PROVIDER_LABELS[provider] || provider, models: new Map() });
    }
    const group = byProvider.get(provider);
    if (!group.models.has(model)) {
      group.models.set(model, { model, label: modelLabels[model] || model, options: [] });
    }
    const effort = profile.runner.reasoning_effort || "";
    group.models.get(model).options.push({
      effort,
      label: effortLabel(effort),
      profileId: profile.id
    });
  }
  return [...byProvider.values()].map((group) => ({
    provider: group.provider,
    label: group.label,
    models: [...group.models.values()]
  }));
}

export function runnerProfileLabel(runnerOrId) {
  const runner = typeof runnerOrId === "string" ? resolveRunnerProfile(runnerOrId) : runnerOrId;
  if (!runner) return String(runnerOrId || "runner").trim() || "runner";
  if (isBuiltInAgentRunner(runner)) {
    return [
      runnerProfileFamilyLabel(runner),
      runnerEffortLabel(runner)
    ].filter(Boolean).join(" · ");
  }
  return String(runner.display_name || runner.id || "runner").trim();
}

export function runnerProfileSlug(runnerOrId) {
  const runner = typeof runnerOrId === "string" ? resolveRunnerProfile(runnerOrId) : runnerOrId;
  if (!runner) return String(runnerOrId || "runner").trim() || "runner";
  if (isBuiltInAgentRunner(runner)) {
    return [
      runnerProviderSlug(runner),
      runnerModelSlug(runner),
      runnerEffortSlug(runner)
    ].filter(Boolean).join("-");
  }
  return String(runner.id || runner.display_name || "runner").trim();
}

// Global saved profile wins; falls back to built-in so defaults work on a fresh machine without saving config first.
export function resolveRunnerProfile(runnerId) {
  const id = String(runnerId || "").trim();
  if (!id) return null;
  try {
    const found = (loadGlobalRunnerConfig().runners || []).find((runner) => runner.id === id);
    if (found) return found;
  } catch { /* fall through to built-ins */ }
  const profile = agentRunnerProfiles().find((item) => item.id === id);
  return profile ? cloneRunner(profile.runner) : null;
}

export function roleRunnerId(roleId, defaultRoleRunners = {}) {
  const role = String(roleId || "").trim();
  return String(defaultRoleRunners?.[role] || "").trim();
}

export function loadRunnerConfig(targetRoot) {
  const project = loadProjectRunnerConfig(targetRoot);
  const global = loadGlobalRunnerConfig();
  const globalRunners = Array.isArray(global.runners) ? global.runners : [];
  const defaultRoleRunners = project.default_role_runners || {};
  const referencedRunnerIds = Object.values(defaultRoleRunners).map((runner) => String(runner || "").trim());

  return {
    ...project,
    setup_note: global.setup_note || project.setup_note || "Configure runner profiles from Cockpit Settings → Runners.",
    runner_source: "global",
    global_file: globalRunnerConfigPath(),
    runners: withReferencedBuiltIns(globalRunners, referencedRunnerIds),
    default_role_runners: defaultRoleRunners
  };
}

export function loadProjectRunnerConfig(targetRoot) {
  const file = path.join(targetRoot || "", RUNNERS_REL);
  if (!existsSync(file)) {
    return {
      version: 1,
      setup_note: "Project role runner mappings. Concrete runner profiles are global in Cockpit.",
      default_role_runners: {},
      runners: []
    };
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

export function globalRunnerConfigPath() {
  const override = crewEnv("RUNNERS_FILE");
  return override ? path.resolve(override) : path.join(crewHome(), "ai-runners.json");
}

export function loadGlobalRunnerConfig() {
  const file = globalRunnerConfigPath();
  if (!existsSync(file)) {
    return {
      version: 1,
      setup_note: "Global runner profiles for all projects on this machine.",
      runners: []
    };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return {
    ...parsed,
    version: parsed.version || 1,
    setup_note: parsed.setup_note || "Global runner profiles for all projects on this machine.",
    runners: Array.isArray(parsed.runners) ? parsed.runners.map(normalizeRunner) : []
  };
}

export function saveGlobalRunnerConfig(config) {
  const validated = validateRunnerConfig({
    ...config,
    default_role_runners: {}
  });
  const file = globalRunnerConfigPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const global = {
    ...validated,
    default_role_runners: undefined
  };
  delete global.default_role_runners;
  writeFileSync(file, `${JSON.stringify(global, null, 2)}\n`, "utf8");
  return global;
}

export function saveRunnerConfig(targetRoot, config) {
  const validated = validateRunnerConfig(config);
  const file = path.join(targetRoot, RUNNERS_REL);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  return validated;
}

export function saveProjectRunnerConfig(targetRoot, config = {}) {
  const file = path.join(targetRoot, RUNNERS_REL);
  const projectConfig = {
    ...config,
    version: config.version || 1,
    setup_note: config.setup_note || "Project role runner mappings. Concrete runner profiles are global in Cockpit.",
    default_role_runners: config.default_role_runners && typeof config.default_role_runners === "object"
      ? { ...config.default_role_runners }
      : {},
    runners: Array.isArray(config.runners) ? config.runners.map(normalizeRunner) : []
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(projectConfig, null, 2)}\n`, "utf8");
  return projectConfig;
}

export function addGlobalRunnerProfile(profileId) {
  const profile = agentRunnerProfiles().find((item) => item.id === profileId);
  if (!profile) throw new Error(`unknown runner profile: ${profileId}`);
  const config = loadGlobalRunnerConfig();
  const runners = Array.isArray(config.runners) ? config.runners : [];
  if (runners.some((runner) => runner.id === profile.id)) {
    throw new Error(`runner id already exists: ${profile.id}`);
  }
  return saveGlobalRunnerConfig({
    ...config,
    runners: [...runners, cloneRunner(profile.runner)]
  });
}

// Local Anthropic-compatible server (Ollama, LM Studio, llama.cpp) as an agent
// runner — same Claude engine, routed to base_url. Model is required because
// local servers have no default the engine could fall back to.
export function addLocalRunner({ id, display_name, base_url, model }) {
  if (!String(base_url || "").trim()) throw new Error("base URL is required");
  if (!String(model || "").trim()) throw new Error("model is required");
  const config = loadGlobalRunnerConfig();
  const runners = Array.isArray(config.runners) ? config.runners : [];
  if (runners.some((runner) => runner.id === id)) {
    throw new Error(`runner id already exists: ${id}`);
  }
  const runner = normalizeRunner({
    id,
    display_name: display_name || id,
    engine: "claude-agent",
    kind: "agent-sdk",
    provider: "local",
    model,
    base_url
  });
  return saveGlobalRunnerConfig({ ...config, runners: [...runners, runner] });
}

export function assignRoleRunner(targetRoot, roleId, runnerId, knownRoles = []) {
  const role = String(roleId || "").trim();
  const runner = String(runnerId || "").trim();
  if (!role) throw new Error("role is required");
  if (knownRoles.length && !knownRoles.includes(role)) {
    throw new Error(`unknown role: ${role}`);
  }

  const config = loadRunnerConfig(targetRoot);
  const runnerIds = new Set((config.runners || []).map((item) => item.id));
  if (!runnerIds.has(runner)) {
    // The picker can hand us a built-in or discovered profile not yet saved globally — provision it on demand.
    if (agentRunnerProfiles().some((profile) => profile.id === runner)) {
      try { addGlobalRunnerProfile(runner); } catch { /* already present, or a harmless race */ }
    } else {
      throw new Error(`unknown runner: ${runner}`);
    }
  }

  const projectConfig = loadProjectRunnerConfig(targetRoot);
  return saveProjectRunnerConfig(targetRoot, {
    ...projectConfig,
    default_role_runners: {
      ...(projectConfig.default_role_runners || {}),
      [role]: runner
    }
  });
}

export async function checkRunner(targetRoot, runnerId) {
  const id = String(runnerId || "").trim();
  const config = loadRunnerConfig(targetRoot);
  const runner = (config.runners || []).find((item) => item.id === id);
  if (!runner) throw new Error(`unknown runner: ${id}`);
  // Each engine owns its healthcheck; no generated auth-check.sh (init no longer ships one).
  return recordRunnerCheck(id, await getEngine(runner.engine || "cli").healthcheck(runner, { targetRoot }));
}

export async function checkGlobalRunner(runnerId) {
  const id = String(runnerId || "").trim();
  const config = loadGlobalRunnerConfig();
  const runner = (config.runners || []).find((item) => item.id === id) || resolveRunnerProfile(id);
  if (!runner) throw new Error(`unknown runner: ${id}`);
  return recordRunnerCheck(id, await getEngine(runner.engine || "cli").healthcheck(runner));
}

// Best effort — a failed write never fails the check result.
function recordRunnerCheck(runnerId, result) {
  try {
    const config = loadGlobalRunnerConfig();
    const runner = (config.runners || []).find((item) => item.id === runnerId);
    if (runner) {
      runner.last_check = {
        status: result.status || (result.ok ? "pass" : "fail"),
        ok: Boolean(result.ok),
        message: String(result.message || "").slice(0, 300),
        at: new Date().toISOString()
      };
      saveGlobalRunnerConfig(config);
    }
  } catch { /* display-only state */ }
  return result;
}

export function validateRunnerConfig(config) {
  if (!config || typeof config !== "object") throw new Error("runner config must be an object");
  const runners = Array.isArray(config.runners) ? config.runners.map(normalizeRunner) : [];
  if (runners.length === 0) throw new Error("at least one runner is required");
  const seen = new Set();
  for (const runner of runners) {
    if (seen.has(runner.id)) throw new Error(`duplicate runner id: ${runner.id}`);
    seen.add(runner.id);
  }

  const defaults = config.default_role_runners && typeof config.default_role_runners === "object"
    ? { ...config.default_role_runners }
    : {};
  for (const [role, runnerId] of Object.entries(defaults)) {
    if (!seen.has(runnerId)) {
      throw new Error(`role ${role} maps to unknown runner: ${runnerId}`);
    }
  }

  return {
    ...config,
    version: config.version || 1,
    default_role_runners: defaults,
    runners
  };
}

export function runnerStatus(runner, tools = detectRunnerTools()) {
  if (!runner) return { tone: "danger", label: "missing" };
  if ((runner.engine || "cli") !== "cli") {
    // Native profiles own their runtime; auth is verified by the profile check.
    return { tone: "success", label: "ready" };
  }
  if (isPlaceholder(runner.command)) return { tone: "warning", label: "placeholder" };
  if (runner.provider === "openai" && !tools.codex.available) return { tone: "warning", label: "codex missing" };
  if (runner.provider === "anthropic" && !tools.claude.available) return { tone: "warning", label: "claude missing" };
  return { tone: "success", label: "configured" };
}

function isBuiltInAgentRunner(runner) {
  return runner?.kind === "agent-sdk" || runner?.engine === "claude-agent" || runner?.engine === "codex-agent";
}

function runnerProviderLabel(runner) {
  return PROVIDER_LABELS[runner.provider] || String(runner.provider || "").trim();
}

function runnerProviderSlug(runner) {
  const provider = String(runner.provider || "").trim();
  if (provider === "anthropic") return "claude";
  if (provider === "openai") return "codex";
  // Routed providers (glm/kimi/local) run on the claude-agent engine but keep their own slug.
  if (provider && provider !== "custom") return provider;
  if (runner.engine === "claude-agent") return "claude";
  if (runner.engine === "codex-agent") return "codex";
  return provider;
}

function runnerProfileFamilyLabel(runner) {
  return [runnerProviderLabel(runner), runnerModelLabel(runner)].filter(Boolean).join(" ");
}

function runnerModelLabel(runner) {
  if (runner.provider === "openai" || runner.engine === "codex-agent") {
    if (!runner.model || runner.model === "gpt-5.5") return "5.5";
  }
  return catalogModelLabels()[runner.model] || String(runner.model || "").trim();
}

function runnerModelSlug(runner) {
  if (runner.provider === "anthropic" || runner.engine === "claude-agent") {
    if (runner.model === "opus") return "opus-4.8";
    if (!runner.model || runner.model === "sonnet") return "sonnet-4.6";
    return modelIdSlug(runner.model, "claude");
  }
  if (runner.provider === "openai" || runner.engine === "codex-agent") {
    if (runner.model === "code-spark") return "code-spark";
    if (!runner.model || runner.model === "gpt-5.5") return "5.5";
    return modelIdSlug(runner.model);
  }
  // Routed providers (glm/kimi/local) — model names can carry tags like "qwen3-coder:30b".
  return modelIdSlug(runner.model);
}

function runnerEffortLabel(runner) {
  return EFFORT_LABELS[runner.reasoning_effort] || String(runner.reasoning_effort || "").trim();
}

function effortLabel(effort) {
  return EFFORT_LABELS[effort] || effort || "Default";
}

// Discovered display names win over the static fallbacks, so labels track
// whatever the vendors currently call each model.
function catalogModelLabels() {
  const labels = { ...MODEL_LABELS };
  const providers = loadModelCatalog()?.providers || {};
  for (const entries of Object.values(providers)) {
    for (const entry of entries) {
      if (entry.model && entry.label) labels[entry.model] = entry.label;
    }
  }
  return labels;
}

// Model ids can carry characters runner ids and branch labels can't (e.g. "claude-fable-5[1m]").
function modelIdSlug(model, stripPrefix = "") {
  let slug = String(model || "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (stripPrefix && slug.startsWith(`${stripPrefix}-`)) slug = slug.slice(stripPrefix.length + 1);
  return slug;
}

function runnerEffortSlug(runner) {
  const effort = String(runner.reasoning_effort || "").trim();
  return effort === "xhigh" ? "very-high" : effort;
}

export function isPlaceholder(command) {
  return typeof command === "string" && command.startsWith("replace-");
}

function claudeCliProfile(id, displayName, model, effort) {
  return {
    id,
    provider: "anthropic",
    displayName,
    runner: {
      id,
      display_name: displayName,
      engine: "cli",
      mode: "propose",
      kind: "cli",
      provider: "anthropic",
      model,
      reasoning_effort: effort,
      source_profile: id,
      command: "claude",
      args: ["--print", "--model", model, "--effort", effort, "{prompt}"],
      uses_doppler: false,
      healthcheck: {
        command: "claude",
        args: ["--print", "--model", model, "--effort", effort, "respond with the word OK and nothing else"],
        expect_stdout: "OK"
      }
    }
  };
}

function codexCliProfile(id, displayName, model, effort) {
  return {
    id,
    provider: "openai",
    displayName,
    runner: {
      id,
      display_name: displayName,
      engine: "cli",
      mode: "propose",
      kind: "cli",
      provider: "openai",
      model,
      reasoning_effort: effort,
      source_profile: id,
      command: "codex",
      args: ["exec", "--sandbox", "read-only", "--ask-for-approval", "never", "-c", `model_reasoning_effort="${effort}"`, "{prompt}"],
      uses_doppler: false,
      healthcheck: {
        command: "codex",
        args: ["exec", "--sandbox", "read-only", "--ask-for-approval", "never", "--skip-git-repo-check", "--ephemeral", "-c", `model_reasoning_effort="${effort}"`, "respond with the word OK and nothing else"],
        expect_stdout: "OK"
      }
    }
  };
}

function claudeAgentProfile(id, displayName, model, effort) {
  return {
    id,
    provider: "anthropic",
    displayName,
    runner: {
      id,
      display_name: displayName,
      engine: "claude-agent",
      mode: "propose",
      kind: "agent-sdk",
      provider: "anthropic",
      model,
      ...(effort ? { reasoning_effort: effort } : {}),
      source_profile: id
    }
  };
}

function anthropicRouteProfile(id, displayName, provider, baseUrl, model) {
  return {
    id,
    provider,
    displayName,
    runner: {
      id,
      display_name: displayName,
      engine: "claude-agent",
      mode: "propose",
      kind: "agent-sdk",
      provider,
      model,
      base_url: baseUrl,
      source_profile: id
    }
  };
}

function codexAgentProfile(id, displayName, model, effort) {
  return {
    id,
    provider: "openai",
    displayName,
    runner: {
      id,
      display_name: displayName,
      engine: "codex-agent",
      mode: "propose",
      kind: "agent-sdk",
      provider: "openai",
      ...(model ? { model } : {}),
      ...(effort ? { reasoning_effort: effort } : {}),
      source_profile: id
    }
  };
}

function normalizeRunner(value) {
  const runner = { ...value };
  runner.id = String(runner.id || "").trim();
  if (!RUNNER_ID_PATTERN.test(runner.id)) {
    throw new Error(`invalid runner id: ${runner.id || "<empty>"}`);
  }
  runner.engine = String(runner.engine || "cli").trim();
  if (!ENGINE_IDS.includes(runner.engine)) {
    throw new Error(`runner ${runner.id} has unknown engine: ${runner.engine}`);
  }
  runner.mode = RUNNER_MODES.has(runner.mode) ? runner.mode : "propose";
  // Auth preference: "subscription" forces vendor CLI/OAuth login, "api-key" forces a stored key;
  // absent means auto (today's behavior: ambient key if present, else subscription).
  const auth = String(runner.auth || "").trim().toLowerCase();
  if (auth === "subscription" || auth === "api-key") runner.auth = auth;
  else delete runner.auth;
  runner.kind = String(runner.kind || (runner.engine === "cli" ? "cli" : "agent-sdk")).trim();
  runner.provider = String(runner.provider || "custom").trim();
  runner.model = String(runner.model || "").trim();
  runner.base_url = String(runner.base_url || "").trim();
  if (runner.base_url && !/^https?:\/\//.test(runner.base_url)) {
    throw new Error(`runner ${runner.id} base_url must start with http(s)://`);
  }
  if (!runner.base_url) delete runner.base_url;
  runner.command = String(runner.command || "").trim();
  if (!runner.command && runner.engine === "cli") {
    throw new Error(`runner ${runner.id} is missing command`);
  }
  if (!runner.command) delete runner.command;
  runner.args = Array.isArray(runner.args) ? runner.args.map(String) : [];
  // Execute-mode shell access is an explicit opt-in (see engines/claude-agent.js).
  if (runner.allow_shell === true) runner.allow_shell = true;
  else delete runner.allow_shell;

  for (const key of ["display_name", "reasoning_effort", "source_profile", "secret_ref"]) {
    if (runner[key] !== undefined) runner[key] = String(runner[key] || "").trim();
    if (runner[key] === "") delete runner[key];
  }

  if (runner.healthcheck && typeof runner.healthcheck === "object") {
    const command = String(runner.healthcheck.command || "").trim();
    const args = Array.isArray(runner.healthcheck.args) ? runner.healthcheck.args.map(String) : [];
    const expect = String(runner.healthcheck.expect_stdout || "").trim();
    runner.healthcheck = command
      ? {
          command,
          args,
          ...(expect ? { expect_stdout: expect } : {})
        }
      : undefined;
  }
  if (!runner.healthcheck) delete runner.healthcheck;
  return runner;
}

function withReferencedBuiltIns(runners, runnerIds) {
  const out = [...runners];
  const seen = new Set(out.map((runner) => runner.id));
  const profiles = agentRunnerProfiles();
  for (const id of runnerIds || []) {
    if (seen.has(id)) continue;
    const profile = profiles.find((item) => item.id === id);
    if (!profile) continue;
    out.push(cloneRunner(profile.runner));
    seen.add(id);
  }
  return out;
}


function cloneRunner(runner) {
  return structuredClone(runner);
}

function detectCommand(command) {
  return resolveExecutable(command, { env: toolEnv() });
}

function sdkAvailable(packageName) {
  try {
    toolRequire.resolve(packageName);
    return true;
  } catch {
    // ESM-only packages restrict require() via exports; look for the package directory the way
    // Node would, walking up from this module so hoisted installs are found too.
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (true) {
      if (existsSync(path.join(dir, "node_modules", packageName, "package.json"))) return true;
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
}
