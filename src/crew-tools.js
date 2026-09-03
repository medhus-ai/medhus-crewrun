import { appendReflection } from "./reflections.js";
import { readSkill } from "./skills.js";
import { proposeSkill } from "./skill-proposals.js";
import { proposePreference } from "./preference-memory.js";
import { loadRoleSpec } from "./role-spec.js";
import { webFetch, webSearch } from "./web.js";

// The kernel's built-in tools — present on every bridge, so the learning loop works with or
// without a host. A host that registers a tool with the same name overrides the built-in (its
// allowlists and implementation win); a registry may opt out entirely with `crewTools: false`.
// The learning tools touch nothing outside <crew>/memory and <crew>/skills. The web tools are
// the one gated pair: they appear only for roles whose spec enables `web` (see web.js).
// The target root comes from the turn's tool context.
export const LEARNING_TOOL_NAMES = ["skill.read", "memory.reflect", "skill.propose", "prefs.propose"];
export const WEB_TOOL_NAMES = ["web.fetch", "web.search"];
export const CREW_TOOL_NAMES = [...LEARNING_TOOL_NAMES, ...WEB_TOOL_NAMES];

const DESCRIPTIONS = {
  "skill.read": "Load one skill from the index by id.",
  "memory.reflect": "Append one or two sentences to your private journal: what worked, or what to avoid next time.",
  "skill.propose": "Propose a reusable skill (id, description, content) — the operator approves it before it becomes durable.",
  "prefs.propose": "Propose a short durable working preference (key, statement) — the operator approves it before it applies.",
  "web.fetch": "GET one public http(s) URL and return its text (HTML stripped, capped). Read-only; subject to your role's allowlist.",
  "web.search": "Search the web (DuckDuckGo) and return up to `max_results` rows of title, url, snippet. Follow up with web.fetch."
};

const SCHEMAS = {
  "skill.read": (z) => ({ id: z.string() }),
  "memory.reflect": (z) => ({ text: z.string(), ref: z.string().optional() }),
  "skill.propose": (z) => ({ id: z.string(), description: z.string(), content: z.string(), roles: z.string().optional() }),
  "prefs.propose": (z) => ({ key: z.string(), statement: z.string(), evidence: z.string().optional() }),
  "web.fetch": (z) => ({ url: z.string() }),
  "web.search": (z) => ({ query: z.string(), max_results: z.string().optional() })
};

function rootFrom(context) {
  const targetRoot = context?.targetRoot || context?.root;
  if (!targetRoot) throw new Error("crew tools need a targetRoot in the tool context");
  return targetRoot;
}

// The role's web setting, resolved from its spec at call time (false when off or unknown).
export function webAccessFor(role, context) {
  const targetRoot = context?.targetRoot || context?.root;
  if (!targetRoot) return false;
  try { return loadRoleSpec(targetRoot, role)?.web || false; } catch { return false; }
}

const REGISTRY = {
  "skill.read": async (input, { role, context }) => readSkill({ targetRoot: rootFrom(context), id: input?.id, role }),
  "memory.reflect": async (input, { role, context }) => appendReflection({ targetRoot: rootFrom(context), role, text: input?.text, ref: input?.ref || "" }),
  "skill.propose": async (input, { role, context }) => proposeSkill({
    targetRoot: rootFrom(context), id: input?.id, description: input?.description, content: input?.content,
    roles: String(input?.roles || "").split(",").map((entry) => entry.trim()).filter(Boolean),
    scope: "repository", proposedBy: role
  }),
  "prefs.propose": async (input, { role, context }) => proposePreference({
    targetRoot: rootFrom(context), key: input?.key, statement: input?.statement,
    scope: "repository", evidence: input?.evidence || "", proposedBy: role
  }),
  "web.fetch": async (input, { role, context }) => {
    const web = webAccessFor(role, context);
    if (!web) throw new Error(`web access is off for role ${role} — set "web": true in its spec`);
    return webFetch({ url: input?.url, allow: web.allow, maxChars: web.max_chars, fetchImpl: context?.fetchImpl });
  },
  "web.search": async (input, { role, context }) => {
    const web = webAccessFor(role, context);
    if (!web || !web.search) throw new Error(`web search is off for role ${role}`);
    return webSearch({ query: input?.query, maxResults: Number(input?.max_results) || 8, fetchImpl: context?.fetchImpl });
  }
};

// Built-in tool names for one role in one tool context: the learning tools always, the web
// tools only when the role's spec enables them. Without a targetRoot nothing can be resolved,
// so only the ungated tools are offered.
export function crewToolNamesFor(role, context = {}) {
  const web = webAccessFor(role, context);
  if (!web) return [...LEARNING_TOOL_NAMES];
  return [...LEARNING_TOOL_NAMES, "web.fetch", ...(web.search ? ["web.search"] : [])];
}

export const crewToolDefinitions = {
  names: CREW_TOOL_NAMES,
  namesFor: crewToolNamesFor,
  describe: (toolName) => DESCRIPTIONS[toolName] || toolName,
  inputSchema: (toolName, z) => (SCHEMAS[toolName] ? SCHEMAS[toolName](z) : {}),
  call: ({ role, toolName, input, context }) => {
    const tool = REGISTRY[toolName];
    if (!tool) throw new Error(`tool ${toolName} is not registered`);
    return tool(input, { role, context });
  },
  alwaysLoad: (toolName) => ["skill.read", "memory.reflect", "web.fetch", "web.search"].includes(toolName)
};
