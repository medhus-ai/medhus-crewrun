import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listSkills, readSkill, skillIndexPrompt } from "../src/skills.js";

test("skills resolve lazily with repository over workspace over user precedence", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "gitcrew-skills-"));
  const home = path.join(base, "home");
  const workspace = path.join(base, "workspace");
  const repo = path.join(workspace, "repo");
  await writeSkill(path.join(home, ".crew/skills/review"), "user review", "[code-reviewer]");
  await writeSkill(path.join(workspace, ".crew/skills/review"), "workspace review", "[code-reviewer]");
  await writeSkill(path.join(repo, ".crew/skills/review"), "repository review", "[code-reviewer]");
  await writeSkill(path.join(repo, ".crew/skills/build"), "build only", "[engineer]");

  const env = { CREW_HOME: path.join(home, ".crew") };
  const skills = listSkills({ targetRoot: repo, workspaceRoot: workspace, role: "code-reviewer", env });
  assert.deepEqual(skills.map((skill) => skill.id), ["review"]);
  assert.equal(skills[0].scope, "repository");
  assert.equal(readSkill({ targetRoot: repo, workspaceRoot: workspace, role: "code-reviewer", id: "review", env }).content.includes("repository review"), true);
  assert.match(skillIndexPrompt(skills), /Load a skill with `skill.read` only when it applies/);
});

async function writeSkill(dir, description, roles) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${path.basename(dir)}\ndescription: ${description}\nroles: ${roles}\n---\n\n# Skill\n`, "utf8");
}
