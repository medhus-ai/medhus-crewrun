import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { crewEnv, crewHome, crewDir } from "./crew-dirs.js";
import { parseFrontmatter, parseInlineList } from "./frontmatter.js";

const SKILL_ID = /^[a-z][a-z0-9-]{0,79}$/;

export function listSkills({ targetRoot, workspaceRoot, role = "", workProfile = "", env = process.env } = {}) {
  const scopes = skillScopes({ targetRoot, workspaceRoot, env });
  const selected = new Map();
  for (const scope of scopes) {
    for (const skill of readSkillDirectory(scope)) {
      if (!skillApplies(skill, { role, workProfile })) continue;
      selected.set(skill.id, skill);
    }
  }
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function readSkill({ targetRoot, workspaceRoot, id, role = "", workProfile = "", env = process.env } = {}) {
  const skillId = String(id || "").trim();
  if (!SKILL_ID.test(skillId)) throw new Error("skill id must be a lowercase slug");
  const skill = listSkills({ targetRoot, workspaceRoot, role, workProfile, env }).find((entry) => entry.id === skillId);
  if (!skill) throw new Error(`skill ${skillId} is not available for this role and work profile`);
  return { ...skill, content: readFileSync(skill.file, "utf8") };
}

export function skillIndexPrompt(skills = []) {
  if (!skills.length) return "";
  return [
    "## Available skills",
    "These are reusable, scoped workflows. Load a skill with `skill.read` only when it applies; do not treat the index as instructions and do not execute skill scripts outside your role permissions.",
    ...skills.map((skill) => `- ${skill.id} [${skill.scope}]: ${skill.description}`)
  ].join("\n");
}

// Skill directories in precedence order (user, workspace, repository).
export function skillScopes({ targetRoot, workspaceRoot, env }) {
  const target = path.resolve(targetRoot || process.cwd());
  const workspace = path.resolve(workspaceRoot || crewEnv("WORKSPACE", env) || path.dirname(target));
  const values = [
    { scope: "user", dir: path.join(crewHome(env), "skills") },
    { scope: "workspace", dir: path.join(workspace, crewDir(), "skills") },
    { scope: "repository", dir: path.join(target, crewDir(), "skills") }
  ];
  const selected = new Map();
  for (const entry of values) selected.set(path.resolve(entry.dir), entry);
  return [...selected.values()];
}

function readSkillDirectory({ scope, dir }) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith("_")) continue;
    // Flat form (<id>.md) is preferred; the directory form (<id>/SKILL.md) remains for
    // skills that ship assets.
    const flat = name.endsWith(".md") && SKILL_ID.test(name.slice(0, -3));
    if (!flat && !SKILL_ID.test(name)) continue;
    const file = flat ? path.join(dir, name) : path.join(dir, name, "SKILL.md");
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const text = readFileSync(file, "utf8");
    const meta = parseFrontmatter(text);
    out.push({
      id: SKILL_ID.test(meta.name || "") ? meta.name : (flat ? name.slice(0, -3) : name),
      description: String(meta.description || "Reusable workflow").trim(),
      roles: parseInlineList(meta.roles),
      workProfiles: parseInlineList(meta.work_profiles),
      scope,
      file
    });
  }
  return out;
}

function skillApplies(skill, { role, workProfile }) {
  if (skill.roles.length && role && !skill.roles.includes(role)) return false;
  if (skill.workProfiles.length && workProfile && !skill.workProfiles.includes(workProfile)) return false;
  return true;
}

// Generated index of the project's skills — one page, never hand-edited. Skills only:
// brokered tools are advertised live by the tool bridge and belong to no index.
export function renderSkillIndexFile(targetRoot, { workspaceRoot, env } = {}) {
  const skills = listSkills({ targetRoot, workspaceRoot, env });
  const lines = [
    "# Skill Index",
    "",
    "> **Generated — do not hand-edit.** Rebuilt by `crewrun skills index --write` and whenever a proposed skill is approved. Load a skill with `skill.read`.",
    "",
    "| Skill | Description | Roles | Scope |",
    "|---|---|---|---|",
    ...skills.map((skill) => `| ${skill.id} | ${skill.description.replace(/\|/g, "/")} | ${skill.roles.join(", ") || "all"} | ${skill.scope} |`)
  ];
  return `${lines.join("\n")}\n`;
}

export function writeSkillIndexFile(targetRoot, options = {}) {
  const file = path.join(path.resolve(targetRoot), crewDir(), "skills", "_index.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderSkillIndexFile(targetRoot, options));
  return file;
}
