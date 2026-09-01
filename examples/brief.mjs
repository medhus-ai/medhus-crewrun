// Run one role turn headlessly: a "ceo" role reads a tiny inbox through a brokered MCP tool
// and writes a brief. Needs a signed-in `claude` CLI (Pro/Max) or ANTHROPIC_API_KEY, or set
// OPENROUTER_API_KEY and change RUNNER to "openrouter-auto".
//
//   node examples/brief.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMcpBridge } from "crewrun/mcp";
import { createRoleRunner } from "crewrun/runner";
import { createToolBroker } from "crewrun/tool-broker";
import { createWorkItemSource } from "crewrun/work-items";

const RUNNER = process.env.CREW_EXAMPLE_RUNNER || "claude-agent-sonnet-high";

// 1. A project: a role file plus the role → runner mapping, under the crew directory (.crew).
const project = mkdtempSync(path.join(os.tmpdir(), "crewrun-example-"));
mkdirSync(path.join(project, ".crew", "roles"), { recursive: true });
mkdirSync(path.join(project, ".crew", "memory"), { recursive: true });
writeFileSync(path.join(project, ".crew", "roles", "ceo.md"), [
  "---", "name: ceo", "title: Chief Executive Officer", "modes: [direct-chat]", "---",
  "# Chief Executive Officer", "",
  "Read the open work items with the inbox tool, then write a five-line brief: top priority,",
  "blockers, and the one decision the founder must make today. Do not invent items."
].join("\n"));
writeFileSync(path.join(project, ".crew", "memory", "ai-runners.json"), JSON.stringify({ version: 1, default_role_runners: { ceo: RUNNER } }));

// 2. Work items as files.
const inbox = createWorkItemSource({ dir: path.join(project, "inbox") });
inbox.create("renew-domain", { title: "Renew the domain", fields: { status: "open", owner: "OPS", priority: "P1" } });
inbox.create("pricing-page", { title: "Draft the pricing page", fields: { status: "blocked", owner: "GTM", priority: "P2" }, body: "Blocked on the CEO's pricing direction." });

// 3. Tools the role may call, brokered per role and served to the model over MCP.
const broker = createToolBroker({ allowlists: { ceo: ["inbox.list"] } });
const registry = { "inbox.list": async (input) => inbox.list(input.status ? { status: input.status } : {}) };
const tools = createMcpBridge({
  serverName: "company",
  toolsForRole: (role) => broker.toolsForRole(role),
  describe: () => "List work items, optionally filtered by status.",
  inputSchema: (name, z) => ({ status: z.string().optional() }),
  call: ({ role, toolName, input }) => broker.callTool({ role, toolName, input, registry })
});

// 4. One headless turn.
const runner = createRoleRunner({ tools, displayRoleName: () => "Chief Executive Officer" });
const result = await runner.runRoleCapture({ root: project, role: "ceo", prompt: "Write today's brief.", timeoutMs: 180000, log: console.error });
console.log(result.ok ? result.text : `failed: ${result.reason}`);
