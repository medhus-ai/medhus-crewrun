import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createConsole } from "../src/console/server.js";
import { renderPage } from "../src/console/shell.js";
import { proposeReflection } from "../src/reflection-proposals.js";
import { proposeSkill } from "../src/skill-proposals.js";

test("sidebar places Chats and Recent chats after Usage and Settings", () => {
  for (const recentChats of [[], [{ role: "ops" }]]) {
    const sidebar = renderPage("chats", "", { recentChats }).match(/<aside[\s\S]*?<\/aside>/)[0];
    const labels = ['aria-label="Usage"', 'aria-label="Settings"', 'aria-label="Chats"', ...(recentChats.length ? ["Recent chats", 'aria-label="Open chat with ops"'] : [])];
    const positions = labels.map((label) => sidebar.indexOf(label));
    assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
    assert.match(sidebar, /aria-label="Chats" aria-current="page"/);
    if (!recentChats.length) assert.doesNotMatch(sidebar, /Recent chats/);
  }
});

async function project() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-console-"));
  const root = path.join(parent, "repo");
  await mkdir(path.join(root, ".crew", "agents"), { recursive: true });
  await mkdir(path.join(root, ".crew", "skills"), { recursive: true });
  await writeFile(path.join(root, ".crew", "agents", "_defaults.json"), JSON.stringify({
    runner: "claude-agent-sonnet-high",
    memory_pointers: ["docs/shared.md"],
    hooks: ["task.assigned"],
    web: { allow: ["example.com"] }
  }, null, 2), "utf8");
  await writeFile(path.join(root, ".crew", "agents", "ops.json"), JSON.stringify({
    title: "Operations", hooks: [], memory_pointers: ["docs/ops.md"], scheduled: [{ id: "tick", cron: "0 9 * * 1", prompt: "weekly", enabled: false }]
  }, null, 2), "utf8");
  await writeFile(path.join(root, ".crew", "skills", "file-a-task.md"), "---\nname: file-a-task\ndescription: How to file\n---\n# File\n", "utf8");
  return { parent, root };
}

test("console renders pages and performs actions over the project's .crew", async () => {
  const { parent, root } = await project();
  const proposal = proposeSkill({ evidence: "The user requested this weekly procedure.", targetRoot: root, id: "weekly-brief", description: "Draft the brief", content: "steps", proposedBy: "ops" });
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
    assert.match(dashboard, /1 agents/);
    assert.match(dashboard, /1 pending/);
    assert.doesNotMatch(dashboard, /skill\.read/, "tool configuration belongs in Settings");
    assert.match(dashboard, /class="sidebar"/, "console uses the persistent workspace rail");
    assert.match(dashboard, /aria-label="Dashboard"/, "the dashboard link remains named for assistive technology");
    assert.match(dashboard, /class="nav-icon"/, "menu icons are inline and dependency-free");
    assert.match(dashboard, /class="sidebar-resizer"/, "the sidebar has a mouse resize handle");
    assert.match(dashboard, /role="separator" aria-orientation="vertical" aria-label="Resize sidebar"/, "the resize handle is announced correctly");
    assert.match(dashboard, /aria-controls="sidebar"/, "the separator identifies the navigation it resizes");
    assert.match(dashboard, /crewrun\.console\.sidebar-width/, "the chosen sidebar width is kept locally");
    assert.match(dashboard, /padding: 41px 28px 64px/, "page content keeps a gutter from the sidebar edge");
    assert.match(dashboard, /--sidebar: #f3f3f3/, "the reference light shell is rendered with the page");
    assert.match(dashboard, /Crew helper/, "the governed setup helper is available from every console page");
    assert.doesNotMatch(dashboard, /Back to Crew/, "the top rail no longer repeats a back-to-crew control");
    assert.doesNotMatch(dashboard, /Manage agents/, "the dashboard does not duplicate the role directory");
    assert.doesNotMatch(dashboard, /Scheduled work/, "the dashboard does not duplicate the schedules page");
    const sidebar = dashboard.match(/<aside[\s\S]*?<\/aside>/)[0];
    for (const label of ["Reviews", "Scheduled", "Integrations", "Activity", "Settings"]) assert.match(sidebar, new RegExp(`aria-label="${label}"`));
    for (const label of ["Approvals", "Calendar", "Event inbox", "Audit", "Providers"]) assert.doesNotMatch(sidebar, new RegExp(`aria-label="${label}"`));
    for (const retired of ["/roles", "/schedules", "/calendar", "/events", "/audit", "/approvals", "/proposals", "/providers", "/connectors"]) {
      assert.equal((await fetch(base + retired, { redirect: "manual" })).status, 404);
    }

    const roles = await (await fetch(base + "/agents")).text();
    assert.match(roles, /ops — Operations/);
    assert.match(roles, /href="\/agents\/new"/);
    assert.match(roles, /href="\/chats\?agent=ops"/, "each agent card has a direct durable-chat entry point");
    assert.doesNotMatch(roles, /Agent memory pointers/, "the role directory does not embed an editor");
    assert.doesNotMatch(roles, /Initialize v1 contract/, "governance controls live in the role subpage");
    assert.doesNotMatch(roles, /Shared defaults/, "shared defaults live inside a role management page");

    const newRole = await (await fetch(base + "/agents/new")).text();
    assert.match(newRole, /<h1>Add agent<\/h1>/);
    assert.match(newRole, /href="\/agents" aria-label="Back to agents"/);
    assert.doesNotMatch(newRole, /Agent directory/);

    const managedRole = await (await fetch(base + "/agents/ops")).text();
    assert.match(managedRole, /_defaults\.json/);
    assert.match(managedRole, /Model \/ runner/);
    assert.match(managedRole, /Agent memory pointers/);
    assert.match(managedRole, /Initialize v1 contract/);
    assert.match(managedRole, /Shared defaults/);
    assert.match(managedRole, /class="agent-tabs"/);
    assert.match(managedRole, /href="\/agents\/ops\?tab=defaults"/);
    assert.doesNotMatch(managedRole, /Default model \/ runner/, "shared defaults are not nested in the Manage pane");
    assert.doesNotMatch(managedRole, /action="\/agents\/defaults\/update"/);
    assert.doesNotMatch(managedRole, /Advanced shared defaults JSON/);
    assert.match(managedRole, /href="\/agents" aria-label="Back to agents"/);
    assert.doesNotMatch(managedRole, /Back to Crew/);
    assert.match(managedRole, /Activity and learning/);
    assert.match(managedRole, /name="instructions"/);
    assert.match(managedRole, /Allow optional improvement proposals/);
    assert.equal((await fetch(base + "/agents/ops")).status, 200, "legacy bookmarks remain usable");
    const denied = await fetch(base + "/agents/update", { method: "POST", headers: { origin: "https://untrusted.example" }, body: new URLSearchParams({ role: "ops", title: "Unauthorized" }) });
    assert.equal(denied.status, 403);
    const behavior = await fetch(base + "/agents/behavior", { method: "POST", redirect: "manual", body: new URLSearchParams({ role: "ops", heartbeat_mode: "custom", heartbeat: "2h", heartbeat_prompt: "Check progress", reflections: "off", web: "off" }) });
    assert.equal(behavior.status, 303);
    const updated = JSON.parse(await readFile(path.join(root, ".crew/agents/ops.json"), "utf8"));
    assert.equal(updated.reflections, false);
    assert.equal(updated.heartbeat.interval, "2h");
    assert.equal(updated.scheduled.length, 1, "behavior edits preserve scheduled work");

    const defaultsPage = await (await fetch(base + "/agents/ops?tab=defaults")).text();
    assert.match(defaultsPage, /Shared defaults/);
    assert.match(defaultsPage, /Default model \/ runner/);
    assert.match(defaultsPage, /Shared memory pointers/);
    assert.match(defaultsPage, /action="\/agents\/defaults\/update"/);
    assert.match(defaultsPage, /action="\/agents\/defaults\/save"/);
    assert.match(defaultsPage, /Advanced shared defaults JSON/);
    assert.doesNotMatch(defaultsPage, /Agent memory pointers/, "role controls stay in the Manage pane");
    assert.doesNotMatch(defaultsPage, /Initialize v1 contract/);

    // Normal shared-default controls preserve advanced/default-only values while updating the
    // small fields people change most often.
    const defaultsUpdate = await fetch(base + "/agents/defaults/update", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        role: "ops",
        runner: "codex-agent-high",
        memory_pointers: "docs/shared.md\ndocs/handbook.md\ndocs/handbook.md"
      })
    });
    assert.equal(defaultsUpdate.status, 303);
    assert.equal(defaultsUpdate.headers.get("location"), "/agents/ops?tab=defaults");
    const updatedDefaults = JSON.parse(await readFile(path.join(root, ".crew", "agents", "_defaults.json"), "utf8"));
    assert.equal(updatedDefaults.runner, "codex-agent-high");
    assert.deepEqual(updatedDefaults.memory_pointers, ["docs/shared.md", "docs/handbook.md"]);
    assert.deepEqual(updatedDefaults.hooks, ["task.assigned"], "normal shared-default edits preserve advanced fields");
    assert.deepEqual(updatedDefaults.web, { allow: ["example.com"] }, "normal shared-default edits preserve unrelated values");

    const advancedDefaults = {
      ...updatedDefaults,
      reflections: { limit: 12 }
    };
    const defaultsSave = await fetch(base + "/agents/defaults/save", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ role: "ops", json: JSON.stringify(advancedDefaults) })
    });
    assert.equal(defaultsSave.status, 303);
    assert.equal(defaultsSave.headers.get("location"), "/agents/ops?tab=defaults");
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".crew", "agents", "_defaults.json"), "utf8")), advancedDefaults);

    const stableDefaults = await readFile(path.join(root, ".crew", "agents", "_defaults.json"), "utf8");
    const invalidDefaults = await fetch(base + "/agents/defaults/save", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ role: "ops", json: JSON.stringify({ contract: { version: 99 } }) })
    });
    assert.equal(invalidDefaults.status, 400, "an invalid shared contract is rejected before it can affect every role");
    assert.equal(await readFile(path.join(root, ".crew", "agents", "_defaults.json"), "utf8"), stableDefaults);

    // Contract editing is a normal form too. Existing roles are only migrated when an operator
    // chooses the explicit action, and each save creates a reviewed revision.
    await fetch(base + "/agents/initialize-contract", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "role=ops"
    });
    await fetch(base + "/agents/contract", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ role: "ops", mandate: "Coordinate the operational response.", contract_tools: "knowledge.search | read\nslack.replyToMention | external-write" })
    });
    const contractedOps = JSON.parse(await readFile(path.join(root, ".crew", "agents", "ops.json"), "utf8"));
    assert.equal(contractedOps.contract.version, 1);
    assert.equal(contractedOps.contract.revision, 2);
    assert.equal(contractedOps.contract.mandate, "Coordinate the operational response.");
    assert.deepEqual(contractedOps.contract.authority.tools.map((tool) => tool.name), ["knowledge.search", "slack.replyToMention"]);

    // The normal role form updates only the fields it owns, preserving scheduled tasks
    // and other reviewed spec fields instead of making JSON the primary UI.
    await fetch(base + "/agents/update", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        role: "ops",
        title: "Operations Lead",
        runner: "codex-agent-high",
        memory_pointers: "docs/ops.md\nnotes/on-call.md\nnotes/on-call.md"
      })
    });
    const updatedOps = JSON.parse(await readFile(path.join(root, ".crew", "agents", "ops.json"), "utf8"));
    assert.equal(updatedOps.title, "Operations Lead");
    assert.equal(updatedOps.runner, "codex-agent-high");
    assert.deepEqual(updatedOps.memory_pointers, ["docs/ops.md", "notes/on-call.md"]);
    assert.equal(updatedOps.scheduled[0].id, "tick", "the form preserves unrelated role settings");

    const stableRole = await readFile(path.join(root, ".crew", "agents", "ops.json"), "utf8");
    const invalidTaskKeys = await fetch(base + "/agents/save", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ role: "ops", json: JSON.stringify({ scheduled: [], schedules: [] }) })
    });
    assert.equal(invalidTaskKeys.status, 400, "advanced JSON cannot define both task keys");
    assert.equal(await readFile(path.join(root, ".crew", "agents", "ops.json"), "utf8"), stableRole);

    const scheduled = await (await fetch(base + "/scheduled?tab=list")).text();
    assert.match(scheduled, /aria-label="Scheduled"/);
    assert.match(scheduled, /<h1>Scheduled tasks<\/h1>/);
    assert.match(scheduled, /ops:tick/);
    assert.match(scheduled, /role="switch" aria-checked="false"/);
    assert.match(scheduled, /Every Monday at 9:00 AM/);
    assert.match(scheduled, /New task/);
    assert.match(scheduled, /Run now/);
    assert.doesNotMatch(scheduled, /Delete task|Disable task|Enable task/);
    assert.doesNotMatch(scheduled, /Task ID/, "the task editor opens only when needed");

    const calendar = await (await fetch(base + "/scheduled")).text();
    assert.match(calendar, /<h1>Scheduled tasks<\/h1>/);
    assert.match(calendar, /aria-current="page" href="\/scheduled\?tab=calendar"/);
    assert.match(calendar, /href="\/scheduled"/);
    const defaultScheduled = await (await fetch(base + "/scheduled")).text();
    assert.match(defaultScheduled, /aria-current="page" href="\/scheduled\?tab=calendar"/);
    assert.match(defaultScheduled, /<option value="3" selected>/);

    const chats = await (await fetch(base + "/chats?agent=ops")).text();
    assert.match(chats, /one resumed thread/);
    assert.doesNotMatch(chats, /action="\/chats\/send"/);
    const helper = await (await fetch(base + "/?helper=1")).text();
    assert.match(helper, /class="helper-drawer open"/);
    assert.match(helper, /read-only internal tool/);

    const newTask = await (await fetch(base + "/scheduled?new=1")).text();
    assert.match(newTask, /Runs in your computer’s local time/);
    assert.match(newTask, /Task ID/);
    assert.match(newTask, /action="\/scheduled\/save"/);
    assert.doesNotMatch(newTask, /name="cron"/, "task timing is expressed through friendly controls");

    const newSkill = await (await fetch(base + "/skills?new=1")).text();
    assert.match(newSkill, /<h2>Propose a skill<\/h2>/);
    assert.match(newSkill, /action="\/skills\/propose"/);
    const proposedSkill = await fetch(base + "/skills/propose", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        skill_id: "incident-summary",
        description: "Prepare a concise incident summary",
        content: "1. Gather verified facts.\n2. Identify open decisions.",
        roles: "ops",
        scope: "repository",
        evidence: "The incident review uses this same workflow every time."
      })
    });
    assert.equal(proposedSkill.status, 303);
    assert.equal(proposedSkill.headers.get("location"), "/reviews?tab=learning");
    assert.match(await (await fetch(base + "/reviews?tab=learning")).text(), /incident-summary/);

    const legacyScheduled = await (await fetch(base + "/scheduled")).text();
    assert.match(legacyScheduled, /Scheduled tasks/, "old schedule URLs remain usable");

    const runNow = await fetch(base + "/scheduled/run", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "role=ops&id=tick"
    });
    assert.equal(runNow.status, 303);
    assert.deepEqual(manualRuns, [{ role: "ops", id: "tick" }]);

    // Toggle the task on → written into the role's spec.
    await fetch(base + "/scheduled/toggle", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "role=ops&id=tick&enabled=1" });
    const spec = JSON.parse(await readFile(path.join(root, ".crew", "agents", "ops.json"), "utf8"));
    assert.equal(spec.scheduled[0].enabled, true);

    // Tasks use a simple cadence and time, then save canonical cron back to the role spec.
    await fetch(base + "/scheduled/save", {
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
    const scheduledOps = JSON.parse(await readFile(path.join(root, ".crew", "agents", "ops.json"), "utf8"));
    assert.ok(scheduledOps.scheduled.some((entry) => entry.id === "daily-brief" && entry.enabled && entry.cron === "30 8 * * 1-5"));

    // approve the proposal → flat skill file + index regenerated
    await fetch(base + "/reviews/learning/decide", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${proposal.id}&kind=skill&action=approve` });
    assert.ok(existsSync(path.join(root, ".crew", "skills", "weekly-brief.md")));
    assert.match(await readFile(path.join(root, ".crew", "skills", "_index.md"), "utf8"), /weekly-brief/);

    // The dashboard queue handles proposal-gated role reflections too; approval is the only
    // path from a role's suggestion into its next-turn durable journal.
    const reflection = proposeReflection({ target: "preference", key: "weekly-blocker", evidence: "The user wants their blocker first.", targetRoot: root, role: "ops", text: "Start with the current blocker." });
    const approvals = await (await fetch(base + "/reviews?tab=learning")).text();
    assert.match(approvals, /Start with the current blocker\./);
    await fetch(base + "/reviews/learning/decide", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${reflection.id}&kind=reflection&action=approve` });
    assert.match(await readFile(path.join(root, ".crew", "memory", "preferences.json"), "utf8"), /Start with the current blocker\./);

    // add a role, then save an edited spec
    const addedRole = await fetch(base + "/agents/add", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "role=analyst&title=Analyst"
    });
    assert.equal(addedRole.status, 303);
    assert.equal(addedRole.headers.get("location"), "/agents/analyst");
    assert.ok(existsSync(path.join(root, ".crew", "agents", "analyst.json")));
    assert.equal(JSON.parse(await readFile(path.join(root, ".crew", "agents", "analyst.json"), "utf8")).contract.version, 1, "new roles start with a versioned contract");
    await fetch(base + "/agents/save", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "role=analyst&json=" + encodeURIComponent(JSON.stringify({ title: "Analyst", heartbeat: "1d" })) });
    const analyst = JSON.parse(await readFile(path.join(root, ".crew", "agents", "analyst.json"), "utf8"));
    assert.equal(analyst.heartbeat, "1d");

    const bad = await fetch(base + "/agents/save", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "role=..%2Fevil&json={}" });
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
        chats: [{ id: 4, role: "ops", title: "Incident handoff", updatedAt: "2026-09-03T14:00:00.000Z", purpose: "console-chat" }],
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
      connect: ({ connectorId }) => { calls.push(`connect:${connectorId}`); return { redirect: "/integrations?connected=1" }; },
      disconnect: ({ connectorId }) => { calls.push(`disconnect:${connectorId}`); return { redirect: "/integrations" }; },
      decideApproval: ({ id, action }) => { calls.push(`approval:${id}:${action}`); return { redirect: "/reviews?tab=actions" }; },
      getChat: ({ role }) => ({ role, title: "Incident handoff", messages: [{ author: "user", content: "What changed?" }, { author: role, content: "I am checking." }] }),
      sendChat: ({ role, message }) => { calls.push(`chat:${role}:${message}`); return { role, messages: [] }; },
      syncCalendarTask: ({ task, previousTask }) => { calls.push(`calendar:${task?.id || "deleted"}:${previousTask?.id || "none"}`); }
    }
  });
  const port = await console_.listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    const usage = await (await fetch(base + "/usage")).text();
    assert.match(usage, /2026-09/);
    assert.match(usage, /\$0\.15/);
    assert.match(usage, /codex-agent-high/);

    const providers = await (await fetch(base + "/settings?tab=providers")).text();
    assert.match(providers, /Claude host check/);
    assert.doesNotMatch(providers, /\bsk-[A-Za-z0-9]/, "provider cards never contain a secret value");

    const connectors = await (await fetch(base + "/integrations")).text();
    assert.match(connectors, /Team Slack/);
    assert.match(connectors, /Disconnect/);
    assert.match(connectors, /Work Gmail/);
    assert.match(connectors, /<span class="pill">not connected<\/span>/, "a disconnected integration is neutral, not a success state");
    assert.doesNotMatch(connectors, /Google Calendar/);
    assert.doesNotMatch(connectors, /Microsoft 365/);
    assert.doesNotMatch(connectors, /WhatsApp Business/);

    const calendar = await (await fetch(base + "/scheduled")).text();
    assert.doesNotMatch(calendar, /Calendar mirroring/, "mirroring configuration belongs under Integrations");
    const chats = await (await fetch(base + "/chats?agent=ops")).text();
    assert.match(chats, /Incident handoff/);
    assert.match(chats, /Recent chats/);
    const sentChat = await fetch(base + "/chats/send", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ role: "ops", message: "Please summarize", return_to: "/chats?agent=ops" })
    });
    assert.equal(sentChat.status, 303);
    assert.equal(sentChat.headers.get("location"), "/chats?agent=ops");

    const calendarToggle = await fetch(base + "/scheduled/toggle", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "role=ops&id=tick&enabled=1"
    });
    assert.equal(calendarToggle.status, 303);

    const approvals = await (await fetch(base + "/reviews?tab=actions")).text();
    assert.match(approvals, /Post launch note/);
    assert.match(approvals, /Actions requiring review/);

    const audit = await (await fetch(base + "/activity?tab=actions")).text();
    assert.match(audit, /<h1>Activity<\/h1>/);
    assert.match(audit, /slack-bot/);
    assert.match(audit, /ops/);
    assert.match(audit, /gpt-5\.6/);
    assert.match(audit, /slack\.replyToMention/);
    assert.match(audit, /external-write/);
    assert.match(audit, /connector:slack:ops/);
    assert.match(audit, /\$1\.50\/run/);
    assert.match(audit, /completed/);
    assert.doesNotMatch(audit, /audit-(?:input|output|reason|error)-must-not-render/);
    const filteredActivity = await (await fetch(base + "/activity?q=no-matching-record")).text();
    assert.doesNotMatch(filteredActivity, /slack\.replyToMention/);
    const eventActivity = await (await fetch(base + "/activity?tab=events")).text();
    assert.doesNotMatch(eventActivity, /action="\/events\/route"|action="\/approvals\/decide"/);

    const connect = await fetch(base + "/integrations/connect", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "id=gmail"
    });
    assert.equal(connect.status, 303);
    assert.equal(connect.headers.get("location"), "/integrations?connected=1");

    await fetch(base + "/integrations/disconnect", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "id=slack"
    });
    await fetch(base + "/reviews/decide", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "id=approval-42&action=approve"
    });
    assert.deepEqual(calls, ["chat:ops:Please summarize", "calendar:tick:tick", "connect:gmail", "disconnect:slack", "approval:approval-42:approve"]);
  } finally {
    await console_.close();
    await rm(parent, { recursive: true, force: true });
  }
});
