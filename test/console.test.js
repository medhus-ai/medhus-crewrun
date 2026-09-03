import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createConsole } from "../src/console/server.js";
import { getActionApproval, requestActionApproval } from "../src/action-approvals.js";
import { proposeReflection } from "../src/reflection-proposals.js";
import { proposeSkill } from "../src/skill-proposals.js";

async function project() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-console-"));
  const root = path.join(parent, "repo");
  await mkdir(path.join(root, ".crew", "roles"), { recursive: true });
  await mkdir(path.join(root, ".crew", "skills"), { recursive: true });
  await writeFile(path.join(root, ".crew", "roles", "_defaults.json"), JSON.stringify({ runner: "claude-agent-sonnet-high" }), "utf8");
  await writeFile(path.join(root, ".crew", "roles", "ops.json"), JSON.stringify({
    title: "Operations", hooks: [], memory_pointers: ["docs/ops.md"], schedules: [{ id: "tick", cron: "0 9 * * 1", prompt: "weekly", enabled: false }]
  }, null, 2), "utf8");
  await writeFile(path.join(root, ".crew", "skills", "file-a-task.md"), "---\nname: file-a-task\ndescription: How to file\n---\n# File\n", "utf8");
  return { parent, root };
}

test("console renders pages and performs actions over the project's .crew", async () => {
  const { parent, root } = await project();
  const proposal = proposeSkill({ targetRoot: root, id: "weekly-brief", description: "Draft the brief", content: "steps", proposedBy: "ops" });
  const manualRuns = [];
  const console_ = createConsole({
    targetRoot: root,
    port: 0,
    log: () => {},
    up: {
      scheduler: {
        runNow: async (entry) => {
          manualRuns.push(entry);
          return { lastStatus: "ok" };
        }
      }
    }
  });
  const port = await console_.listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    const dashboard = await (await fetch(base + "/")).text();
    assert.match(dashboard, /1 roles/);
    assert.match(dashboard, /1 proposal pending/);
    assert.match(dashboard, /skill\.read/, "built-in tools are listed");
    assert.match(dashboard, /class="sidebar"/, "console uses the persistent workspace rail");
    assert.match(dashboard, /aria-label="Dashboard"/, "the dashboard link remains named for assistive technology");
    assert.match(dashboard, /class="nav-icon"/, "menu icons are inline and dependency-free");
    assert.match(dashboard, /class="sidebar-resizer"/, "the sidebar has a mouse resize handle");
    assert.match(dashboard, /role="separator" aria-orientation="vertical" aria-label="Resize sidebar"/, "the resize handle is announced correctly");
    assert.match(dashboard, /aria-controls="sidebar"/, "the separator identifies the navigation it resizes");
    assert.match(dashboard, /crewrun\.console\.sidebar-width/, "the chosen sidebar width is kept locally");
    assert.match(dashboard, /padding: 41px 28px 64px/, "page content keeps a gutter from the sidebar edge");
    assert.match(dashboard, /--sidebar: #f3f3f3/, "the reference light shell is rendered with the page");
    assert.doesNotMatch(dashboard, /Back to Crew/, "the top rail no longer repeats a back-to-crew control");
    assert.doesNotMatch(dashboard, /Manage roles/, "the dashboard does not duplicate the role directory");
    assert.doesNotMatch(dashboard, /Scheduled work/, "the dashboard does not duplicate the schedules page");

    const roles = await (await fetch(base + "/roles")).text();
    assert.match(roles, /ops — Operations/);
    assert.match(roles, /href="\/roles\/new"/);
    assert.doesNotMatch(roles, /Role memory pointers/, "the role directory does not embed an editor");
    assert.doesNotMatch(roles, /Initialize v1 contract/, "governance controls live in the role subpage");

    const newRole = await (await fetch(base + "/roles/new")).text();
    assert.match(newRole, /<h1>Add role<\/h1>/);
    assert.match(newRole, /href="\/roles" aria-label="Back to roles"/);
    assert.doesNotMatch(newRole, /Role directory/);

    const managedRole = await (await fetch(base + "/roles/ops")).text();
    assert.match(managedRole, /_defaults\.json/);
    assert.match(managedRole, /Model \/ runner/);
    assert.match(managedRole, /Role memory pointers/);
    assert.match(managedRole, /Initialize v1 contract/);
    assert.match(managedRole, /href="\/roles" aria-label="Back to roles"/);
    assert.doesNotMatch(managedRole, /Back to Crew/);

    // Contract editing is a normal form too. Existing roles are only migrated when an operator
    // chooses the explicit action, and each save creates a reviewed revision.
    await fetch(base + "/roles/initialize-contract", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "role=ops"
    });
    await fetch(base + "/roles/contract", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ role: "ops", mandate: "Coordinate the operational response.", contract_tools: "knowledge.search | read\nslack.replyToMention | external-write" })
    });
    const contractedOps = JSON.parse(await readFile(path.join(root, ".crew", "roles", "ops.json"), "utf8"));
    assert.equal(contractedOps.contract.version, 1);
    assert.equal(contractedOps.contract.revision, 2);
    assert.equal(contractedOps.contract.mandate, "Coordinate the operational response.");
    assert.deepEqual(contractedOps.contract.authority.tools.map((tool) => tool.name), ["knowledge.search", "slack.replyToMention"]);

    // The normal role form updates only the fields it owns, preserving schedules
    // and other reviewed spec fields instead of making JSON the primary UI.
    await fetch(base + "/roles/update", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        role: "ops",
        title: "Operations Lead",
        runner: "codex-agent-high",
        memory_pointers: "docs/ops.md\nnotes/on-call.md\nnotes/on-call.md"
      })
    });
    const updatedOps = JSON.parse(await readFile(path.join(root, ".crew", "roles", "ops.json"), "utf8"));
    assert.equal(updatedOps.title, "Operations Lead");
    assert.equal(updatedOps.runner, "codex-agent-high");
    assert.deepEqual(updatedOps.memory_pointers, ["docs/ops.md", "notes/on-call.md"]);
    assert.equal(updatedOps.schedules[0].id, "tick", "the form preserves unrelated role settings");

    const schedules = await (await fetch(base + "/schedules")).text();
    assert.match(schedules, /ops:tick/);
    assert.match(schedules, /disabled/);
    assert.match(schedules, /Every Monday at 9:00 AM/);
    assert.match(schedules, /Runs in this host’s local time/);
    assert.match(schedules, /Add a schedule/);
    assert.match(schedules, /Run now/);
    assert.doesNotMatch(schedules, /name="cron"/, "schedule timing is expressed through friendly controls");

    const runNow = await fetch(base + "/schedules/run", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "role=ops&id=tick"
    });
    assert.equal(runNow.status, 303);
    assert.deepEqual(manualRuns, [{ role: "ops", id: "tick" }]);

    // toggle the schedule on → written into the role's spec
    await fetch(base + "/schedules/toggle", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "role=ops&id=tick&enabled=1" });
    const spec = JSON.parse(await readFile(path.join(root, ".crew", "roles", "ops.json"), "utf8"));
    assert.equal(spec.schedules[0].enabled, true);

    // Schedules use a simple cadence and time, then save canonical cron back to the role spec.
    await fetch(base + "/schedules/save", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        role: "ops",
        id: "daily-brief",
        title: "Daily brief",
        recurrence: "weekdays",
        time: "08:30",
        weekday: "1",
        day_of_month: "1",
        interval_days: "2",
        prompt: "Prepare the daily brief.",
        enabled: "1"
      })
    });
    const scheduledOps = JSON.parse(await readFile(path.join(root, ".crew", "roles", "ops.json"), "utf8"));
    assert.ok(scheduledOps.schedules.some((entry) => entry.id === "daily-brief" && entry.enabled && entry.cron === "30 8 * * 1-5"));

    // approve the proposal → flat skill file + index regenerated
    await fetch(base + "/proposals/decide", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${proposal.id}&kind=skill&action=approve` });
    assert.ok(existsSync(path.join(root, ".crew", "skills", "weekly-brief.md")));
    assert.match(await readFile(path.join(root, ".crew", "skills", "_index.md"), "utf8"), /weekly-brief/);

    // The dashboard queue handles proposal-gated role reflections too; approval is the only
    // path from a role's suggestion into its next-turn durable journal.
    const reflection = proposeReflection({ targetRoot: root, role: "ops", text: "Start with the current blocker." });
    const approvals = await (await fetch(base + "/approvals")).text();
    assert.match(approvals, /Start with the current blocker\./);
    await fetch(base + "/proposals/decide", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${reflection.id}&kind=reflection&action=approve` });
    assert.match(await readFile(path.join(root, ".crew", "memory", "reflections", "ops.md"), "utf8"), /Start with the current blocker\./);

    // add a role, then save an edited spec
    const addedRole = await fetch(base + "/roles/add", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "role=analyst&title=Analyst"
    });
    assert.equal(addedRole.status, 303);
    assert.equal(addedRole.headers.get("location"), "/roles/analyst");
    assert.ok(existsSync(path.join(root, ".crew", "roles", "analyst.json")));
    assert.equal(JSON.parse(await readFile(path.join(root, ".crew", "roles", "analyst.json"), "utf8")).contract.version, 1, "new roles start with a versioned contract");
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

test("console accepts an optional host operations snapshot without exposing secrets", async () => {
  const { parent, root } = await project();
  const calls = [];
  const console_ = createConsole({
    targetRoot: root,
    port: 0,
    log: () => {},
    operations: {
      getSnapshot: () => ({
        usage: {
          source: "host-ledger.sqlite",
          current: {
            month: "2026-09",
            totals: { runs: 3, failures: 0, inputTokens: 1200, outputTokens: 340, costUsd: 0.15, estimatedCostUsd: 0, durationSeconds: 21 },
            byRunner: [{ key: "codex-agent-high", runs: 3, failures: 0, inputTokens: 1200, outputTokens: 340, costUsd: 0.15, estimatedCostUsd: 0 }],
            byEngine: [{ key: "codex-agent", runs: 3, failures: 0, costUsd: 0.15, estimatedCostUsd: 0 }]
          }
        },
        providers: [{ id: "host-claude", label: "Claude host check", status: "ready", detail: "subscription available" }],
        connectors: [
          { id: "slack", label: "Team Slack", connected: true, account: "acme", capabilities: ["Post message", "Reply in thread"] },
          { id: "gmail", label: "Work Gmail", state: "not connected", capabilities: ["Send email"] }
        ],
        approvals: [{ id: "approval-42", kind: "external write", title: "Post launch note", requestedBy: "ops", risk: "external-write", status: "pending" }],
        audit: [{
          at: "2026-09-03T13:45:00.000Z",
          actor: "slack-bot",
          role: "ops",
          runner: "codex-agent",
          model: "gpt-5.6",
          action: "tool",
          tool_name: "slack.replyToMention",
          outcome: "completed",
          authorization: {
            decision: "allowed",
            contract_version: 1,
            contract_revision: 2,
            reason: "audit-reason-must-not-render",
            authority: { tool_name: "slack.replyToMention", impact: "external-write" }
          },
          data: { read: ["conversation:incident-42"], write: ["connector:slack:ops"] },
          budget: { max_usd_per_run: 1.5, max_usd_per_month: 40, max_tokens_per_run: 12000, max_runs_per_day: 8 },
          input: { text: "audit-input-must-not-render" },
          output: { access_token: "audit-output-must-not-render" },
          error: "audit-error-must-not-render"
        }]
      }),
      connect: ({ connectorId }) => { calls.push(`connect:${connectorId}`); return { redirect: "/connectors?connected=1" }; },
      disconnect: ({ connectorId }) => { calls.push(`disconnect:${connectorId}`); return { redirect: "/connectors" }; },
      decideApproval: ({ id, action }) => { calls.push(`approval:${id}:${action}`); return { redirect: "/approvals" }; }
    }
  });
  const port = await console_.listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    const usage = await (await fetch(base + "/usage")).text();
    assert.match(usage, /2026-09/);
    assert.match(usage, /\$0\.15/);
    assert.match(usage, /codex-agent-high/);

    const providers = await (await fetch(base + "/providers")).text();
    assert.match(providers, /Claude host check/);
    assert.doesNotMatch(providers, /sk-[A-Za-z0-9]/, "provider cards never contain a secret value");

    const connectors = await (await fetch(base + "/connectors")).text();
    assert.match(connectors, /Team Slack/);
    assert.match(connectors, /Disconnect/);
    assert.match(connectors, /Work Gmail/);
    assert.match(connectors, /<span class="pill">not connected<\/span>/, "a disconnected integration is neutral, not a success state");

    const approvals = await (await fetch(base + "/approvals")).text();
    assert.match(approvals, /Post launch note/);
    assert.match(approvals, /Host action approvals/);

    const audit = await (await fetch(base + "/audit")).text();
    assert.match(audit, /<h1>Audit<\/h1>/);
    assert.match(audit, /slack-bot/);
    assert.match(audit, /ops/);
    assert.match(audit, /gpt-5\.6/);
    assert.match(audit, /slack\.replyToMention/);
    assert.match(audit, /external-write/);
    assert.match(audit, /connector:slack:ops/);
    assert.match(audit, /\$1\.50\/run/);
    assert.match(audit, /completed/);
    assert.doesNotMatch(audit, /audit-(?:input|output|reason|error)-must-not-render/);

    const connect = await fetch(base + "/connectors/connect", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "id=gmail"
    });
    assert.equal(connect.status, 303);
    assert.equal(connect.headers.get("location"), "/connectors?connected=1");

    await fetch(base + "/connectors/disconnect", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "id=slack"
    });
    await fetch(base + "/approvals/decide", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "id=approval-42&action=approve"
    });
    assert.deepEqual(calls, ["connect:gmail", "disconnect:slack", "approval:approval-42:approve"]);
  } finally {
    await console_.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("console can decide its local high-impact action queue without a product host", async () => {
  const { parent, root } = await project();
  const env = { CREW_HOME: path.join(parent, "host-state") };
  const pending = requestActionApproval({
    targetRoot: root,
    role: "ops",
    action: "slack.postMessage",
    connectionId: "slack-main",
    input: { channel: "C1", text: "never render this payload" },
    summary: "Post the approved incident update.",
    env
  });
  const console_ = createConsole({ targetRoot: root, env, port: 0, log: () => {} });
  const port = await console_.listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    const page = await (await fetch(base + "/approvals")).text();
    assert.match(page, /slack\.postMessage/);
    assert.match(page, /Post the approved incident update\./);
    assert.doesNotMatch(page, /never render this payload/);
    const decision = await fetch(base + "/approvals/decide", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id: pending.id, action: "approve" })
    });
    assert.equal(decision.status, 303);
    assert.equal(getActionApproval({ targetRoot: root, approvalId: pending.id, env }).status, "approved");
  } finally {
    await console_.close();
    await rm(parent, { recursive: true, force: true });
  }
});
