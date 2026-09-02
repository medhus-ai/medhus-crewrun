import { createMcpBridge } from "./mcp.js";
import { appendReflection } from "./reflections.js";
import { readSkill } from "./skills.js";
import { proposeSkill } from "./skill-proposals.js";
import { proposePreference } from "./preference-memory.js";

// The kernel's only tools: operations over crewrun's own memory stores, so a project with no
// host still completes the learning loop (read a skill, journal a reflection, propose a skill
// or preference for the operator to approve via `crewrun proposals`). Nothing here touches
// files outside <crew>/memory and <crew>/skills, and a host bridge always replaces this one
// wholesale — crewrun still ships zero domain tools.
const TOOLS = ["skill.read", "memory.reflect", "skill.propose", "prefs.propose"];

const DESCRIPTIONS = {
  "skill.read": "Load one skill from the index by id.",
  "memory.reflect": "Append one or two sentences to your private journal: what worked, or what to avoid next time.",
  "skill.propose": "Propose a reusable skill (id, description, content) — the operator approves it before it becomes durable.",
  "prefs.propose": "Propose a short durable working preference (key, statement) — the operator approves it before it applies."
};

export function createCrewToolsBridge({ targetRoot } = {}) {
  if (!targetRoot) throw new Error("createCrewToolsBridge requires targetRoot");

  const registry = {
    "skill.read": async (input, { role }) => readSkill({ targetRoot, id: input?.id, role }),
    "memory.reflect": async (input, { role }) => appendReflection({ targetRoot, role, text: input?.text, ref: input?.ref || "" }),
    "skill.propose": async (input, { role }) => proposeSkill({
      targetRoot, id: input?.id, description: input?.description, content: input?.content,
      roles: String(input?.roles || "").split(",").map((r) => r.trim()).filter(Boolean),
      scope: "repository", proposedBy: role
    }),
    "prefs.propose": async (input, { role }) => proposePreference({
      targetRoot, key: input?.key, statement: input?.statement,
      scope: "repository", evidence: input?.evidence || "", proposedBy: role
    })
  };

  const schemas = {
    "skill.read": (z) => ({ id: z.string() }),
    "memory.reflect": (z) => ({ text: z.string(), ref: z.string().optional() }),
    "skill.propose": (z) => ({ id: z.string(), description: z.string(), content: z.string(), roles: z.string().optional() }),
    "prefs.propose": (z) => ({ key: z.string(), statement: z.string(), evidence: z.string().optional() })
  };

  return createMcpBridge({
    serverName: "crew",
    toolsForRole: () => [...TOOLS],
    describe: (toolName) => DESCRIPTIONS[toolName] || toolName,
    inputSchema: (toolName, z) => (schemas[toolName] ? schemas[toolName](z) : {}),
    call: async ({ role, toolName, input }) => {
      const tool = registry[toolName];
      if (!tool) throw new Error(`tool ${toolName} is not registered`);
      return tool(input, { role });
    },
    alwaysLoad: (toolName) => toolName === "skill.read" || toolName === "memory.reflect"
  });
}
