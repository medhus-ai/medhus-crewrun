import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeWorkspace, readWorkspace, WORKSPACE_FILE, resolveWorkspacePath } from "./workspace-manifest.js";
import { WORK_TOOLS } from "./workspace-tools.js";
import { WEB_TOOL_NAMES } from "./crew-tools.js";

export function workspacePreset({ kind = "personal", name = "My workspace", timezone = "UTC", goal = "Help me make progress on my priorities.", runner = "claude-agent-sonnet-high" } = {}) {
  if (kind === "launch-desk") return launchDeskPreset({ name, timezone, runner });
  if (!["personal", "organization"].includes(kind)) throw new Error("Choose personal, organization, or launch-desk.");
  const agent = kind === "personal" ? "assistant" : "coordinator";
  const manifest = normalizeWorkspace({ version: 1, id: randomUUID(), name, timezone, context: ["README.md"], policy: { drafts: ["drafts", "outputs"] } });
  const contract = {
    version: 1, revision: 1, mandate: goal,
    authority: {
      tools: Object.keys(WORK_TOOLS).map((name) => ({ name, impact: ["crew.roster", "task.get", "task.list", "workspace.read", "workspace.search"].includes(name) ? "read" : "internal-write" })).concat([{ name: "skill.read", impact: "read" }, { name: "skill.propose", impact: "internal-write" }], WEB_TOOL_NAMES.map((name) => ({ name, impact: "read" }))),
      data: { read: ["workspace:readme.md", "workspace:knowledge/*", `workspace:drafts/${agent}/*`, `workspace:outputs/${agent}/*`], write: ["workspace:knowledge/*", `workspace:drafts/${agent}/*`, `workspace:outputs/${agent}/*`] },
      handoffs: { send: [], receive: [] }
    },
    approvals: { required_for: ["external-write", "destructive", "financial"] }
  };
  const spec = { title: kind === "personal" ? "Personal assistant" : "Coordinator", runner, instructions: `${goal}\nUse governed tools for work. Ask the owner when blocked. Save drafts only in your assigned folder; propose durable changes for review.`, memory_pointers: ["README.md"], contract, web: true, heartbeat: null, hooks: [], scheduled: [] };
  return [
    { path: WORKSPACE_FILE, content: JSON.stringify(manifest, null, 2) + "\n" },
    { path: `.crew/agents/${agent}.json`, content: JSON.stringify(spec, null, 2) + "\n" },
    { path: "README.md", content: `# ${name}\n\n${goal}\n\nThis repository is a CrewRun workspace. Knowledge lives in Markdown; tasks, reviews, chats, and connection credentials live in private host state. Start with \`crewrun up . --console\`. Use the side helper or agent forms to refine this workspace. Nothing is scheduled or connected until you enable it.\n` }
  ];
}

// A small, usable demonstration rather than a generic collection of JSON files.  It shows the
// core CrewRun loop: a coordinator delegates bounded work, specialists write only their own
// drafts, and a routine is visible but inert until its owner enables it.
function launchDeskPreset({ name = "Launch Desk", timezone = "UTC", runner = "claude-agent-sonnet-high" } = {}) {
  const manifest = normalizeWorkspace({ version: 1, id: randomUUID(), name, timezone, context: ["README.md", "knowledge/product-brief.md", "knowledge/audience.md"], policy: { drafts: ["drafts", "outputs"] } });
  const readTools = ["crew.roster", "task.list", "task.get", "workspace.read", "workspace.search"];
  const internalTools = ["task.create", "task.update", "task.delegate", "task.askOwner", "task.saveArtifact", "chat.setTopic", "workspace.writeDraft", "workspace.proposePatch"];
  const toolsFor = (names) => names.map((name) => ({ name, impact: readTools.includes(name) ? "read" : "internal-write" }));
  const contract = ({ mandate, tools, read, write, send = [], receive = [] }) => ({
    version: 1, revision: 1, mandate,
    authority: { tools: toolsFor(tools).concat([{ name: "skill.read", impact: "read" }]), data: { read, write }, handoffs: { send, receive } },
    approvals: { required_for: ["external-write", "destructive", "financial"] }
  });
  const coordinator = {
    title: "Launch coordinator", runner,
    instructions: "Turn the owner's launch goal into bounded work. Delegate research or writing only when it helps, keep the owner informed, and bring durable changes back as reviewable proposals.",
    memory_pointers: ["README.md", "knowledge/product-brief.md", "knowledge/audience.md"], web: false, heartbeat: null, hooks: [],
    contract: contract({
      mandate: "Coordinate a small product launch without taking external actions.",
      tools: [...readTools, ...internalTools],
      read: ["workspace:readme.md", "workspace:knowledge/*", "workspace:drafts/*", "workspace:outputs/*"],
      write: ["workspace:drafts/coordinator/*", "workspace:outputs/coordinator/*"], send: ["researcher", "writer"], receive: ["researcher", "writer"]
    }),
    scheduled: [{ id: "weekly-launch-check", title: "Weekly launch check", cron: "0 9 * * 1", enabled: false, prompt: "Review active launch tasks, surface blockers, and prepare a concise owner update. Do not send anything externally." }]
  };
  const researcher = {
    title: "Market researcher", runner,
    instructions: "Find and synthesize evidence for the launch. Keep claims sourced, save notes in your draft folder, and never publish or contact anyone.",
    memory_pointers: ["knowledge/product-brief.md", "knowledge/audience.md"], web: { allow: ["github.com", "news.ycombinator.com", "producthunt.com", "g2.com"], max_chars: 20000 }, heartbeat: null, hooks: [],
    contract: contract({
      mandate: "Research the audience and market; produce evidence-backed internal drafts only.",
      tools: [...readTools, "task.update", "task.askOwner", "task.saveArtifact", "chat.setTopic", "workspace.writeDraft"],
      read: ["workspace:readme.md", "workspace:knowledge/*", "workspace:drafts/researcher/*", "workspace:outputs/researcher/*"],
      write: ["workspace:drafts/researcher/*", "workspace:outputs/researcher/*"], receive: ["coordinator"]
    })
  };
  const writer = {
    title: "Launch writer", runner,
    instructions: "Turn approved workspace context and research notes into clear internal launch drafts. Do not invent evidence, publish, or contact anyone.",
    memory_pointers: ["knowledge/product-brief.md", "knowledge/audience.md", "drafts/researcher/README.md"], web: false, heartbeat: null, hooks: [],
    contract: contract({
      mandate: "Write internal launch drafts from authorized context and research.",
      tools: [...readTools, "task.update", "task.askOwner", "task.saveArtifact", "chat.setTopic", "workspace.writeDraft"],
      read: ["workspace:readme.md", "workspace:knowledge/*", "workspace:drafts/researcher/*", "workspace:drafts/writer/*", "workspace:outputs/writer/*"],
      write: ["workspace:drafts/writer/*", "workspace:outputs/writer/*"], receive: ["coordinator"]
    })
  };
  return [
    { path: WORKSPACE_FILE, content: JSON.stringify(manifest, null, 2) + "\n" },
    { path: ".crew/agents/coordinator.json", content: JSON.stringify(coordinator, null, 2) + "\n" },
    { path: ".crew/agents/researcher.json", content: JSON.stringify(researcher, null, 2) + "\n" },
    { path: ".crew/agents/writer.json", content: JSON.stringify(writer, null, 2) + "\n" },
    { path: "README.md", content: `# ${name}\n\nA small CrewRun workspace for preparing a product launch without granting any agent publishing authority.\n\n## Try the complete loop\n\nOpen the **Launch coordinator** chat and ask:\n\n> Turn our brief into a launch plan. Delegate market evidence to the researcher, then have the writer prepare a one-page launch brief for my review.\n\nYou will see linked tasks and handoffs, research saved under \`drafts/researcher/\`, a launch draft under \`drafts/writer/\`, and any durable change proposed in **Reviews**. The disabled weekly check is visible in **Scheduled** but cannot run until you toggle it on.\n\nNothing here can post, email, publish, or change a connected service. Add integrations and approve their use later if you need them.\n` },
    { path: "knowledge/product-brief.md", content: "# Product brief\n\n## Product\n\nSignalboard is a lightweight weekly operating brief for independent product teams. It turns scattered decisions, customer feedback, and delivery risks into one clear update.\n\n## Launch outcome\n\nPrepare a credible one-page launch brief that explains the problem, audience, promise, and first call to action. The owner decides whether anything is published.\n\n## Constraints\n\n- Make evidence and assumptions distinct.\n- Do not contact customers or publish content.\n- Keep claims modest until the owner approves them.\n" },
    { path: "knowledge/audience.md", content: "# Audience\n\nPrimary users are product leads at small software teams (5–30 people) who spend too much time assembling status updates from chat, issue trackers, and meeting notes.\n\nThey value clarity, a predictable weekly rhythm, and the ability to trace a statement back to its source.\n" },
    { path: "drafts/researcher/README.md", content: "# Research notes\n\nThe market researcher saves sourced notes here. The launch writer may read this folder; other workspace files remain scoped by each agent's contract.\n" },
    { path: "drafts/writer/README.md", content: "# Launch drafts\n\nThe launch writer saves internal drafts here. A draft is not publication approval.\n" }
  ];
}

export function initializeWorkspace(root, options = {}) {
  mkdirSync(root, { recursive: true });
  if (readWorkspace(root)) throw new Error("This workspace is already initialized.");
  const changes = workspacePreset(options);
  for (const change of changes) if (existsSync(resolveWorkspacePath(root, change.path))) throw new Error(`${change.path} exists; initialization never overwrites existing content. Use setup proposals instead.`);
  for (const change of changes) {
    const file = resolveWorkspacePath(root, change.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, change.content, { flag: "wx" });
  }
  return readWorkspace(root);
}
