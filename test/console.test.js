import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createConsole } from "../src/console/server.js";
import { proposeSkill } from "../src/skill-proposals.js";

async function project() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-console-"));
  const root = path.join(parent, "repo");
  await mkdir(path.join(root, ".crew", "roles"), { recursive: true });
  await mkdir(path.join(root, ".crew", "skills"), { recursive: true });
  await writeFile(path.join(root, ".crew", "roles", "_defaults.json"), JSON.stringify({ runner: "claude-agent-sonnet-high" }), "utf8");
  await writeFile(path.join(root, ".crew", "roles", "ops.json"), JSON.stringify({
    title: "Operations", hooks: [], schedules: [{ id: "tick", cron: "0 9 * * 1", prompt: "weekly", enabled: false }]
  }, null, 2), "utf8");
  await writeFile(path.join(root, ".crew", "skills", "file-a-task.md"), "---\nname: file-a-task\ndescription: How to file\n---\n# File\n", "utf8");
  return { parent, root };
}

test("console renders pages and performs actions over the project's .crew", async () => {
  const { parent, root } = await project();
  const proposal = proposeSkill({ targetRoot: root, id: "weekly-brief", description: "Draft the brief", content: "steps", proposedBy: "ops" });
  const console_ = createConsole({ targetRoot: root, port: 0, log: () => {} });
  const port = await console_.listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    const dashboard = await (await fetch(base + "/")).text();
    assert.match(dashboard, /1 roles/);
    assert.match(dashboard, /1 proposal pending/);
    assert.match(dashboard, /skill\.read/, "built-in tools are listed");

    const roles = await (await fetch(base + "/roles")).text();
    assert.match(roles, /ops — Operations/);
    assert.match(roles, /_defaults\.json/);

    const schedules = await (await fetch(base + "/schedules")).text();
    assert.match(schedules, /ops:tick/);
    assert.match(schedules, /disabled/);
    assert.doesNotMatch(schedules, /Run now/, "run-now hidden without an attached loop");

    // toggle the schedule on → written into the role's spec
    await fetch(base + "/schedules/toggle", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "id=tick&enabled=1" });
    const spec = JSON.parse(await readFile(path.join(root, ".crew", "roles", "ops.json"), "utf8"));
    assert.equal(spec.schedules[0].enabled, true);

    // approve the proposal → flat skill file + index regenerated
    await fetch(base + "/proposals/decide", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${proposal.id}&kind=skill&action=approve` });
    assert.ok(existsSync(path.join(root, ".crew", "skills", "weekly-brief.md")));
    assert.match(await readFile(path.join(root, ".crew", "skills", "_index.md"), "utf8"), /weekly-brief/);

    // add a role, then save an edited spec
    await fetch(base + "/roles/add", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "role=analyst&title=Analyst" });
    assert.ok(existsSync(path.join(root, ".crew", "roles", "analyst.json")));
    await fetch(base + "/roles/save", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "role=analyst&json=" + encodeURIComponent(JSON.stringify({ title: "Analyst", heartbeat: "1d" })) });
    const analyst = JSON.parse(await readFile(path.join(root, ".crew", "roles", "analyst.json"), "utf8"));
    assert.equal(analyst.heartbeat, "1d");

    const bad = await fetch(base + "/roles/save", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "role=..%2Fevil&json={}" });
    assert.equal(bad.status, 400, "role slugs are validated");
  } finally {
    await console_.close();
    await rm(parent, { recursive: true, force: true });
  }
});
