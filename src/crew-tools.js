import { appendReflection } from "./reflections.js";
import { readSkill } from "./skills.js";
import { proposeSkill } from "./skill-proposals.js";
import { proposePreference } from "./preference-memory.js";

// The kernel's built-in tools — always available to every role, on every bridge: operations
// over crewrun's own memory stores, so the learning loop works with or without a host.
// A host that registers a tool with the same name overrides the built-in (its allowlists and
// implementation win); a registry may opt out entirely with `crewTools: false`.
// crewrun still ships zero domain tools: nothing here touches files outside <crew>/memory
// and <crew>/skills. The target root comes from the turn's tool context.
export const CREW_TOOL_NAMES = ["skill.read", "memory.reflect", "skill.propose", "prefs.propose"];

const DESCRIPTIONS = {
  "skill.read": "Load one skill from the index by id.",
  "memory.reflect": "Append one or two sentences to your private journal: what worked, or what to avoid next time.",
  "skill.propose": "Propose a reusable skill (id, description, content) — the operator approves it before it becomes durable.",
  "prefs.propose": "Propose a short durable working preference (key, statement) — the operator approves it before it applies."
};

const SCHEMAS = {
  "skill.read": (z) => ({ id: z.string() }),
  "memory.reflect": (z) => ({ text: z.string(), ref: z.string().optional() }),
  "skill.propose": (z) => ({ id: z.string(), description: z.string(), content: z.string(), roles: z.string().optional() }),
  "prefs.propose": (z) => ({ key: z.string(), statement: z.string(), evidence: z.string().optional() })
};

function rootFrom(context) {
  const targetRoot = context?.targetRoot || context?.root;
  if (!targetRoot) throw new Error("crew tools need a targetRoot in the tool context");
  return targetRoot;
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
  })
};

export const crewToolDefinitions = {
  names: CREW_TOOL_NAMES,
  describe: (toolName) => DESCRIPTIONS[toolName] || toolName,
  inputSchema: (toolName, z) => (SCHEMAS[toolName] ? SCHEMAS[toolName](z) : {}),
  call: ({ role, toolName, input, context }) => {
    const tool = REGISTRY[toolName];
    if (!tool) throw new Error(`tool ${toolName} is not registered`);
    return tool(input, { role, context });
  },
  alwaysLoad: (toolName) => toolName === "skill.read" || toolName === "memory.reflect"
};
