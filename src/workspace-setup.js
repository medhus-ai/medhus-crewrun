import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeWorkspace, readWorkspace, WORKSPACE_FILE, resolveWorkspacePath } from "./workspace-manifest.js";
import { WORK_TOOLS } from "./workspace-tools.js";

export function workspacePreset({ kind = "personal", name = "My workspace", timezone = "UTC", goal = "Help me make progress on my priorities.", runner = "claude-agent-sonnet-high" } = {}) {
  if (!["personal", "organization"].includes(kind)) throw new Error("Choose personal or organization.");
  const agent = kind === "personal" ? "assistant" : "coordinator";
  const manifest = normalizeWorkspace({ version: 1, id: randomUUID(), name, timezone, context: ["README.md"], policy: { drafts: ["drafts", "outputs"] } });
  const contract = {
    version: 1, revision: 1, mandate: goal,
    authority: {
      tools: Object.keys(WORK_TOOLS).filter((name) => name !== "task.delegate").map((name) => ({ name, impact: ["task.get", "task.list", "workspace.read", "workspace.search"].includes(name) ? "read" : "internal-write" })).concat([{ name: "skill.read", impact: "read" }, { name: "skill.propose", impact: "internal-write" }]),
      data: { read: ["workspace:readme.md", "workspace:knowledge/*", `workspace:drafts/${agent}/*`, `workspace:outputs/${agent}/*`], write: ["workspace:knowledge/*", `workspace:drafts/${agent}/*`, `workspace:outputs/${agent}/*`] },
      handoffs: { send: [], receive: [] }
    },
    approvals: { required_for: ["external-write", "destructive", "financial"] }
  };
  const spec = { title: kind === "personal" ? "Personal assistant" : "Coordinator", runner, instructions: `${goal}\nUse governed tools for work. Ask the owner when blocked. Save drafts only in your assigned folder; propose durable changes for review.`, memory_pointers: ["README.md"], contract, web: false, heartbeat: null, hooks: [], scheduled: [] };
  return [
    { path: WORKSPACE_FILE, content: JSON.stringify(manifest, null, 2) + "\n" },
    { path: `.crew/agents/${agent}.json`, content: JSON.stringify(spec, null, 2) + "\n" },
    { path: "README.md", content: `# ${name}\n\n${goal}\n\nThis repository is a CrewRun workspace. Knowledge lives in Markdown; tasks, reviews, chats, and connection credentials live in private host state. Start with \`crewrun up . --console\`. Use the side helper or agent forms to refine this workspace. Nothing is scheduled or connected until you enable it.\n` }
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
