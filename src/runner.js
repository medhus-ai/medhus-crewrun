import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { agentFile } from "./agent-paths.js";
import { crewDir } from "./crew-dirs.js";
import { createCrewOnlyBridge } from "./mcp.js";
import { parseFrontmatter } from "./frontmatter.js";
import { loadRoleSpec } from "./role-spec.js";
import { roleContractInstructions } from "./role-contract.js";
import { createContainerEngine } from "./engines/container.js";
import { getEngine } from "./engines/index.js";
import { readExecutionPolicy } from "./execution-policy.js";
import { listPreferences } from "./preference-memory.js";
import { roleCapabilityInstructions, roleCapabilityProfile } from "./role-capabilities.js";
import { defaultRunnerProfileId, resolveRunnerProfile, roleRunnerId } from "./runner-config.js";
import { listSkills, skillIndexPrompt } from "./skills.js";
import { createExecuteWorktree } from "./workspace.js";

const LEARNING_POLICY = "Save only durable user/application facts and preferences or useful repeatable Skills. Do not save generic advice the model can infer. Prefer updating an existing entry. Agent-inferred changes require operator review; a trusted operator may directly save an explicit user instruction. Reflections are optional temporary proposals to improve context or a Skill, never a routine after-action journal. Existing journals are archived and are not injected into prompts.";

// Hosts declare shared memory files; none are installed by default.
const DEFAULT_UNIVERSAL_MEMORY = [];
const DEFAULT_MEMORY_TITLES = {};
const DEFAULT_NOISE = /^\s*(?:\[(cmd|edit|mcp|search|tool|worktree|subagent)\b|mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_]+$)/i;
const EXECUTE_MODE_INSTRUCTION = "You may read and edit files inside your working directory, which is an isolated git worktree on a dedicated branch. Run commands only when your engine exposes a shell tool. Make the changes the user asks for; the user reviews the branch afterwards.";
const PROPOSE_MODE_INSTRUCTION = "You have read-only tool access to the project. Propose changes as diffs or precise instructions in your reply; do not attempt to write files.";
const TITLE_TIMEOUT_MS = 45000;
const ROLE_SLUG = /^[a-z][a-z0-9-]{0,79}$/;

// Returns "" only when nothing is configured and no vendor CLI is set up. Resolution order:
// the role spec (<crew>/roles/<role>.json merged over _defaults.json; legacy .md frontmatter
// honored when no .json exists) → the legacy memory/ai-runners.json mapping → the detected
// provider default.
export function runnerIdForRole(role, targetRoot) {
  const declared = targetRoot ? String(loadRoleSpec(targetRoot, role)?.runner || "").trim() : "";
  if (declared) return declared;
  const configured = targetRoot ? resolveConfiguredRunnerId(role, targetRoot) : "";
  if (configured) return configured;
  return defaultRunnerProfileId() || "";
}

function resolveConfiguredRunnerId(role, targetRoot) {
  try {
    const text = readFileSync(path.join(targetRoot, `${crewDir()}/memory/ai-runners.json`), "utf8");
    const config = JSON.parse(text);
    return roleRunnerId(role, config.default_agent_runners || config.default_role_runners || {});
  } catch {
    return "";
  }
}

export function buildConversationPrompt(messages) {
  const lines = ["## Conversation so far"];
  appendTranscript(lines, messages);
  lines.push("");
  lines.push("## Your turn");
  lines.push("Respond to the latest message from the user. Stay in scope of your role.");
  return lines.join("\n");
}

// On a resumed vendor session the engine already holds the conversation, so only the newest user message is sent.
export function buildResumePrompt(messages, context = "") {
  const lastUser = [...(messages || [])].reverse().find((msg) => msg.author === "user");
  const prompt = lastUser?.content || buildConversationPrompt(messages);
  return context ? `${context}\n\n## Latest user message\n${prompt}` : prompt;
}

export function isLikelyStaleSessionError(value) {
  const text = String(value || "");
  return /(?:session|thread|conversation).{0,40}(?:not found|expired|invalid|gone|does not exist)|resume.{0,40}(?:failed|not found|expired|invalid)/i.test(text);
}

// Resolves the role's declared `memory_pointers` into prompt sections: a role carries only the
// memory it lists, plus the universal floor. Glob/tool-fetched entries (`<task-id>`, `*`,
// "(when active)") and missing files are skipped silently; paths outside the target repository
// are refused (lexically and via realpath, so a symlink cannot escape it). Role files are
// reviewed repo content, so any file inside the repo is fair injection material.
export function loadRoleMemory(targetRoot, roleText, { universal = DEFAULT_UNIVERSAL_MEMORY, extra = [], titles = {}, pointers = [] } = {}) {
  const root = path.resolve(targetRoot);
  const paths = [];
  const add = (candidate) => {
    const safePath = resolveRoleMemoryPath(root, candidate);
    if (safePath && !paths.includes(safePath)) paths.push(safePath);
  };
  for (const name of universal) add(path.resolve(root, crewDir(), "memory", name));
  for (const entry of pointers) {
    if (typeof entry === "string" && entry.endsWith(".md") && !/[<>*]/.test(entry)) add(path.resolve(root, entry));
  }
  for (const entry of parseMemoryPointers(roleText)) add(path.resolve(root, entry));
  for (const name of extra) add(path.resolve(root, crewDir(), "memory", name));

  const sections = [];
  for (const filePath of paths) {
    const body = readMaybe(filePath);
    if (body && body.trim()) sections.push({ title: memoryTitle(filePath, titles), body });
  }
  return sections;
}

// Host hooks give the runtime its product identity: prompt boilerplate, role display names,
// universal memory, worktree branch naming, the MCP tool bridge, and the container worker entry.
export function createRoleRunner({
  tools = createCrewOnlyBridge(),
  displayRoleName = (role) => role,
  universalMemory = DEFAULT_UNIVERSAL_MEMORY,
  memoryTitles = {},
  extraMemory = () => [],
  capabilityProfile = (role, options) => roleCapabilityProfile(role, options),
  capabilityInstructions = (profile) => roleCapabilityInstructions(profile),
  protocol = () => [],
  turnInstructions = () => ["Respond to the latest message from the user. Stay in scope of the role file."],
  proposeModeInstruction = () => PROPOSE_MODE_INSTRUCTION,
  createWorktree = (targetRoot, slug) => createExecuteWorktree(targetRoot, slug),
  container = {},
  noise = DEFAULT_NOISE
} = {}) {
  const memoryOptions = { universal: universalMemory, titles: memoryTitles };

  function buildPromptBody({ role, rolePrompt, memory = [], messages, context, capabilities, skills = [], preferences = [] }) {
    const lines = [
      rolePrompt ? `You are the ${displayRoleName(role)}. Follow the role file below exactly.` : `You are the ${displayRoleName(role)}. Follow your memory sections below exactly.`,
      "",
      ...contextSections({ rolePrompt, memory }),
      ...contextBlock(preferencePrompt(preferences)),
      ...contextBlock(skillIndexPrompt(skills)),
      ...contextBlock(LEARNING_POLICY),
      ...contextBlock(capabilityInstructions(capabilities || capabilityProfile(role, {}))),
      ...contextBlock(context),
      "## Conversation so far"
    ];
    appendTranscript(lines, messages);
    lines.push("");
    lines.push(...protocol(role));
    lines.push("## Your turn");
    lines.push(...turnInstructions(role));
    return lines.join("\n");
  }

  function buildSystemPrompt({ role, rolePrompt, memory = [], mode, context, capabilities, skills = [], preferences = [] }) {
    const lines = [
      rolePrompt ? `You are the ${displayRoleName(role)} for this project. Follow the role file below exactly.` : `You are the ${displayRoleName(role)} for this project. Follow your memory sections below exactly.`,
      "",
      ...contextSections({ rolePrompt, memory }),
      ...contextBlock(preferencePrompt(preferences)),
      ...contextBlock(skillIndexPrompt(skills)),
      ...contextBlock(LEARNING_POLICY),
      ...contextBlock(capabilityInstructions(capabilities || capabilityProfile(role, {}))),
      ...contextBlock(context),
      ...protocol(role),
      "## Operating mode",
      mode === "execute" ? EXECUTE_MODE_INSTRUCTION : proposeModeInstruction(role)
    ];
    return lines.join("\n");
  }

  // Returns the engine handle ({ kill }) plus resolution metadata for the run record and budget ledger.
  function startRoleTurn({ targetRoot, role, messages, resumeSessionId, worktree, readOnlyWorktree, context, toolContext, modeOverride, onLine, onPartialText, onStatus, onClose, onError }) {
    // The role names a file under the crew directory; only a slug may reach the filesystem.
    if (!ROLE_SLUG.test(String(role || ""))) throw new Error(`invalid role name: ${role || "<empty>"}`);
    const runnerId = runnerIdForRole(role, targetRoot);
    const profile = resolveRunnerProfile(runnerId);
    if (runnerId && !profile) {
      throw new Error(`runner ${runnerId} is not configured for role ${role}`);
    }
    const engineId = profile?.engine || "cli";
    const baseEngine = getEngine(engineId);
    const requestedMode = modeOverride || profile?.mode;
    if (requestedMode === "execute" && !baseEngine.capabilities.agentic) {
      throw new Error(`runner ${runnerId || role} cannot execute edits; choose a runner profile that supports execute mode`);
    }
    const mode = requestedMode === "execute" && baseEngine.capabilities.agentic ? "execute" : "propose";
    const executionPolicy = readExecutionPolicy(targetRoot);
    const engine = mode === "execute" && executionPolicy.runtime === "container"
      ? createContainerEngine(baseEngine, executionPolicy, container)
      : baseEngine;
    const resuming = Boolean(resumeSessionId) && engineId !== "cli";

    // A .json spec makes the role's .md optional: the prompt is whatever the spec's
    // memory_pointers name (which may include the .md itself, or any repo file). Roles
    // without a spec file keep the legacy behavior: the .md is the Role section.
    const spec = loadRoleSpec(targetRoot, role);
    const specDriven = Boolean(spec?.hasSpecFile);
    const rolePrompt = specDriven ? spec.instructions || null : readMaybe(agentFile(targetRoot, role, "md"));
    const memory = loadRoleMemory(targetRoot, rolePrompt, {
      ...memoryOptions,
      // Spec pointers replace the host's universal floor entirely when a spec file exists.
      ...(specDriven ? { universal: [] } : {}),
      pointers: specDriven ? spec.memory_pointers : [],
      extra: extraMemory(toolContext)
    });

    const roleOptions = toolContext?.roleOptions || {};
    const capabilities = capabilityProfile(role, roleOptions);
    // Web access: prefer the engine's own web tools when it has them and can honor the role's
    // allowlist ("enforced"), or when the role's access is open anyway ("open"); otherwise the
    // kernel's web.fetch/web.search built-ins carry the same setting (see crew-tools.js).
    const web = spec?.web || false;
    const nativeWebKind = engine.capabilities?.nativeWeb || null;
    const nativeWeb = Boolean(web) && (nativeWebKind === "enforced" || (nativeWebKind === "open" && !web.allow.length));
    const workProfile = String(toolContext?.workProfile?.kind || "");
    const skills = listSkills({ targetRoot, role, workProfile });
    const preferences = listPreferences({ targetRoot }).effective;
    const governedContext = [roleContractInstructions(spec?.contract, { role }), context]
      .filter(Boolean)
      .join("\n\n");

    let workdir = targetRoot;
    let branch = null;
    let worktreeCreated = false;
    if (mode !== "execute" && readOnlyWorktree?.dir && existsSync(readOnlyWorktree.dir)) {
      workdir = readOnlyWorktree.dir;
      branch = readOnlyWorktree.branch || null;
      onStatus?.(`reviewing branch ${branch || "worktree"}`);
    } else if (mode === "execute") {
      // One worktree per execute conversation so each turn sees the previous turns' edits; a fresh one is created only on the first turn or after a tmp wipe/discard.
      if (worktree?.dir && worktree?.branch && existsSync(worktree.dir)) {
        workdir = worktree.dir;
        branch = worktree.branch;
        onStatus?.(`continuing on branch ${branch}`);
      } else {
        const created = createWorktree(targetRoot, `${role}`);
        workdir = created.dir;
        branch = created.branch;
        worktreeCreated = true;
        onLine?.(`[worktree] ${branch} (${workdir})`);
      }
    }

    const turn = engineId === "cli"
      ? {
          prompt: buildPromptBody({ role, rolePrompt, memory, messages, context: governedContext, capabilities, skills, preferences }),
          systemPrompt: null
        }
      : {
          prompt: resuming ? buildResumePrompt(messages, governedContext) : buildConversationPrompt(messages),
          systemPrompt: buildSystemPrompt({ role, rolePrompt, memory, mode, context: governedContext, capabilities, skills, preferences })
        };

    const handle = engine.startTurn({
      targetRoot,
      workdir,
      runnerId,
      profile: profile || { id: runnerId },
      role,
      capabilities,
      mode,
      systemPrompt: turn.systemPrompt,
      prompt: turn.prompt,
      resumeSessionId: resuming ? resumeSessionId : null,
      toolContext: {
        ...(toolContext || {}),
        targetRoot,
        root: targetRoot,
        role,
        capabilities,
        web,
        nativeWeb
      },
      tools,
      onLine,
      onPartialText,
      onStatus,
      onClose,
      onError
    });

    return {
      ...handle,
      runnerId,
      engineId,
      mode,
      isolation: mode === "execute" ? executionPolicy.runtime : "read-only",
      branch,
      workdir,
      worktreeCreated,
      resumed: resuming,
      capabilities,
      provider: profile?.provider || null
    };
  }

  // Best-effort headless turn: resolves { ok:false } on timeout or non-zero exit instead of rejecting.
  function runRoleCapture({ root, role, prompt, label = role, timeoutMs = 120000, toolContext = {}, context = "", onStatus, log, error, signal } = {}) {
    const lines = [];
    const marker = tools?.toolLineMarker || "";
    const isNoise = (line) => noise.test(line) || (marker && line.trimStart().startsWith(marker));
    return new Promise((resolve) => {
      let settled = false;
      let handle = null;
      let lastStatus = "";
      const finish = (value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        resolve({ ...value, runnerId: handle?.runnerId, engineId: handle?.engineId, provider: handle?.provider });
      };
      const abort = () => {
        try { handle?.kill?.("SIGTERM"); } catch { /* already gone */ }
        finish({ ok: false, reason: "Task stopped", text: lines.join("\n").trim() });
      };
      const timer = setTimeout(() => {
        try { handle?.kill?.("SIGTERM"); } catch { /* already gone */ }
        error?.(`${label}: timed out after ${Math.round(timeoutMs / 1000)}s`);
        finish({ ok: false, reason: "runner timed out", text: lines.join("\n").trim() });
      }, timeoutMs);
      timer.unref?.();

      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      try {
        handle = startRoleTurn({
          targetRoot: root,
          role,
          messages: [{ author: "user", content: prompt }],
          context,
          toolContext,
          onLine: (line) => { if (!isNoise(String(line || ""))) lines.push(String(line)); },
          onStatus: (status) => {
            const text = String(status || "");
            onStatus?.(text);
            if (text && text !== lastStatus) {
              lastStatus = text;
              log?.(`${label}: ${text}`);
            }
          },
          onError: (err) => lines.push(`[runner-error] ${err?.message || err}`),
          onClose: ({ code, stderr, usage, engineSessionId } = {}) => {
            const text = lines.join("\n").trim();
            if ((code === 0 || code === undefined || code === null) && text) { finish({ ok: true, text, usage, engineSessionId }); return; }
            finish({ ok: false, reason: `runner exited ${code ?? "unknown"}${stderr ? `: ${stderr}` : ""}`, text, usage, engineSessionId });
          }
        });
      } catch (err) {
        finish({ ok: false, reason: err?.message || String(err), text: "" });
      }
    });
  }

  // Best effort: resolves "" if no runner, on error, or on timeout — chats start untitled and get a real title once there's something to summarise.
  function generateConversationTitle({ targetRoot, role, messages }) {
    const runnerId = runnerIdForRole(role, targetRoot);
    const profile = resolveRunnerProfile(runnerId);
    if (!runnerId || !profile) return Promise.resolve("");

    const engine = getEngine(profile.engine || "cli");
    const transcript = (messages || [])
      .filter((msg) => msg.author === "user" || msg.author === role)
      .map((msg) => `${msg.author === "user" ? "User" : "Assistant"}: ${msg.content}`)
      .join("\n\n")
      .slice(0, 6000);
    const prompt = [
      "Summarise the conversation below as a short, specific title.",
      "Rules: 3 to 6 words, no surrounding quotes, no trailing punctuation, plain text only.",
      "Output only the title.",
      "",
      "Conversation:",
      transcript
    ].join("\n");

    return new Promise((resolve) => {
      const lines = [];
      let settled = false;
      let handle = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(cleanTitle(value));
      };
      const timer = setTimeout(() => {
        try { handle?.kill?.("SIGTERM"); } catch { /* already gone */ }
        finish(lines.join(" "));
      }, TITLE_TIMEOUT_MS);
      timer.unref?.();

      try {
        handle = engine.startTurn({
          targetRoot,
          workdir: targetRoot,
          runnerId,
          profile,
          role,
          capabilities: capabilityProfile("", {}),
          mode: "propose",
          systemPrompt: "You write short, specific titles for conversations. Reply with only the title.",
          prompt,
          resumeSessionId: null,
          onLine: (line) => lines.push(String(line)),
          onStatus: () => {},
          onClose: () => finish(lines.join(" ")),
          onError: () => {}
        });
      } catch {
        finish("");
      }
    });
  }

  return {
    runnerIdForRole,
    buildPromptBody,
    buildSystemPrompt,
    buildConversationPrompt,
    buildResumePrompt,
    isLikelyStaleSessionError,
    startRoleTurn,
    runRoleCapture,
    generateConversationTitle,
    loadRoleMemory: (targetRoot, roleText, options = {}) => loadRoleMemory(targetRoot, roleText, { ...memoryOptions, ...options })
  };
}

function preferencePrompt(preferences = []) {
  if (!preferences.length) return "";
  return [
    "## Approved preferences",
    "These preferences are approved context. A current user instruction or task/PR decision overrides them.",
    ...preferences.map((entry) => `- ${entry.key} [${entry.scope}]: ${entry.statement}`)
  ].join("\n");
}

function cleanTitle(raw) {
  const text = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] || "";
  const stripped = text.replace(/^["'`]+|["'`.]+$/g, "").trim();
  if (!stripped) return "";
  const words = stripped.split(/\s+/).slice(0, 8).join(" ");
  return words.slice(0, 80);
}

function contextSections({ rolePrompt, memory = [] }) {
  const out = rolePrompt ? ["## Role", rolePrompt, ""] : [];
  if (!rolePrompt && memory.length === 0) out.push("## Role", "(role file missing)", "");
  for (const section of memory) {
    out.push(`## ${section.title}`, section.body, "");
  }
  return out;
}

function resolveRoleMemoryPath(root, candidate) {
  const repoRoot = path.resolve(root);
  const resolved = path.resolve(root, String(candidate || ""));
  if (!pathIsWithin(repoRoot, resolved)) return "";
  if (!existsSync(resolved)) return resolved;
  try {
    const realRoot = realpathSync(root);
    const realFile = realpathSync(resolved);
    return pathIsWithin(realRoot, realFile) ? resolved : "";
  } catch {
    return "";
  }
}

function pathIsWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function parseMemoryPointers(roleText) {
  const text = String(roleText || "").replace(/\r\n/g, "\n");
  const block = text.match(/^memory_pointers:[ \t]*\n([\s\S]*?)(?:\n[A-Za-z0-9_]+:|\n---)/m);
  if (!block) return [];
  const out = [];
  for (const line of block[1].split("\n")) {
    const item = line.match(/^[ \t]*-[ \t]+(.+?)[ \t]*$/);
    if (!item) continue;
    const entry = item[1].trim();
    if (!entry.endsWith(".md") || /[<>*]/.test(entry)) continue; // skip globs / tool-fetched
    out.push(entry);
  }
  return out;
}

function memoryTitle(filePath, titles) {
  const base = path.basename(filePath).replace(/\.md$/, "");
  return titles[base] || DEFAULT_MEMORY_TITLES[base] || base.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function contextBlock(context) {
  const value = String(context || "").trim();
  return value ? [value, ""] : [];
}

function appendTranscript(lines, messages) {
  if (!messages || messages.length === 0) {
    lines.push("(no prior turns)");
    return;
  }
  for (const msg of messages) {
    lines.push("");
    lines.push(`### ${msg.author}`);
    lines.push(msg.content);
  }
}

function readMaybe(file) {
  try { return readFileSync(file, "utf8"); } catch { return null; }
}

export function createAgentRunner(options = {}) {
  const runner = createRoleRunner(options);
  return { ...runner, startAgentTurn: (options) => runner.startRoleTurn({ ...options, role: options.agent ?? options.role }), runAgentCapture: (options) => runner.runRoleCapture({ ...options, role: options.agent ?? options.role }) };
}
export { runnerIdForRole as runnerIdForAgent, loadRoleMemory as loadAgentMemory };
