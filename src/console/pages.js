import { readFileSync } from "node:fs";
import path from "node:path";

import { agentFile } from "../agent-paths.js";
import { listRoleSpecs, readRoleDefaults, readAgentSpecForEditing } from "../agent-spec.js";
import { loadRoleSettings, validateRoleSettings, readHeartbeatState } from "../pulse.js";
import { describeScheduleRecurrence, recurrenceFromCron, SCHEDULE_WEEKDAYS, scheduleOverview } from "../schedules.js";
import { listSkills } from "../skills.js";
import { listSkillProposals } from "../skill-proposals.js";
import { listPreferenceProposals, listPreferences } from "../preference-memory.js";
import { listReflectionProposals } from "../reflection-proposals.js";
import { runnerIdForRole } from "../runner.js";
import { agentRunnerProfiles, detectRunnerTools, runnerProfileLabel } from "../runner-config.js";
import { knownSecretStatus, isUnlocked, secretsFileExists } from "../secret-store.js";
import { loadModelCatalog } from "../model-catalog.js";
import { LEARNING_TOOL_NAMES, WEB_TOOL_NAMES } from "../crew-tools.js";
import { esc } from "./shell.js";

const DEFAULT_CONNECTORS = [
  {
    id: "slack",
    label: "Slack",
    initials: "S",
    description: "Let your agents prepare Slack updates. Review the exact message before it is sent.",
    capabilities: ["Post message", "Reply to mention"],
    state: "not connected"
  },
  {
    id: "gmail",
    label: "Gmail",
    initials: "G",
    description: "Review and send existing Gmail drafts. Enable inbox access only when you need it.",
    capabilities: ["Send existing draft"],
    state: "not connected"
  }
];

// `operations` is an optional host snapshot. Keeping it data-only makes this
// little console useful on its own and lets a product host add connectors,
// approvals, and ledger data without coupling those products to crewrun.
export function collectModels(targetRoot, { knownEvents = [], operations = {} } = {}) {
  const specs = listRoleSpecs(targetRoot);
  const settings = loadRoleSettings(targetRoot);
  const runnerOptions = safeRunnerOptions();
  const normalizedOperations = normalizeOperations(operations);
  return {
    targetRoot,
    specs,
    defaults: readRoleDefaults(targetRoot),
    settings,
    validation: validateRoleSettings(settings, { knownEvents }),
    schedules: scheduleOverview({ targetRoot }),
    heartbeatState: readHeartbeatState(targetRoot),
    skills: listSkills({ targetRoot }),
    skillProposals: listSkillProposals({ targetRoot }),
    prefProposals: listPreferenceProposals({ targetRoot }),
    reflectionProposals: listReflectionProposals({ targetRoot }),
    preferences: listPreferences({ targetRoot }).effective,
    runnerOptions,
    providerRuntime: safeRuntimeStatus(),
    catalog: safeCatalog(),
    operations: normalizedOperations,
    runnerFor: (role) => runnerIdForRole(role, targetRoot)
  };
}

export function renderPartial(page, models, options = {}) {
  switch (page) {
    case "roles":
    case "agents": return renderRoles(models, options);
    case "scheduled": return renderScheduledTasks(models, options);
    case "skills": return renderSkills(models);
    case "approvals":
    case "proposals": return renderApprovals(models, options);
    case "audit": return renderAudit(models);
    case "usage": return renderUsage(models);
    case "providers": return renderProviders(models);
    case "connectors": return renderConnectors(models, options);
    default: return renderDashboard(models);
  }
}

function renderDashboard(models) {
  const { problems, warnings } = models.validation;
  const roles = Object.values(models.specs);
  const enabledTasks = models.schedules.filter((task) => task.enabled).length;
  const pending = models.skillProposals.length + models.prefProposals.length + models.reflectionProposals.length + models.operations.approvals.filter((entry) => entry.status === "pending").length;
  const usage = currentUsage(models.operations.usage);
  const spend = usage ? spendFor(usage.totals) : null;
  const connected = models.operations.connectors.filter((connector) => connector.connected).length;
  const health = problems.length ? "needs review" : warnings.length ? "warnings" : "healthy";
  return `
<section class="hero">
  <div>
    <p class="eyebrow">CrewRun</p>
    <h1>Dashboard</h1>
    <p class="sub">Run and govern your agents from one local control plane.</p>
  </div>
  <div class="actions">
    <a class="button secondary" href="/agents/new">Add agent</a>
    <a class="button" href="/approvals">Review approvals${pending ? ` (${pending})` : ""}</a>
  </div>
</section>
<section class="summary-grid" aria-label="Crew summary">
  ${metric("Agents", roles.length, `${roles.length} agents`, "reviewable contracts")}
  ${metric("Scheduled tasks", enabledTasks, `${enabledTasks} task${enabledTasks === 1 ? "" : "s"} enabled`, `${models.schedules.length} total`) }
  ${metric("Approvals", pending, `${pending} proposal${pending === 1 ? "" : "s"} pending`, pending ? "operator attention needed" : "queue clear", pending ? "warn" : "success")}
  ${metric("This month", spend === null ? "—" : formatCurrency(spend), "usage and subscription estimate", usage ? `${usage.totals?.runs || 0} recorded runs` : "no ledger attached", usage ? "info" : "")}
</section>
<section>
    <div class="section-heading"><h2>Governance</h2><a class="button secondary tiny" href="/approvals">Open queue</a></div>
    <div class="card flat">
      <div class="list">
        ${listRow("Agent configuration", health, problems.length ? "danger" : warnings.length ? "warn" : "success")}
        ${listRow("Approved preferences", `${models.preferences.length} active`, "info")}
        ${listRow("Connector connections", `${connected} connected`, connected ? "success" : "")}
        ${listRow("Audited actions", `${models.operations.audit.length} safe record${models.operations.audit.length === 1 ? "" : "s"}`, models.operations.audit.length ? "info" : "")}
        ${listRow("Skills", `${models.skills.length} installed`, "")}
      </div>
    </div>
</section>
${problems.length || warnings.length ? `<section><div class="section-heading"><h2>Configuration review</h2></div>${[...problems.map((entry) => notice(entry, "warn")), ...warnings.map((entry) => notice(entry, "warn"))].join("")}</section>` : ""}
<section>
  <div class="section-heading"><h2>Built-in agent tools</h2></div>
  <div class="notice">Ordinary bridges include the governed-learning tools ${LEARNING_TOOL_NAMES.map((name) => `<code>${esc(name)}</code>`).join(" · ")}; a strict agent contract must list each one it may use. An agent receives ${WEB_TOOL_NAMES.map((name) => `<code>${esc(name)}</code>`).join(" · ")} only when its reviewed spec enables web access. Tools follow the permissions you grant each agent.</div>
</section>`;
}

function renderRoles(models, { selectedRole = "", roleView = "list", roleTab = "manage", agentSearch = "" } = {}) {
  const all = Object.values(models.specs);
  const roles = all.filter((spec) => `${spec.role} ${spec.title} ${spec.contract?.mandate || ""}`.toLowerCase().includes(agentSearch.toLowerCase()));
  const selected = roles.find((spec) => spec.role === selectedRole) || null;
  const detail = roleView === "detail";
  const title = roleView === "create" ? "Add agent" : detail ? "Manage agent" : "Agents";
  const subtitle = roleView === "create"
    ? "Create a focused, versioned agent specification."
    : detail && roleTab === "defaults"
      ? "Edit the global baseline shared by every agent."
      : detail
        ? "Edit this agent’s operating surface and reviewed authority."
        : "Give each agent a clear job, the right tools, and a rhythm for getting work done.";
  return `
<section class="hero">
  <div><p class="eyebrow">Agents</p><h1>${title}</h1><p class="sub">${subtitle}</p>${detail && selected ? renderRoleTabs(selected, roleTab) : ""}</div>
  ${roleView === "list" ? `<a class="button" href="/agents/new">Add agent</a>` : ""}
</section>
${roleView === "list" ? `
<form method="get" action="/agents" class="button-row"><label class="muted" for="agent-search">Find an agent</label><input style="max-width:320px" id="agent-search" name="q" type="search" value="${esc(agentSearch)}" placeholder="Search by name or responsibility"><button class="subtle">Search</button>${agentSearch ? '<a href="/agents">Clear</a>' : ""}</form>
<section class="section-heading"><h2>Agent directory</h2><span class="muted">${roles.length} installed</span></section>
${roles.length ? `<div class="agent-grid">${roles.map((spec) => renderRoleCard(spec, models)).join("")}</div>` : empty(all.length ? "No agents match your search." : "Start with one useful job: a daily brief, a weekly review, or an operations check.", all.length ? "Clear search" : "Create your first agent", all.length ? "/agents" : "/agents/new")}
` : ""}
${roleView === "create" ? `
<section id="create-role" class="card" style="margin-top:16px">
  <div class="section-heading" style="margin-top:0"><h2>Create an agent</h2><span class="muted">You can add tools and recurring tasks next</span></div>
  <form method="post" action="/agents/add">
    <div class="form-grid three">
      <div class="field"><label for="new-role">Agent slug</label><input id="new-role" name="role" placeholder="analyst" pattern="[a-z][a-z0-9-]*" required><span class="help">lowercase letters, digits, hyphens</span></div>
      <div class="field"><label for="new-title">Title</label><input id="new-title" name="title" placeholder="Analyst"></div>
      <div class="field"><label for="new-runner">Model / runner</label>${runnerSelect(models, "", "new-runner")}</div>
      <div class="field wide"><label for="new-instructions">What should this agent do?</label><textarea id="new-instructions" name="instructions" maxlength="20000" placeholder="Prepare a concise daily operations brief. Include evidence, open issues, and the next actions. Ask for approval before sending updates."></textarea><span class="help">Describe the result you want, what good work looks like, and any boundaries.</span></div>
    </div>
    <div class="button-row" style="margin-top:13px"><button>Create agent</button></div>
  </form>
</section>
` : ""}
${detail && selected ? roleTab === "defaults" ? renderDefaultsEditor(selected, models) : renderRoleEditor(selected, models) : detail ? empty("This agent was not found.", "Back to agents", "/agents") : ""}`;
}

function renderRoleTabs(spec, active) {
  const manage = `/agents/${encodeURIComponent(spec.role)}`;
  const defaults = `${manage}?tab=defaults`;
  return `<nav class="agent-tabs" aria-label="Agent settings">
    <a class="agent-tab${active === "manage" ? " active" : ""}" href="${manage}"${active === "manage" ? ' aria-current="page"' : ""}>Manage</a>
    <a class="agent-tab${active === "defaults" ? " active" : ""}" href="${defaults}"${active === "defaults" ? ' aria-current="page"' : ""}>Shared defaults</a>
  </nav>`;
}

function renderRoleCard(spec, models) {
  const settings = models.settings[spec.role];
  const runnerId = models.runnerFor(spec.role);
  const runner = runnerLabel(models, runnerId);
  const heartbeat = settings?.heartbeat
    ? `every ${formatDuration(settings.heartbeat.intervalSeconds)}${settings.heartbeat.budgetUsdPerDay != null ? ` · $${settings.heartbeat.budgetUsdPerDay}/day` : ""}`
    : "off";
  const contract = contractFor(models, spec);
  const title = spec.title || "Untitled agent";
  return `
<article class="agent-card">
  <div class="card-head">
    <div><div class="agent-name" aria-label="${esc(`${spec.role} — ${title}`)}">${esc(spec.role)}</div><div class="agent-title">${esc(title)}</div></div>
    ${contract?.status ? pill(contract.status, toneFor(contract.status)) : pill("agent", "info")}
  </div>
  <div class="agent-meta">
    <div>Model <code>${esc(runner)}</code></div>
    <div>Memory ${spec.memory_pointers.length ? `${spec.memory_pointers.length} pointer${spec.memory_pointers.length === 1 ? "" : "s"}` : "none"} · ${spec.schedules.length} scheduled task${spec.schedules.length === 1 ? "" : "s"}</div>
    <div>Heartbeat <span class="pill ${settings?.heartbeat ? "on" : ""}">${esc(heartbeat)}</span></div>
    ${spec.contract?.mandate || spec.instructions ? `<p class="agent-mandate">${esc((spec.contract?.mandate || spec.instructions).slice(0, 220))}</p>` : ""}
    <div>Learning ${spec.reflections === false ? "off" : "reviewed reflections"}</div>
    <div>Last check-in ${models.heartbeatState.roles?.[spec.role]?.lastRunAt ? when(models.heartbeatState.roles[spec.role].lastRunAt) : "Not run yet"}</div>
  </div>
  <div class="card-footer"><span class="faint">${spec.web ? "Web enabled" : "Web off"} · ${spec.contract?.authority?.tools?.length || 0} tool${spec.contract?.authority?.tools?.length === 1 ? "" : "s"}</span><a class="button secondary tiny" href="/agents/${encodeURIComponent(spec.role)}">Manage agent</a></div>
</article>`;
}

function renderRoleEditor(spec, models) {
  const own = readAgentSpecForEditing(models.targetRoot, spec.role);
  const raw = roleJson(models.targetRoot, spec, own);
  const ownPointers = Array.isArray(own.memory_pointers) ? own.memory_pointers.map(String) : [];
  return `
<section id="agent-detail" class="card" style="margin-top:16px">
  <div class="section-heading" style="margin-top:0"><div><h2>${esc(spec.role)} — ${esc(spec.title || "Untitled agent")}</h2><span class="muted">Agent contract basics</span></div><a class="button secondary tiny" href="/scheduled?role=${encodeURIComponent(spec.role)}">Manage tasks</a></div>
  <form method="post" action="/agents/update">
    <input type="hidden" name="role" value="${esc(spec.role)}">
    <div class="form-grid">
      <div class="field"><label for="agent-title">Title</label><input id="agent-title" name="title" value="${esc(own.title ?? spec.title)}" placeholder="Operations lead"></div>
      <div class="field"><label for="agent-runner">Model / runner</label>${runnerSelect(models, own.runner ?? "", "agent-runner")}<span class="help">Leave inherited to use <code>_defaults.json</code> or the project default.</span></div>
      <div class="field wide"><label for="agent-instructions">Instructions</label><textarea id="agent-instructions" name="instructions" maxlength="20000" placeholder="Describe this agent’s job and the result you expect.">${esc(own.instructions || "")}</textarea><span class="help">Included in every turn, alongside your reference files.</span></div>
      <div class="field wide"><label for="agent-memory">Agent memory pointers</label><textarea id="agent-memory" name="memory_pointers" placeholder=".crew/agents/${esc(spec.role)}.md&#10;docs/domain-notes.md">${esc(ownPointers.join("\n"))}</textarea><span class="help">One repository-relative file per line. Shared pointers in <code>_defaults.json</code> remain inherited.</span></div>
    </div>
    <div class="button-row" style="margin-top:13px"><button>Save agent</button><a class="button secondary" href="/agents/${encodeURIComponent(spec.role)}">Discard changes</a></div>
  </form>
  ${renderAgentBehavior(spec, own)}
  ${renderContractSummary(spec)}
  ${renderContractEditor(spec, own)}
  <details>
    <summary>Advanced agent JSON editor</summary>
    <p class="help" style="margin:8px 0">Use this only for reviewed fields not represented above. Saving preserves exactly this JSON object.</p>
    <form method="post" action="/agents/save">
      <input type="hidden" name="role" value="${esc(spec.role)}">
      <textarea class="code-input" name="json">${esc(raw)}</textarea>
      <div class="button-row" style="margin-top:10px"><button class="subtle">Save advanced JSON</button></div>
    </form>
  </details>
</section>`;
}

function renderAgentBehavior(spec, own) {
  const options = (values, selected) => values.map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`).join("");
  return `<section class="card flat" style="margin-top:16px">
    <div class="section-heading" style="margin-top:0"><h3>Activity and learning</h3></div>
    <form method="post" action="/agents/behavior">
      <input type="hidden" name="role" value="${esc(spec.role)}">
      <div class="form-grid">
        <div class="field"><label for="heartbeat-mode">Automatic check-ins</label><select id="heartbeat-mode" name="heartbeat_mode">${options([["inherit", "Use shared defaults"], ["custom", "Set for this agent"]], own.heartbeat === undefined ? "inherit" : "custom")}</select></div>
        <div class="field"><label for="heartbeat">Check-in interval</label><input id="heartbeat" name="heartbeat" value="${esc(spec.heartbeat?.interval || "off")}" placeholder="30m, 2h, or off"><span class="help">Runs while crewrun up is active. Use Scheduled for exact times.</span></div>
        <div class="field wide"><label for="heartbeat-prompt">Check-in instructions</label><textarea id="heartbeat-prompt" name="heartbeat_prompt">${esc(spec.heartbeat?.prompt || "")}</textarea></div>
        <div class="field"><label for="agent-web">Web access</label><select id="agent-web" name="web">${options([["inherit", "Use shared defaults"], ["off", "Off"], ["on", "Enabled"]], own.web === undefined ? "inherit" : own.web === false ? "off" : "on")}</select></div>
        <div class="field"><label for="web-allow">Allowed websites</label><textarea id="web-allow" name="web_allow" placeholder="docs.example.com">${esc((spec.web?.allow || []).join("\n"))}</textarea><span class="help">One domain per line. Empty means open web access when enabled.</span></div>
        <div class="field"><label for="agent-reflections">Reflections</label><select id="agent-reflections" name="reflections">${options([["inherit", "Use shared defaults"], ["on", "Learn from approved reflections"], ["off", "Off"]], own.reflections === undefined ? "inherit" : own.reflections === false ? "off" : "on")}</select><span class="help">Optional lessons from completed work. You review them in Approvals before future turns use them.</span></div>
        <div class="field"><label for="reflection-limit">Recent lessons to include</label><input id="reflection-limit" name="reflection_limit" type="number" min="1" max="100" value="${spec.reflections?.limit || 10}"></div>
      </div>
      <div class="button-row" style="margin-top:12px"><button class="subtle">Save activity and learning</button></div>
    </form>
  </section>`;
}

function renderContractEditor(spec, own) {
  const contract = own.contract && typeof own.contract === "object" ? own.contract : null;
  if (!contract) {
    return `<section class="notice warn" style="margin-top:12px">
      <div class="card-head"><div><h3>Start a governed contract</h3><p class="help" style="margin-top:3px">This is a deliberate migration step; it does not silently rewrite a legacy agent.</p></div>
      <form class="inline" method="post" action="/agents/initialize-contract"><input type="hidden" name="role" value="${esc(spec.role)}"><button class="tiny">Initialize v1 contract</button></form></div>
    </section>`;
  }
  const tools = Array.isArray(contract.authority?.tools) ? contract.authority.tools : [];
  const toolLines = tools.map((tool) => `${tool.name || tool} | ${tool.impact || "external-write"}`).join("\n");
  return `<section class="card flat" style="margin-top:12px">
    <div class="section-heading" style="margin-top:0"><div><h3>Contract controls</h3><span class="muted">v${esc(contract.version || 1)} · saving creates revision ${esc(Number(contract.revision || 1) + 1)}</span></div></div>
    <form method="post" action="/agents/contract">
      <input type="hidden" name="role" value="${esc(spec.role)}">
      <div class="form-grid">
        <div class="field wide"><label for="contract-mandate">Mandate</label><textarea id="contract-mandate" name="mandate" maxlength="1000" placeholder="What this agent is accountable for.">${esc(contract.mandate || "")}</textarea></div>
        <div class="field wide"><label for="contract-tools">Authorized tools</label><textarea id="contract-tools" name="contract_tools" placeholder="slack.replyToMention | external-write&#10;knowledge.search | read">${esc(toolLines)}</textarea><span class="help">One tool per line: <code>tool.name | read</code>, <code>internal-write</code>, <code>external-write</code>, <code>destructive</code>, or <code>financial</code>. Grant data access below for connected services. Handoffs, approval floors, and budgets stay in advanced JSON.</span></div>
        <div class="field"><label for="contract-read">Data this agent may read</label><textarea id="contract-read" name="data_read" placeholder="connector:gmail:gmail">${esc((contract.authority?.data?.read || []).join("\n"))}</textarea></div>
        <div class="field"><label for="contract-write">Data this agent may change</label><textarea id="contract-write" name="data_write" placeholder="connector:slack:slack&#10;connector:gmail:gmail">${esc((contract.authority?.data?.write || []).join("\n"))}</textarea><span class="help">For standalone Slack use connector:slack:slack. For Gmail use connector:gmail:gmail. Outgoing messages still require approval.</span></div>
      </div>
      <div class="button-row" style="margin-top:12px"><button class="subtle">Save contract revision</button></div>
    </form>
  </section>`;
}

function renderContractSummary(spec) {
  const summary = spec.contractSummary;
  if (!summary || typeof summary !== "object") return "";
  const authority = summary.authority || {};
  const tools = Array.isArray(authority.tools) ? authority.tools : [];
  const handoffs = authority.handoffs || {};
  const approvals = summary.approvals?.required_for || [];
  const budget = summary.budget || {};
  const budgetParts = [
    budget.max_usd_per_run != null ? `$${budget.max_usd_per_run}/run` : "",
    budget.max_usd_per_month != null ? `$${budget.max_usd_per_month}/month` : "",
    budget.max_tokens_per_run != null ? `${formatInt(budget.max_tokens_per_run)} tokens/run` : "",
    budget.max_runs_per_day != null ? `${formatInt(budget.max_runs_per_day)} runs/day` : ""
  ].filter(Boolean);
  const detail = summary.status === "legacy"
    ? "This agent has no governed contract yet. Initialize a reviewed v1 contract before requiring contract enforcement."
    : `${summary.mandate || "No mandate recorded."} ${tools.length ? `${tools.length} authorized tool${tools.length === 1 ? "" : "s"}.` : "No tools are authorized."}`;
  return `<section class="notice${summary.status === "governed" ? "" : " warn"}" style="margin-top:16px">
    <div class="card-head"><div><h3>Authority contract</h3><p class="help" style="margin-top:3px">${esc(detail)}</p></div>${pill(summary.status || "legacy", toneFor(summary.status))}</div>
    ${summary.version ? `<p class="help" style="margin-top:8px">v${esc(summary.version)} · revision ${esc(summary.revision)}${summary.fingerprint ? ` · ${esc(String(summary.fingerprint).slice(0, 12))}` : ""}</p>` : ""}
    ${tools.length ? `<p class="help" style="margin-top:8px">Tools: ${tools.map((tool) => `<code>${esc(tool.name || tool)}</code>`).join(" · ")}</p>` : ""}
    ${approvals.length ? `<p class="help" style="margin-top:5px">Approval required: ${approvals.map((impact) => `<code>${esc(impact)}</code>`).join(" · ")}</p>` : ""}
    ${handoffs.send?.length || handoffs.receive?.length ? `<p class="help" style="margin-top:5px">Handoffs: send ${esc((handoffs.send || []).join(", ") || "none")} · receive ${esc((handoffs.receive || []).join(", ") || "none")}</p>` : ""}
    ${budgetParts.length ? `<p class="help" style="margin-top:5px">Budget: ${esc(budgetParts.join(" · "))}</p>` : ""}
  </section>`;
}

function renderDefaultsEditor(spec, models) {
  const defaults = models.defaults || {};
  const pointers = Array.isArray(defaults.memory_pointers) ? defaults.memory_pointers.map(String) : [];
  const raw = defaultsJson(models.targetRoot, defaults);
  const tabUrl = `/agents/${encodeURIComponent(spec.role)}?tab=defaults`;
  return `
<section id="shared-defaults" class="card">
  <div class="section-heading" style="margin-top:0"><div><h3>Shared defaults</h3><span class="muted">Global baseline for every agent; agent-specific settings may override or extend it.</span></div></div>
  <form method="post" action="/agents/defaults/update">
    <input type="hidden" name="role" value="${esc(spec.role)}">
    <div class="form-grid">
      <div class="field"><label for="defaults-runner">Default model / runner</label>${runnerSelect(models, String(defaults.runner || ""), "defaults-runner", "No shared model")}<span class="help">Agents without their own runner use this model.</span></div>
      <div class="field wide"><label for="defaults-memory">Shared memory pointers</label><textarea id="defaults-memory" name="memory_pointers" placeholder=".crew/memory/doctrine.md&#10;.crew/memory/org-map.md">${esc(pointers.join("\n"))}</textarea><span class="help">One repository-relative file per line. These load before each agent’s own memory pointers.</span></div>
    </div>
    <div class="button-row" style="margin-top:13px"><button class="subtle">Save shared defaults</button><a class="button secondary" href="${tabUrl}">Discard changes</a></div>
  </form>
  <details>
    <summary>Advanced shared defaults JSON</summary>
    <p class="help" style="margin:8px 0">Use this for reviewed shared settings not represented above, including heartbeat, hooks, web access, reflections, the contract floor, and host fields.</p>
    <form method="post" action="/agents/defaults/save">
      <input type="hidden" name="role" value="${esc(spec.role)}">
      <textarea class="code-input" name="json">${esc(raw)}</textarea>
      <div class="button-row" style="margin-top:10px"><button class="subtle">Save shared defaults JSON</button></div>
    </form>
  </details>
</section>`;
}

function defaultsJson(targetRoot, defaults) {
  try {
    return readFileSync(agentFile(targetRoot, "_defaults"), "utf8");
  } catch {
    return JSON.stringify(defaults, null, 2);
  }
}

function renderScheduledTasks(models, { canRunNow = false, selectedRole = "", selectedTask = "", showTaskEditor = false } = {}) {
  const selected = models.schedules.find((task) => task.role === selectedRole && task.id === selectedTask) || null;
  const task = selected || {
    role: selectedRole && models.specs[selectedRole] ? selectedRole : Object.keys(models.specs)[0] || "",
    id: "",
    title: "",
    cron: "0 9 * * 1-5",
    prompt: "",
    enabled: true
  };
  const recurrence = recurrenceFromCron(task.cron);
  const enabledTasks = models.schedules.filter((entry) => entry.enabled).length;
  return `
<section class="hero">
  <div><p class="eyebrow">Scheduled</p><h1>Scheduled tasks</h1><p class="sub">Run tasks on a schedule or whenever you need them.</p></div>
  <a class="button" href="/scheduled?new=1#task-editor">New task</a>
</section>
<section class="section-heading"><h2>Tasks</h2><span class="muted">${enabledTasks} enabled · ${models.schedules.length} total</span></section>
${renderTaskTable(models.schedules, { canRunNow, actions: true })}
${canRunNow ? notice("Run task now starts this task immediately. It does not enable a disabled task.") : notice("Run task now is available when crewrun up is running. Saved timing uses your computer’s local time.", "warn")}
${selected || showTaskEditor ? renderTaskForm(models, { task, selected, recurrence }) : ""}`;
}

function renderTaskForm(models, { task, selected, recurrence }) {
  const cadenceOptions = [
    ["daily", "Every day"],
    ["weekdays", "Weekdays"],
    ["weekly", "Every week"],
    ["monthly", "Every month"],
    ["every-days", "Every N days"],
    ...(recurrence.cadence === "advanced" ? [["advanced", "Keep existing advanced timing"]] : [])
  ];
  return `
<section id="task-editor" class="card" style="margin-top:16px">
  <div class="section-heading" style="margin-top:0"><div><h2>${selected ? `Edit task: ${esc(selected.title || selected.id)}` : "New task"}</h2><span class="muted">Runs in your computer’s local time</span></div></div>
  ${recurrence.cadence === "advanced" ? notice("This task already uses advanced timing. Keep that option to preserve it, or choose a standard repeat rule below to replace it.", "warn") : ""}
  ${Object.keys(models.specs).length ? `<form method="post" action="/scheduled/save">
    <input type="hidden" name="previous_role" value="${esc(selected?.role || "")}"><input type="hidden" name="previous_id" value="${esc(selected?.id || "")}"><input type="hidden" name="existing_cron" value="${esc(recurrence.existingCron)}">
    <div class="form-grid three">
      <div class="field"><label for="task-role">Agent</label>${roleSelect(models, task.role, "task-role")}</div>
      <div class="field"><label for="task-id">Task ID</label><input id="task-id" name="id" value="${esc(task.id)}" placeholder="daily-brief" pattern="[a-z][a-z0-9-]*" required></div>
      <div class="field"><label for="task-title">Task title</label><input id="task-title" name="title" value="${esc(task.title || "")}" placeholder="Daily brief"></div>
    </div>
    <div class="form-grid three" style="margin-top:12px">
      <div class="field"><label for="task-recurrence">Runs</label><select id="task-recurrence" name="recurrence">${cadenceOptions.map(([value, label]) => `<option value="${value}"${value === recurrence.cadence ? " selected" : ""}>${label}</option>`).join("")}</select></div>
      <div class="field"><label for="task-time">At</label><input id="task-time" name="time" type="time" value="${esc(recurrence.time)}" required></div>
      <div class="field"><label for="task-weekday">Weekly on</label><select id="task-weekday" name="weekday">${SCHEDULE_WEEKDAYS.map((day) => `<option value="${day.value}"${day.value === recurrence.weekday ? " selected" : ""}>${day.label}</option>`).join("")}</select></div>
      <div class="field"><label for="task-month-day">Monthly on day</label><input id="task-month-day" name="day_of_month" type="number" min="1" max="31" value="${esc(recurrence.dayOfMonth)}"></div>
      <div class="field"><label for="task-interval">Every N days</label><input id="task-interval" name="interval_days" type="number" min="2" max="31" value="${esc(recurrence.intervalDays)}"></div>
      <div class="field"><span class="help">Pick the field that matches “Runs.” Only that setting is used.</span></div>
    </div>
    <div class="field" style="margin-top:12px"><label for="task-prompt">What should this agent do?</label><textarea id="task-prompt" name="prompt" placeholder="Prepare the daily brief for review." required>${esc(task.prompt)}</textarea></div>
    <label class="checkbox" style="margin-top:12px"><input type="checkbox" name="enabled" value="1"${task.enabled ? " checked" : ""}> Enable this task</label>
    <div class="button-row" style="margin-top:13px"><button>${selected ? "Save task" : "Create task"}</button><a class="button secondary" href="/scheduled">Cancel</a></div>
  </form>` : empty("Create an agent before adding a task.", "Add agent", "/agents/new")}
</section>`;
}

function renderTaskTable(tasks, { compact = false, canRunNow = false, actions = false } = {}) {
  const rows = tasks.map((task) => {
    const manage = actions ? `<a class="button secondary tiny" href="/scheduled?role=${encodeURIComponent(task.role)}&task=${encodeURIComponent(task.id)}#task-editor">Edit task</a>
      <form class="inline" method="post" action="/scheduled/toggle"><input type="hidden" name="role" value="${esc(task.role)}"><input type="hidden" name="id" value="${esc(task.id)}"><input type="hidden" name="enabled" value="${task.enabled ? "" : "1"}"><button class="subtle tiny">${task.enabled ? "Disable task" : "Enable task"}</button></form>
      <form class="inline" method="post" action="/scheduled/delete"><input type="hidden" name="role" value="${esc(task.role)}"><input type="hidden" name="id" value="${esc(task.id)}"><button class="danger tiny">Delete task</button></form>
      ${canRunNow
        ? `<form class="inline" method="post" action="/scheduled/run"><input type="hidden" name="role" value="${esc(task.role)}"><input type="hidden" name="id" value="${esc(task.id)}"><button class="tiny">Run task</button></form>`
        : `<span class="button secondary tiny disabled" title="Start crewrun up to run this task now">Run task</span>`}` : "";
    return [
      `<strong>${esc(task.title || task.id)}</strong><div class="faint"><code>${esc(task.role)}:${esc(task.id)}</code></div>`,
      `${esc(describeScheduleRecurrence(task.cron))}<div class="faint">local time</div>`,
      pill(task.enabled ? "enabled" : "disabled", task.enabled ? "success" : ""),
      compact ? when(task.nextRunAt) : `${esc(task.lastStatus || "never ran")}<div class="faint">${when(task.lastRunAt)}</div>`,
      compact ? "" : when(task.nextRunAt),
      manage
    ];
  });
  const headers = compact ? ["task", "timing", "state", "next run"] : ["task", "timing", "state", "last outcome", "next run", ""];
  const renderedRows = compact ? rows.map((row) => row.slice(0, 4)) : rows;
  return table(headers, renderedRows, "No scheduled tasks yet.");
}

function renderSkills(models) {
  const rows = models.skills.map((skill) => [
    `<code>${esc(skill.id)}</code>`, esc(skill.description),
    skill.roles.length ? skill.roles.map((role) => `<code>${esc(role)}</code>`).join(" ") : "all",
    esc(skill.scope)
  ]);
  return `
<section class="hero"><div><p class="eyebrow">Skills</p><h1>Skills</h1><p class="sub">Agents can read approved skills on demand; proposals land in the approval queue.</p></div><a class="button" href="/approvals">Review proposals</a></section>
<section class="section-heading"><h2>Installed skills</h2><span class="muted">${models.skills.length} indexed</span></section>
${table(["skill", "description", "agents", "scope"], rows, "No skills yet — agents can propose reusable workflows for your review.")}`;
}

function renderApprovals(models, { canDecideApprovals = false } = {}) {
  const hostRows = models.operations.approvals.filter((entry) => entry.status === "pending").map((entry) => [
    pill(entry.kind || "host", toneFor(entry.risk || entry.status)),
    `<code>${esc(entry.id)}</code>`,
    `${esc(entry.title || entry.description || "Approval requested")}${entry.description && entry.title ? `<div class="faint approval-preview">${esc(entry.description)}</div>` : ""}`,
    esc(entry.requestedBy || entry.role || "host"),
    (entry.source === "crewrun" || canDecideApprovals) ? approvalButtons(entry.id) : '<span class="muted">Review in the connected application</span>'
  ]);
  const proposalRows = [
    ...models.skillProposals.map((proposal) => ["skill", proposal]),
    ...models.prefProposals.map((proposal) => ["memory", proposal]),
    ...models.reflectionProposals.map((proposal) => ["reflection", proposal])
  ].map(([kind, proposal]) => [
    pill(kind, "info"),
    `<code>${esc(proposal.id)}</code>`,
    esc(kind === "skill" ? `${proposal.skillId} — ${proposal.description}` : kind === "reflection" ? `${proposal.role} — ${proposal.text}` : `${proposal.key} — ${proposal.statement}`),
    esc(proposal.proposedBy || ""),
    `<form class="inline" method="post" action="/proposals/decide"><input type="hidden" name="id" value="${esc(proposal.id)}"><input type="hidden" name="kind" value="${kind === "skill" ? "skill" : kind === "reflection" ? "reflection" : "pref"}"><input type="hidden" name="action" value="approve"><button class="tiny">Approve</button></form>
     <form class="inline" method="post" action="/proposals/decide"><input type="hidden" name="id" value="${esc(proposal.id)}"><input type="hidden" name="kind" value="${kind === "skill" ? "skill" : kind === "reflection" ? "reflection" : "pref"}"><input type="hidden" name="action" value="reject"><button class="danger tiny">Reject</button></form>`
  ]);
  return `
<section class="hero"><div><p class="eyebrow">Approvals</p><h1>Approvals</h1><p class="sub">This queue combines outgoing actions with crewrun skill and memory proposals.</p></div></section>
<section class="section-heading"><h2>Outgoing actions</h2><span class="muted">${hostRows.length} pending</span></section>
${table(["kind", "id", "request", "requested by", "decision"], hostRows, "No external actions are awaiting approval. Slack and Gmail messages appear here when an agent requests delivery.")}
<section class="section-heading"><h2>Memory and skill proposals</h2><span class="muted">${proposalRows.length} pending</span></section>
${table(["kind", "id", "proposal", "by", "decision"], proposalRows, "No proposed skills, preferences, or reflections.")}`;
}

function renderAudit(models) {
  const rows = models.operations.audit.map((entry) => [
    when(entry.at),
    `${entry.actor ? esc(entry.actor) : "—"}<div class="faint"><code>${esc(entry.role || "host")}</code></div>`,
    `${entry.model ? `<code>${esc(entry.model)}</code>` : "—"}${entry.runner ? `<div class="faint">${esc(entry.runner)}</div>` : ""}`,
    `<code>${esc(entry.toolName || entry.action || "action")}</code>${entry.toolName && entry.action && entry.toolName !== entry.action ? `<div class="faint">${esc(entry.action)}</div>` : ""}`,
    renderAuditAuthority(entry.authority),
    renderAuditData(entry.data),
    renderAuditBudget(entry.budget),
    pill(entry.outcome || "recorded", toneFor(entry.outcome))
  ]);
  return `
<section class="hero"><div><p class="eyebrow">Audit</p><h1>Audit</h1><p class="sub">Review safe metadata for each governed action. Inputs, outputs, credentials, and error text are never rendered here.</p></div></section>
<section class="section-heading"><h2>Action history</h2><span class="muted">${rows.length} safe record${rows.length === 1 ? "" : "s"}</span></section>
${table(["time", "actor / agent", "model", "action", "authority", "data", "budget", "outcome"], rows, "No actions recorded yet. Connected-service activity will appear here.")}`;
}

function renderAuditAuthority(authority = {}) {
  const parts = [];
  if (authority.decision) parts.push(pill(authority.decision, toneFor(authority.decision)));
  if (authority.toolName) parts.push(`<code>${esc(authority.toolName)}</code>${authority.impact ? ` · ${esc(authority.impact)}` : ""}`);
  else if (authority.impact) parts.push(esc(authority.impact));
  if (authority.version != null) parts.push(`<div class="faint">contract v${esc(authority.version)}${authority.revision != null ? ` · r${esc(authority.revision)}` : ""}</div>`);
  return parts.join("<br>") || "—";
}

function renderAuditData(data = {}) {
  const scopes = [
    ...(data.read || []).map((scope) => `read:${scope}`),
    ...(data.write || []).map((scope) => `write:${scope}`)
  ];
  return scopes.length ? scopes.map((scope) => `<code>${esc(scope)}</code>`).join("<br>") : "—";
}

function renderAuditBudget(budget = {}) {
  const parts = [
    budget.maxUsdPerRun != null ? `${formatCurrency(budget.maxUsdPerRun)}/run` : "",
    budget.maxUsdPerMonth != null ? `${formatCurrency(budget.maxUsdPerMonth)}/month` : "",
    budget.maxTokensPerRun != null ? `${formatTokens(budget.maxTokensPerRun)} tokens/run` : "",
    budget.maxRunsPerDay != null ? `${formatInt(budget.maxRunsPerDay)} runs/day` : ""
  ].filter(Boolean);
  return parts.length ? parts.map((part) => esc(part)).join("<br>") : "—";
}

function renderUsage(models) {
  const usage = currentUsage(models.operations.usage);
  if (!usage) {
    return `
<section class="hero"><div><p class="eyebrow">Usage</p><h1>Usage</h1><p class="sub">Attach a host budget ledger to show reported spend, subscription estimates, token usage, and outcomes.</p></div></section>
${empty("No usage ledger is attached to this console. The UI stays read-only and does not invent spend data.")}`;
  }
  const totals = usage.totals || {};
  const estimatedOnly = Number(totals.costUsd || 0) === 0 && Number(totals.estimatedCostUsd || 0) > 0;
  const runnerRows = (usage.byRunner || []).map((row) => [
    `<code>${esc(row.key || "(none)")}</code>`,
    formatInt(row.runs),
    formatTokens(Number(row.inputTokens || 0) + Number(row.outputTokens || 0)),
    formatCurrency(Number(row.costUsd || 0)),
    formatCurrency(Number(row.estimatedCostUsd || 0)),
    formatInt(row.failures)
  ]);
  const engineRows = (usage.byEngine || []).map((row) => [
    `<code>${esc(row.key || "unknown")}</code>`, formatInt(row.runs), formatCurrency(spendFor(row)), formatInt(row.failures)
  ]);
  return `
<section class="hero"><div><p class="eyebrow">Usage</p><h1>Usage</h1><p class="sub">${esc(usage.month || "Current period")} · reported API spend and equivalent estimates for local subscription runs stay visibly separate.</p></div><span class="pill ${estimatedOnly ? "warn" : "info"}">${estimatedOnly ? "estimate-led" : "ledger-backed"}</span></section>
<section class="summary-grid">
  ${metric("Total spend", formatCurrency(spendFor(totals)), "spend", formatCurrency(totals.estimatedCostUsd || 0) + " subscription estimate", "info")}
  ${metric("Runs", formatInt(totals.runs), "runs", formatInt(totals.failures) + " failed", totals.failures ? "warn" : "success")}
  ${metric("Tokens", formatTokens(Number(totals.inputTokens || 0) + Number(totals.outputTokens || 0)), "tokens", formatTokens(totals.inputTokens) + " in · " + formatTokens(totals.outputTokens) + " out")}
  ${metric("Duration", formatDuration(totals.durationSeconds), "recorded runtime", usage.source ? String(usage.source) : "host ledger")}
</section>
<section class="section-heading"><h2>By runner</h2><span class="muted">${runnerRows.length} runners</span></section>
${table(["runner", "runs", "tokens", "reported", "estimate", "failed"], runnerRows, "No runs recorded for this period.")}
<section class="section-heading"><h2>By engine</h2></section>
${table(["engine", "runs", "spend", "failed"], engineRows, "No engine totals available.")}`;
}

function renderProviders(models) {
  const secretsLocked = secretsFileExists() && !isUnlocked();
  const keyRows = knownSecretStatus().map((entry) => {
    const ambient = Boolean(process.env[entry.env]);
    const state = secretsLocked ? "locked" : entry.set || ambient ? "configured" : "not configured";
    return [esc(entry.label), `<code>${esc(entry.env)}</code>`, pill(state, toneFor(state))];
  });
  const groups = providerGroups(models.runnerOptions);
  const providerRows = groups.map((group) => [
    esc(group.label),
    group.runners.map((runner) => `<code>${esc(runner.id)}</code>`).join(" "),
    `${group.runners.length} profile${group.runners.length === 1 ? "" : "s"}`
  ]);
  const hostRows = models.operations.providers.map((provider) => [
    esc(provider.label || provider.id), esc(provider.detail || provider.description || ""), pill(provider.status || "available", toneFor(provider.status || "available"))
  ]);
  const tools = models.providerRuntime;
  return `
<section class="hero"><div><p class="eyebrow">Providers</p><h1>Providers</h1><p class="sub">Models and credentials stay operator-owned. The console never renders API keys or tokens.</p></div></section>
<section class="split">
  <div class="card flat"><div class="section-heading" style="margin-top:0"><h2>Installed runtimes</h2></div><div class="list">
    ${listRow("Claude runtime", tools.claude.available ? "available" : "not found", tools.claude.available ? "success" : "warn")}
    ${listRow("Codex runtime", tools.codex.available ? "available" : "not found", tools.codex.available ? "success" : "warn")}
    ${listRow("Model catalog", models.catalog?.updated_at ? `updated ${when(models.catalog.updated_at)}` : "not refreshed", models.catalog?.updated_at ? "info" : "")}
  </div></div>
  <div class="card flat"><div class="section-heading" style="margin-top:0"><h2>Encrypted secret store</h2></div><p class="usage-amount">${secretsFileExists() ? isUnlocked() ? "Unlocked" : "Locked" : "Not created"}</p><p class="muted" style="margin-top:8px">${secretsLocked ? "Unlock it in the operator process to inspect configured key names." : "Keys are kept out of agent prompts and this dashboard."}</p></div>
</section>
<section class="section-heading"><h2>Credential availability</h2><span class="muted">names and state only</span></section>
${table(["provider", "environment name", "state"], keyRows, "No known provider credentials.")}
<section class="section-heading"><h2>Assignable model profiles</h2><span class="muted">${models.runnerOptions.length} available</span></section>
${table(["provider", "profiles", "count"], providerRows, "No runner profiles found.")}
${hostRows.length ? `<section class="section-heading"><h2>Host provider checks</h2></section>${table(["provider", "detail", "state"], hostRows)}` : ""}`;
}

function renderConnectors(models, { canConnect = false, canDisconnect = false } = {}) {
  return `
<section class="hero"><div><p class="eyebrow">Connectors</p><h1>Integrations</h1><p class="sub">Connect your services, grant agents the tools they need, and review outgoing messages in Approvals. Available with standalone Crewrun or your own host.</p></div></section>
<section class="connector-grid" style="margin-top:16px">${models.operations.connectors.map((connector) => renderConnectorCard(connector, { canConnect, canDisconnect })).join("")}</section>`;
}

function renderConnectorCard(connector, { canConnect, canDisconnect }) {
  const state = connector.state || (connector.connected ? "connected" : "not connected");
  const action = connector.connected
    ? canDisconnect
      ? `<form method="post" action="/connectors/disconnect"><input type="hidden" name="id" value="${esc(connector.connectionId || connector.id)}"><button class="secondary">Disconnect</button></form>`
      : `<span class="muted">Managed by your integration</span>`
    : connector.localSetup
      ? renderConnectorSetup(connector)
    : connector.connectUrl && safeHref(connector.connectUrl)
      ? `<a class="button" href="${esc(safeHref(connector.connectUrl))}">Continue connection</a>`
      : canConnect
        ? `<form method="post" action="/connectors/connect"><input type="hidden" name="id" value="${esc(connector.id)}"><button>Connect ${esc(connector.label)}</button></form>`
        : `<span class="muted">Connection setup is unavailable in this integration.</span>`;
  return `<article class="connector-card${connector.localSetup && !connector.connected ? " local-setup" : ""}">
    <div class="card-head"><div style="display:flex;gap:9px;align-items:center"><span class="connector-icon">${esc(connector.initials || String(connector.label || "?").slice(0, 1).toUpperCase())}</span><div><h2>${esc(connector.label)}</h2><span class="faint">${esc(connector.account || connector.id)}</span></div></div>${pill(state, toneFor(state))}</div>
    <p class="description">${esc(connector.description || "A connected service.")}</p>
    <p class="capabilities">${(connector.capabilities || []).map((entry) => `<code>${esc(entry)}</code>`).join(" · ") || "No actions advertised"}</p>
    <div class="card-footer">${action}</div>
  </article>`;
}

function renderConnectorSetup(connector) {
  const gmail = connector.id === "gmail";
  return `<details class="connector-setup"><summary>Connect ${esc(connector.label)}</summary>
    <form method="post" action="/connectors/connect" autocomplete="off">
      <input type="hidden" name="id" value="${esc(connector.id)}">
      <p class="help" style="margin:10px 0">${gmail ? 'Use a Google OAuth client with the Gmail API enabled and a refresh token granted gmail.compose. A refresh token keeps scheduled work connected. <a href="https://developers.google.com/identity/protocols/oauth2/native-app" target="_blank" rel="noreferrer">Google setup guide</a>.' : 'Install a Slack app with chat:write and invite it to the channels you want to use. Add app_mentions:read for the reply-to-mention action. <a href="https://docs.slack.dev/authentication/tokens/" target="_blank" rel="noreferrer">Slack token guide</a>.'}</p>
      ${gmail ? `<div class="field"><label for="gmail-client">Google client ID</label><input id="gmail-client" name="client_id" required></div><div class="field"><label for="gmail-secret">Client secret</label><input id="gmail-secret" name="client_secret" type="password" required></div><div class="field"><label for="gmail-refresh">Refresh token</label><input id="gmail-refresh" name="refresh_token" type="password" required></div><label class="checkbox"><input type="checkbox" name="gmail_read" value="1"> Allow inbox search and reads (also needs gmail.readonly)</label>` : '<div class="field"><label for="slack-token">Slack OAuth token</label><input id="slack-token" name="access_token" type="password" placeholder="xoxb-…" required></div>'}
      <p class="help" style="margin:10px 0">Credentials are saved in your private local Crewrun directory, outside the project. After connecting, grant the actions in your agent’s Authorized tools.</p>
      <button>Verify and connect</button>
    </form>
  </details>`;
}

function metric(label, value, summary, detail, tone = "") {
  return `<article class="metric"${summary ? ` data-summary="${esc(summary)}"` : ""}><span class="label">${esc(label)}</span><strong class="${esc(tone)}">${esc(value)}</strong><span class="detail">${esc(detail)}</span></article>`;
}

function table(headers, rows, emptyText = "Nothing here yet.") {
  if (!rows.length) return empty(emptyText);
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function empty(message, label = "", href = "") {
  return `<div class="empty"><p>${esc(message)}</p>${label && href ? `<div style="margin-top:12px"><a class="button" href="${esc(href)}">${esc(label)}</a></div>` : ""}</div>`;
}

function notice(message, tone = "") {
  return `<div class="notice${tone ? ` ${esc(tone)}` : ""}">${esc(message)}</div>`;
}

function pill(label, tone = "") {
  return `<span class="pill${tone ? ` ${esc(tone)}` : ""}">${esc(label)}</span>`;
}

function listRow(label, value, tone = "") {
  return `<div class="list-row"><div><div class="primary">${esc(label)}</div></div><span class="pill${tone ? ` ${esc(tone)}` : ""}">${esc(value)}</span></div>`;
}

function runnerSelect(models, selected, id, emptyLabel = "Inherit default") {
  const known = new Set(models.runnerOptions.map((entry) => entry.id));
  const options = [
    `<option value=""${selected ? "" : " selected"}>${esc(emptyLabel)}</option>`,
    ...(!selected || known.has(selected) ? [] : [`<option value="${esc(selected)}" selected>${esc(selected)} (current)</option>`]),
    ...models.runnerOptions.map((entry) => `<option value="${esc(entry.id)}"${entry.id === selected ? " selected" : ""}>${esc(entry.label)}</option>`)
  ];
  return `<select id="${esc(id)}" name="runner">${options.join("")}</select>`;
}

function roleSelect(models, selected, id) {
  const options = Object.values(models.specs).map((spec) => `<option value="${esc(spec.role)}"${spec.role === selected ? " selected" : ""}>${esc(spec.role)}${spec.title ? ` — ${esc(spec.title)}` : ""}</option>`);
  return `<select id="${esc(id)}" name="role" required>${options.join("")}</select>`;
}

function approvalButtons(id) {
  return `<form class="inline" method="post" action="/approvals/decide"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="action" value="approve"><button class="tiny">Approve</button></form>
  <form class="inline" method="post" action="/approvals/decide"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="action" value="reject"><button class="danger tiny">Reject</button></form>`;
}

function roleJson(targetRoot, spec, own) {
  try {
    return readFileSync(agentFile(targetRoot, spec.role), "utf8");
  } catch {
    return JSON.stringify({
      ...(own.title || spec.title ? { title: own.title || spec.title } : {}),
      ...(own.runner || spec.runner ? { runner: own.runner || spec.runner } : {}),
      memory_pointers: Array.isArray(own.memory_pointers) ? own.memory_pointers : [],
      hooks: Array.isArray(own.hooks) ? own.hooks : []
    }, null, 2);
  }
}

function runnerLabel(models, runnerId) {
  const option = models.runnerOptions.find((entry) => entry.id === runnerId);
  return option?.label || (runnerId ? runnerProfileLabel(runnerId) : "not configured");
}

function contractFor(models, spec) {
  const supplied = models.operations.contracts?.[spec.role];
  const contract = supplied && typeof supplied === "object" ? supplied : spec.contract;
  const summary = supplied?.summary && typeof supplied.summary === "object"
    ? supplied.summary
    : spec.contractSummary && typeof spec.contractSummary === "object"
      ? spec.contractSummary
      : null;
  if (!contract && !summary) return null;
  const tools = Number(summary?.tool_count)
    || (Array.isArray(contract?.authority?.tools) ? contract.authority.tools.length : 0)
    || (Array.isArray(contract?.tools) ? contract.tools.length : 0)
    || (Array.isArray(contract?.allowedTools) ? contract.allowedTools.length : 0);
  const text = summary?.mandate || contract?.summary || (tools ? `${tools} granted tool${tools === 1 ? "" : "s"}` : "");
  return { status: String(summary?.status || contract?.status || "contract"), summary: text };
}

function currentUsage(value) {
  if (!value || typeof value !== "object") return null;
  if (value.current && typeof value.current === "object") return { ...value.current, source: value.source || value.current.source };
  if (value.totals && typeof value.totals === "object") return value;
  return null;
}

function spendFor(totals = {}) {
  return Number(totals.costUsd || 0) + Number(totals.estimatedCostUsd || 0);
}

function formatCurrency(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: amount < 1 ? 3 : 2 }).format(amount);
}

function formatInt(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? new Intl.NumberFormat("en-US").format(amount) : "0";
}

function formatTokens(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "0";
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}m`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}k`;
  return formatInt(amount);
}

function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function when(value) {
  return value ? esc(String(value).slice(0, 16).replace("T", " ")) : "—";
}

function toneFor(value) {
  const text = String(value || "").toLowerCase();
  if (/not connected|not configured|not found|unavailable/.test(text)) return "";
  if (/connected|ready|healthy|available|configured|approved|enabled|pass|success/.test(text)) return "success";
  if (/error|fail|reject|denied|problem|danger/.test(text)) return "danger";
  if (/pending|warning|warn|locked|disabled|review/.test(text)) return "warn";
  return "info";
}

function safeHref(value) {
  const href = String(value || "").trim();
  return /^(?:https?:\/\/|\/(?!\/))/.test(href) ? href : "";
}

function safeRunnerOptions() {
  try {
    return agentRunnerProfiles().map((profile) => ({
      id: profile.id,
      label: profile.displayName || runnerProfileLabel(profile.runner),
      provider: profile.provider || profile.runner?.provider || "custom",
      runner: profile.runner
    })).sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    return [];
  }
}

function safeRuntimeStatus() {
  try { return detectRunnerTools(); } catch { return { claude: { available: false }, codex: { available: false } }; }
}

function safeCatalog() {
  try { return loadModelCatalog(); } catch { return null; }
}

function providerGroups(options) {
  const groups = new Map();
  for (const entry of options) {
    const key = entry.provider || "custom";
    if (!groups.has(key)) groups.set(key, { label: providerLabel(key), runners: [] });
    groups.get(key).runners.push(entry);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function providerLabel(provider) {
  return ({ anthropic: "Anthropic / Claude", openai: "OpenAI / Codex", openrouter: "OpenRouter", glm: "Z.ai / GLM", kimi: "Moonshot / Kimi", local: "Local", slack: "Slack", gmail: "Gmail" })[provider] || provider;
}

function normalizeOperations(value) {
  const source = value && typeof value === "object" ? value : {};
  const connectorInput = asArray(source.connectors);
  const normalizedConnectors = connectorInput.map(normalizeConnector);
  const supplied = new Map(normalizedConnectors.map((entry) => [entry.id, entry]));
  const connectors = [
    ...DEFAULT_CONNECTORS.map((entry) => ({ ...entry, ...(supplied.get(entry.id) || {}) })),
    ...normalizedConnectors.filter((entry) => entry.id && !DEFAULT_CONNECTORS.some((base) => base.id === entry.id))
  ];
  return {
    usage: source.usage || source.budget || source.ledger || null,
    providers: asArray(source.providers).map(normalizeProvider),
    connectors,
    approvals: asArray(source.approvals).map(normalizeApproval),
    audit: asArray(source.audit ?? source.actions).map(normalizeAudit),
    contracts: source.contracts && typeof source.contracts === "object" ? source.contracts : {},
    hasConnectorData: connectorInput.length > 0
  };
}

function normalizeConnector(value = {}) {
  const provider = String(value.provider || "").trim().toLowerCase();
  const connectionId = String(value.id || "").trim();
  // Connector metadata uses a connection id plus a provider. The dashboard has
  // one card per provider, so prefer the provider for the action target while
  // retaining a safe account label for the human.
  const id = provider || connectionId.toLowerCase();
  const state = String(value.state || value.status || (value.connected ? "connected" : "not connected")).trim().toLowerCase();
  const account = value.account && typeof value.account === "object" && !Array.isArray(value.account) ? value.account : {};
  return {
    id,
    connectionId,
    localSetup: value.localSetup === true,
    label: String(value.label || value.name || providerLabel(provider) || id || "Connector").trim(),
    initials: String(value.initials || "").trim().slice(0, 2),
    description: String(value.description || "").trim(),
    capabilities: asArray(value.capabilities || value.actions).map((entry) => String(entry)).filter(Boolean),
    account: String(account.label || account.id || value.accountLabel || value.accountId || value.workspace || "").trim(),
    state,
    connected: value.connected === true || state === "connected",
    connectUrl: String(value.connectUrl || value.connect_url || "").trim()
  };
}

function normalizeProvider(value = {}) {
  return {
    id: String(value.id || value.provider || "provider").trim(),
    label: String(value.label || value.name || value.id || value.provider || "Provider").trim(),
    status: String(value.status || value.state || "available").trim(),
    detail: String(value.detail || value.description || "").trim()
  };
}

function normalizeApproval(value = {}) {
  return {
    id: String(value.id || "approval").trim(),
    kind: String(value.kind || value.type || "host").trim(),
    title: String(value.title || value.action || "").trim(),
    description: String(value.description || value.summary || "").trim(),
    requestedBy: String(value.requestedBy || value.requested_by || value.role || "").trim(),
    risk: String(value.risk || value.impact || "").trim(),
    status: String(value.status || "pending").trim().toLowerCase(),
    source: String(value.source || "").trim()
  };
}

// Host audit rows can contain digests, request/response fields, and host-specific
// details. This view intentionally selects only a small, typed metadata projection
// instead of ever serializing a record or displaying arbitrary nested values.
function normalizeAudit(value = {}) {
  const entry = object(value);
  const authorization = object(entry.authorization);
  const authority = object(authorization.authority || entry.authority);
  const data = normalizeAuditData(entry.data ?? authority.data);
  const budget = normalizeAuditBudget(entry.budget);
  return {
    at: auditTimestamp(entry.at || entry.created_at || entry.createdAt),
    actor: auditLabel(entry.actor || entry.actor_id || entry.actorId),
    role: auditRole(entry.role),
    runner: auditIdentifier(entry.runner || entry.runner_id || entry.runnerId),
    model: auditIdentifier(entry.model || entry.model_id || entry.modelId),
    action: auditIdentifier(entry.action || entry.type, 80),
    toolName: auditIdentifier(entry.tool_name || entry.toolName, 120),
    outcome: auditOutcome(entry.outcome || entry.status),
    authority: {
      decision: auditOutcome(authorization.decision || entry.decision),
      toolName: auditIdentifier(authority.tool_name || authority.toolName, 120),
      impact: auditImpact(authority.impact || entry.impact),
      version: auditInteger(authorization.contract_version ?? authorization.contractVersion ?? entry.contract_version ?? entry.contractVersion),
      revision: auditInteger(authorization.contract_revision ?? authorization.contractRevision ?? entry.contract_revision ?? entry.contractRevision)
    },
    data,
    budget
  };
}

function normalizeAuditData(value) {
  const data = object(value);
  return {
    read: auditScopes(data.read),
    write: auditScopes(data.write)
  };
}

function normalizeAuditBudget(value) {
  const budget = object(value);
  return {
    maxUsdPerRun: auditNumber(budget.max_usd_per_run ?? budget.maxUsdPerRun),
    maxUsdPerMonth: auditNumber(budget.max_usd_per_month ?? budget.maxUsdPerMonth),
    maxTokensPerRun: auditInteger(budget.max_tokens_per_run ?? budget.maxTokensPerRun),
    maxRunsPerDay: auditInteger(budget.max_runs_per_day ?? budget.maxRunsPerDay)
  };
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function auditTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function auditLabel(value) {
  const label = String(value || "").trim().replace(/\s+/g, " ");
  return /^[A-Za-z0-9][A-Za-z0-9_.:@/ +()'-]{0,119}$/.test(label) && !looksLikeCredential(label) ? label : "";
}

function auditRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,79}$/.test(role) ? role : "";
}

function auditIdentifier(value, max = 160) {
  const identifier = String(value || "").trim();
  return new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,${Math.max(0, max - 1)}}$`).test(identifier) && !looksLikeCredential(identifier) ? identifier : "";
}

function auditOutcome(value) {
  const outcome = String(value || "").trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,39}$/.test(outcome) ? outcome : "";
}

function auditImpact(value) {
  const impact = String(value || "").trim().toLowerCase();
  return ["read", "internal-write", "external-write", "destructive", "financial"].includes(impact) ? impact : "";
}

function auditScopes(value) {
  return [...new Set(asArray(value).map((scope) => String(scope || "").trim().toLowerCase())
    .filter((scope) => /^[a-z][a-z0-9_.:/*-]{0,159}$/.test(scope)))].slice(0, 100);
}

function auditNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1_000_000_000 ? number : null;
}

function auditInteger(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000_000 ? number : null;
}

function looksLikeCredential(value) {
  return /^(?:sk-|xox[baprs]-|gh[opsu]_|AIza|Bearer\s)/i.test(String(value || ""));
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}
