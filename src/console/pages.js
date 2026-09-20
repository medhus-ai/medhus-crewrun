import { readFileSync } from "node:fs";
import path from "node:path";

import { agentFile } from "../agent-paths.js";
import { listRoleSpecs, readRoleDefaults, readAgentSpecForEditing } from "../agent-spec.js";
import { loadRoleSettings, validateRoleSettings } from "../pulse.js";
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
import { renderTasks } from "./tasks.js";
import { renderKnowledge } from "./knowledge.js";
import { esc, icon } from "./shell.js";
import { renderWorkspaceReviews } from "./workspace.js";
import { readWorkspace } from "../workspace-manifest.js";
import { WORK_TOOLS } from "../workspace-tools.js";
import { tabs, readyForReview, reviewableResult, pendingReviewCount, paginate, pageOptions, pageNumber, upcomingOccurrences } from "./views.js";


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
    workspace: readWorkspace(targetRoot),
    specs,
    defaults: readRoleDefaults(targetRoot),
    settings,
    validation: validateRoleSettings(settings, { knownEvents }),
    schedules: scheduleOverview({ targetRoot }).map((schedule) => {
      const run = normalizedOperations.runs.find((r) => r.workflow === `schedule:${schedule.role}:${schedule.id}`);
      return run ? { ...schedule, lastStatus: run.desired !== "active" ? run.desired : run.status, lastRunAt: new Date(run.updated_at).toISOString(), runId: run.id } : schedule;
    }),
    heartbeatState: { roles: { ...Object.fromEntries(Object.keys(specs).flatMap((agent) => {
      const run = normalizedOperations.runs.find((r) => r.workflow === `heartbeat:${agent}`);
      return run ? [[agent, { lastRunAt: new Date(run.updated_at).toISOString() }]] : [];
    })) } },
    skills: listSkills({ targetRoot }),
    skillProposals: listSkillProposals({ targetRoot }),
    prefProposals: listPreferenceProposals({ targetRoot }),
    reflectionProposals: listReflectionProposals({ targetRoot }),
    proposalHistory: [
      ...listSkillProposals({ targetRoot, status: "" }).map((entry) => ({ ...entry, kind: "skill" })),
      ...listPreferenceProposals({ targetRoot, status: "" }).map((entry) => ({ ...entry, kind: "memory" })),
      ...listReflectionProposals({ targetRoot, status: "" }).map((entry) => ({ ...entry, kind: "reflection" }))
    ].filter((entry) => entry.status !== "pending"),
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
    case "tasks": return renderTasks(models, options);
    case "agents": return renderRoles(models, options);
    case "scheduled": return options.tab === "list" || options.showTaskEditor || options.selectedTask ? renderScheduledTasks(models, options) : renderCalendar(models, options);
    case "skills": return renderSkills(models, options);
    case "chats": return renderChats(models, options);
    case "reviews": return renderApprovals(models, options);
    case "activity": return renderActivity(models, options);
    case "usage": return renderUsage(models, options);
    case "settings": return renderSettings(models, options);
    case "integrations": return renderConnectors(models, options);
    default: return renderDashboard(models);
  }
}

function renderDashboard(models) {
  const { problems, warnings } = models.validation;
  const roles = Object.values(models.specs);
  const pending = pendingReviewCount(models);
  const usage = currentUsage(models.operations.usage) || (models.operations.usage?.months ? { month: "Current month", totals: {} } : null);
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
    <a class="button" href="/reviews">Open reviews${pending ? ` (${pending})` : ""}</a>
  </div>
</section>
<section class="summary-grid" aria-label="Crew summary">
  <a href="/tasks?tab=active">${metric("Running", models.operations.runs.filter((run) => run.status === "running").length, "agent executions", "Open active tasks")}</a>
  <a href="/reviews">${metric("Reviews", pending, `${pending} pending`, "Your decisions", pending ? "warn" : "success")}</a>
  <a href="/tasks?tab=attention">${metric("Failures", models.operations.runs.filter((run) => run.desired !== "cancelled" && (["failed", "interrupted"].includes(run.status) || (run.actions || []).some((action) => ["failed", "uncertain"].includes(action.status)))).length, "tasks to check", "Open work needing attention")}</a>
  ${metric("This month", spend === null ? "—" : formatCurrency(spend), "usage and subscription estimate", usage ? `${usage.totals?.runs || 0} recorded runs` : "no ledger attached", usage ? "info" : "")}
</section>
<section>
    <div class="section-heading"><h2>Workspace health</h2><a class="button secondary tiny" href="/settings?tab=host">Host details</a></div>
    <div class="card flat">
      <div class="list">
        ${listRow("Agent configuration", health, problems.length ? "danger" : warnings.length ? "warn" : "success")}
        ${listRow("Agents", `${roles.length} agents`, "info")}
        <a href="/integrations">${listRow("Integrations", `${connected} connected`, connected ? "success" : "")}</a>
      </div>
    </div>
</section>
${problems.length || warnings.length ? `<section><div class="section-heading"><h2>Configuration review</h2></div>${[...problems.map((entry) => notice(entry, "warn")), ...warnings.map((entry) => notice(entry, "warn"))].join("")}</section>` : ""}
`;
}

function renderRoles(models, options = {}) {
  const { selectedRole = "", roleView = "list", roleTab = "manage", agentSearch = "" } = options;
  const all = Object.values(models.specs);
  const roles = all.filter((spec) => `${spec.role} ${spec.title} ${spec.contract?.mandate || ""}`.toLowerCase().includes(agentSearch.toLowerCase()));
  const selected = roles.find((spec) => spec.role === selectedRole) || null;
  const paging = paginate(roles, pageOptions("/agents", options, { q: agentSearch }));
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
${roles.length ? `<div class="agent-grid">${paging.items.map((spec) => renderRoleCard(spec, models)).join("")}</div>${paging.html}` : empty(all.length ? "No agents match your search." : "Start with one useful job: a daily brief, a weekly review, or an operations check.", all.length ? "Clear search" : "Create your first agent", all.length ? "/agents" : "/agents/new")}
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
  const title = spec.title || "Untitled agent";
  return `
<article class="agent-card">
  <div class="card-head">
    <div><div class="agent-name" aria-label="${esc(`${spec.role} — ${title}`)}">${esc(spec.role)}</div><div class="agent-title">${esc(title)}</div></div>
    ${models.workspace?.shellAgent === spec.role ? pill("Shell access", "danger") : ""}
  </div>
  <div class="agent-meta">
    <div>Model <code>${esc(runner)}</code></div>
    <div>Memory ${spec.memory_pointers.length ? `${spec.memory_pointers.length} pointer${spec.memory_pointers.length === 1 ? "" : "s"}` : "none"} · ${spec.schedules.length} scheduled task${spec.schedules.length === 1 ? "" : "s"}</div>
    <div>Heartbeat <span class="pill ${settings?.heartbeat ? "on" : ""}">${esc(heartbeat)}</span></div>
    ${spec.contract?.mandate || spec.instructions ? `<p class="agent-mandate">${esc((spec.contract?.mandate || spec.instructions).slice(0, 220))}</p>` : ""}
    <div>Learning ${spec.reflections === false ? "off" : "reviewed reflections"}</div>
    <div>Last check-in ${models.heartbeatState.roles?.[spec.role]?.lastRunAt ? when(models.heartbeatState.roles[spec.role].lastRunAt) : "Not run yet"}</div>
  </div>
  <div class="card-footer"><span class="faint">${spec.web ? "Web enabled" : "Web off"} · ${spec.contract?.authority?.tools?.length || 0} tool${spec.contract?.authority?.tools?.length === 1 ? "" : "s"}</span><span class="button-row"><a class="icon-button" href="/chats?agent=${encodeURIComponent(spec.role)}" aria-label="Chat with ${esc(spec.role)}" title="Chat with ${esc(spec.role)}">${icon("chat", "utility-icon")}</a><a class="button secondary tiny" href="/agents/${encodeURIComponent(spec.role)}">Manage agent</a></span></div>
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
  ${renderShellSetting(spec, models)}
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

function renderShellSetting(spec, models) {
  if (!models.workspace) return "";
  const owner = models.workspace.shellAgent;
  if (owner && owner !== spec.role) return `<p class="help">System work belongs to <a href="/agents/${encodeURIComponent(owner)}">${esc(owner)}</a>. Request it through an authorized task handoff; this agent has no shell access.</p>`;
  return `<section class="card flat shell-access"><h3>Allow shell</h3>
    <p class="help">Privileged access with the CrewRun service user's OS permissions, not root access. Shell commands can reach files and networks outside ordinary agent boundaries. Native auto-review can make mistakes; it is not filesystem isolation.</p>
    <p class="help">One agent per workspace. Currently requires direct Claude with native auto mode available; Codex and routed providers cannot enable shell. Flagged actions appear in Reviews. Other agents must delegate through authorized handoffs.</p>
    <form method="post" action="/agents/shell"><input type="hidden" name="role" value="${esc(spec.role)}"><input type="hidden" name="enabled" value="${owner ? "" : "1"}">
      ${owner ? "" : '<label class="help"><input type="checkbox" name="confirmed" value="1" required> I understand this grants privileged system access.</label>'}
      <div class="button-row"><button class="state-toggle" role="switch" aria-checked="${Boolean(owner)}" aria-label="Allow shell for ${esc(spec.role)}"></button><span>${owner ? "Enabled — native auto-review" : "Disabled"}</span></div>
    </form></section>`;
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
        <div class="field"><label for="agent-reflections">Reflections</label><select id="agent-reflections" name="reflections">${options([["inherit", "Use shared defaults"], ["on", "Allow optional improvement proposals"], ["off", "Off"]], own.reflections === undefined ? "inherit" : own.reflections === false ? "off" : "on")}</select><span class="help">Off by default. Reviewed proposals update saved context or Skills; routine journals are never added to prompts.</span></div>

      </div>
      <div class="button-row" style="margin-top:12px"><button class="subtle">Save activity and learning</button></div>
    </form>
  </section>`;
}

function renderContractEditor(spec, own) {
  const contract = own.contract && typeof own.contract === "object" ? own.contract : null;
  if (!contract) {
    return `<section class="notice warn" style="margin-top:12px">
      <div class="card-head"><div><h3>Add an authority contract</h3><p class="help" style="margin-top:3px">An agent without a contract cannot run. Review its authority before enabling work.</p></div>
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
        <div class="field"><label for="contract-write">Data this agent may change</label><textarea id="contract-write" name="data_write" placeholder="connector:slack:slack&#10;connector:gmail:gmail">${esc((contract.authority?.data?.write || []).join("\n"))}</textarea><span class="help">For a hosted integration, copy its exact <code>connector:provider:connection-id</code> scope from Integrations. Standalone Slack/Gmail use <code>connector:slack:slack</code> and <code>connector:gmail:gmail</code>. Outgoing messages still require approval.</span></div>
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
  const detail = summary.status === "unconfigured"
    ? "Add an authority contract before this agent can run."
    : `${summary.mandate || "No mandate recorded."} ${tools.length ? `${tools.length} authorized tool${tools.length === 1 ? "" : "s"}.` : "No tools are authorized."}`;
  return `<section class="notice${summary.status === "governed" ? "" : " warn"}" style="margin-top:16px">
    <div class="card-head"><div><h3>Authority contract</h3><p class="help" style="margin-top:3px">${esc(detail)}</p></div></div>
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

function renderScheduledTasks(models, options = {}) {
  const { canRunNow = false, selectedRole = "", selectedTask = "", showTaskEditor = false } = options;
  const paging = paginate(models.schedules, pageOptions("/scheduled", options, { tab: "list" }));
  const selected = models.schedules.find((task) => task.role === selectedRole && task.id === selectedTask) || null;
  const task = selected || {
    role: selectedRole && models.specs[selectedRole] ? selectedRole : Object.keys(models.specs)[0] || "",
    id: "",
    title: "",
    cron: "0 9 * * 1-5",
    prompt: "",
    enabled: false
  };
  const recurrence = recurrenceFromCron(task.cron);
  const enabledTasks = models.schedules.filter((entry) => entry.enabled).length;
  return `
<section class="hero">
  <div><p class="eyebrow">Scheduled</p><h1>Scheduled tasks</h1><p class="sub">Run tasks on a schedule or whenever you need them.</p></div>
  <a class="button" href="/scheduled?new=1#task-editor">New task</a>
</section>
${tabs("/scheduled", [["calendar", "Calendar"], ["list", "List"]], "list")}
<section class="section-heading"><h2>Tasks</h2><span class="muted">${enabledTasks} enabled · ${models.schedules.length} total</span></section>
${renderTaskTable(paging.items, { canRunNow, actions: true, returnTo: `/scheduled?tab=list&page=${paging.page}` })}${paging.html}
${canRunNow ? "" : notice("Run now is available when crewrun up is running. Saved timing uses your computer’s local time.", "warn")}
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

function renderTaskTable(tasks, { compact = false, canRunNow = false, actions = false, returnTo = "/scheduled?tab=list" } = {}) {
  const rows = tasks.map((task) => {
    const manage = actions ? `<div class="button-row"><a class="button secondary tiny" href="/scheduled?tab=list&role=${encodeURIComponent(task.role)}&task=${encodeURIComponent(task.id)}#task-editor">Edit</a>
      ${canRunNow
        ? `<form class="inline" method="post" action="/scheduled/run"><input type="hidden" name="role" value="${esc(task.role)}"><input type="hidden" name="id" value="${esc(task.id)}"><input type="hidden" name="return_to" value="${esc(returnTo)}"><button class="tiny">Run now</button></form>`
        : `<span class="button secondary tiny disabled" title="Start crewrun up to run this task now">Run now</span>`}</div>` : "";
    return [
      `<strong>${esc(task.title || task.id)}</strong><div class="faint"><code>${esc(task.role)}:${esc(task.id)}</code></div>`,
      `${esc(describeScheduleRecurrence(task.cron))}<div class="faint">local time</div>`,
      actions ? `<form class="inline" method="post" action="/scheduled/toggle"><input type="hidden" name="role" value="${esc(task.role)}"><input type="hidden" name="id" value="${esc(task.id)}"><input type="hidden" name="enabled" value="${task.enabled ? "" : "1"}"><input type="hidden" name="return_to" value="${esc(returnTo)}"><button class="state-toggle" role="switch" aria-checked="${task.enabled}" aria-label="Enable ${esc(task.title || task.id)}" title="${task.enabled ? "Enabled" : "Disabled"}"></button></form>` : pill(task.enabled ? "enabled" : "disabled", task.enabled ? "success" : ""),
      compact ? when(task.nextRunAt) : `${task.runId ? `<a href="/tasks?run=${esc(task.runId)}">${esc(task.lastStatus)}</a>` : esc(task.lastStatus || "never ran")}<div class="faint">${when(task.lastRunAt)}</div>`,
      compact ? "" : when(task.nextRunAt),
      manage
    ];
  });
  const headers = compact ? ["task", "timing", "state", "next run"] : ["task", "timing", "state", "last outcome", "next run", ""];
  const renderedRows = compact ? rows.map((row) => row.slice(0, 4)) : rows;
  return table(headers, renderedRows, "No scheduled tasks yet.");
}

function renderCalendar(models, options = {}) {
  const count = [3, 5, 10, 25].includes(Number(options.calendarCount)) ? Number(options.calendarCount) : 3;
  const page = Math.min(pageNumber(options.page), 100);
  const parsedFrom = new Date(options.calendarFrom || Date.now());
  const from = Number.isFinite(parsedFrom.getTime()) ? parsedFrom : new Date();
  const upcoming = upcomingOccurrences(models.schedules, { from, limit: page * count + (page < 100 ? 1 : 0) });
  const paging = paginate(upcoming, { page, size: count, base: "/scheduled", params: { tab: "calendar", count, from: from.toISOString() }, openEnded: true });
  const days = new Map();
  for (const task of paging.items) {
    const date = new Date(task.nextRunAt);
    const key = [date.getFullYear(), date.getMonth(), date.getDate()].join("-");
    if (!days.has(key)) days.set(key, { date, tasks: [] });
    days.get(key).tasks.push(task);
  }
  const calendar = [...days.values()].map(({ date, tasks }) => {
    const heading = date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const events = tasks.map((task) => `<a class="calendar-event" href="/scheduled?role=${encodeURIComponent(task.role)}&task=${encodeURIComponent(task.id)}#task-editor"><strong>${esc(task.title || task.id)}</strong><span>${esc(task.role)} · ${esc(dateTime(task.nextRunAt))}</span></a>`).join("");
    return `<section class="calendar-day"><div class="calendar-date">${esc(heading)}</div><div class="calendar-events">${events}</div></section>`;
  }).join("");
  return `
<section class="hero">
  <div><h1>Scheduled tasks</h1><p class="sub">Upcoming runs in your computer’s local time.</p></div>
  <a class="button" href="/scheduled?new=1#task-editor">New task</a>
</section>
${tabs("/scheduled", [["calendar", "Calendar"], ["list", "List"]], "calendar")}
<section class="section-heading"><h2>Upcoming runs</h2><form method="get" action="/scheduled" class="button-row"><input type="hidden" name="tab" value="calendar"><label for="calendar-count" class="muted">Show next</label><select class="compact-select" id="calendar-count" name="count" onchange="this.form.requestSubmit()">${[3, 5, 10, 25].map((value) => `<option value="${value}"${value === count ? " selected" : ""}>${value}</option>`).join("")}</select><noscript><button>Show</button></noscript></form></section>
${days.size ? `<div class="calendar-list">${calendar}</div>${paging.html}` : empty("No enabled scheduled tasks have an upcoming run yet.", "Create task", "/scheduled?new=1#task-editor")}`;
}

function renderSkills(models, options = {}) {
  const { showSkillForm = false } = options;
  const rows = models.skills.map((skill) => [
    `<code>${esc(skill.id)}</code>`, esc(skill.description),
    skill.roles.length ? skill.roles.map((role) => `<code>${esc(role)}</code>`).join(" ") : "all",
    esc(skill.scope)
  ]);
  return `
<section class="hero"><div><p class="eyebrow">Skills</p><h1>Skills</h1><p class="sub">Agents can read approved skills on demand. Review proposed changes under Reviews.</p></div><div class="actions"><a class="button secondary" href="/reviews?tab=learning">Review proposals</a><a class="button" href="/skills?new=1#skill-form">Add skill</a></div></section>
${showSkillForm ? renderSkillForm(models) : ""}
<section class="section-heading"><h2>Installed skills</h2><span class="muted">${models.skills.length} indexed</span></section>
${table(["skill", "description", "agents", "scope"], rows, "No skills yet — agents can propose reusable workflows for your review.", pageOptions("/skills", options))}`;
}

function renderSkillForm(models) {
  const agentNames = Object.values(models.specs).map((spec) => spec.role).join("\n");
  return `
<section id="skill-form" class="card" style="margin-top:16px">
  <div class="section-heading" style="margin-top:0"><div><h2>Propose a skill</h2><span class="muted">Skills stay reviewable: this creates a proposal for Approvals.</span></div></div>
  <form method="post" action="/skills/propose">
    <div class="form-grid three">
      <div class="field"><label for="skill-id">Skill ID</label><input id="skill-id" name="skill_id" placeholder="weekly-review" pattern="[a-z][a-z0-9-]*" required><span class="help">lowercase letters, digits, hyphens</span></div>
      <div class="field wide"><label for="skill-description">What reusable outcome does it provide?</label><input id="skill-description" name="description" maxlength="200" placeholder="Prepare a concise, evidence-backed weekly operating review." required></div>
      <div class="field"><label for="skill-scope">Scope</label><select id="skill-scope" name="scope"><option value="repository" selected>Repository</option><option value="workspace">Workspace</option><option value="user">User</option></select></div>
      <div class="field wide"><label for="skill-roles">Applicable agents</label><textarea id="skill-roles" name="roles" placeholder="ops&#10;analyst"></textarea><span class="help">One agent slug per line; leave blank when the skill is useful to every agent. Current agents: ${esc(agentNames || "none")}.</span></div>
      <div class="field wide"><label for="skill-content">Workflow body</label><textarea id="skill-content" name="content" placeholder="## Steps&#10;1. Gather…&#10;2. Check…&#10;3. Return…" required></textarea><span class="help">Write the reusable steps only. Approval adds the skill metadata.</span></div>
      <div class="field wide"><label for="skill-evidence">Why is this reusable?</label><input id="skill-evidence" name="evidence" maxlength="4000" placeholder="Used for the weekly leadership review; the same inputs and checks recur." required></div>
    </div>
    <div class="button-row" style="margin-top:13px"><button>Propose skill</button><a class="button secondary" href="/skills">Cancel</a></div>
  </form>
</section>`;
}

function renderChats(models, options = {}) {
  const { selectedChat = null, selectedChatRole = "", canChat = false } = options;
  const agents = Object.values(models.specs);
  const selectedRole = selectedChat?.role || selectedChatRole;
  const selected = agents.find((spec) => spec.role === selectedRole) || null;
  const recent = models.operations.chats.filter((chat) => chat.purpose !== "console-helper");
  const paging = paginate(agents, pageOptions("/chats", options, selectedRole ? { agent: selectedRole } : {}));
  const agentLinks = paging.items.map((agent) => {
    const thread = recent.find((entry) => entry.role === agent.role);
    const active = agent.role === selectedRole;
    return `<a class="chat-thread${active ? " active" : ""}" href="/chats?agent=${encodeURIComponent(agent.role)}"${active ? ' aria-current="page"' : ""}><span class="chat-thread-name">${esc(agent.title || agent.role)}</span><span class="chat-thread-meta">${thread ? esc(thread.title || "Resumed thread") : "Start chat"}</span></a>`;
  }).join("");
  const compose = selected && canChat ? `<form class="chat-composer" method="post" action="/chats/send"><input type="hidden" name="role" value="${esc(selected.role)}"><input type="hidden" name="return_to" value="/chats?agent=${encodeURIComponent(selected.role)}"><textarea name="message" maxlength="20000" placeholder="Message ${esc(selected.title || selected.role)}" required></textarea><div class="button-row"><span class="help">The agent receives this thread and resumes its configured provider session when available.</span><button>Send</button></div></form>` : "";
  const workspace = selected
    ? `<div class="chat-header"><div><h2>${esc(selected.title || selected.role)}</h2><p class="muted"><code>${esc(selected.role)}</code> · one resumed thread</p></div><a class="button secondary tiny" href="/agents/${encodeURIComponent(selected.role)}">Manage agent</a></div>${renderChatMessages(selectedChat, selected.title || selected.role)}${compose}`
    : empty("Choose an agent to open its durable chat.", agents.length ? "Open first agent" : "Add agent", agents.length ? `/chats?agent=${encodeURIComponent(agents[0].role)}` : "/agents/new");
  return `
<section class="hero"><div><p class="eyebrow">Chats</p><h1>Agent chats</h1><p class="sub">Each agent keeps one resumed, durable conversation for this workspace.</p></div></section>
${canChat ? "" : notice("Chat needs a running CrewRun host with an agent runner. You can still review agent settings and scheduled tasks.", "warn")}
<section class="chat-layout" aria-label="Agent chats">
  <nav class="chat-threads" aria-label="Agents"><div class="chat-threads-heading"><strong>Agents</strong><span class="muted">${agents.length}</span></div>${agents.length ? agentLinks + paging.html : `<p class="help">Add an agent to begin a chat.</p>`}</nav>
  <div class="chat-workspace">${workspace}</div>
</section>`;
}

export function renderHelperDrawer(models, { helperOpen = false, helperChat = null, canChat = false, openHref = "/?helper=1", closeHref = "/" } = {}) {
  return `
<a class="helper-launcher" href="${esc(openHref)}" aria-label="Open Crew helper" title="Open Crew helper">${icon("chat", "utility-icon")}<span>Crew helper</span></a>
<aside class="helper-drawer${helperOpen ? " open" : ""}" aria-label="Crew helper" aria-hidden="${helperOpen ? "false" : "true"}"${helperOpen ? "" : " inert"}>
  <div class="helper-drawer-head"><div><strong>Crew helper</strong><p>Guided setup</p></div><a class="icon-button" href="${esc(closeHref)}" aria-label="Close Crew helper" title="Close">×</a></div>
  <div class="helper-choices"><a href="/agents/new">Add agent</a><a href="/agents">Manage agent</a><a href="/skills?new=1#skill-form">Add skill</a><a href="/scheduled?new=1">Schedule task</a></div>
  <p class="helper-note">The helper can inspect agents, skills, and tasks through its read-only internal tool. It drafts changes for the normal reviewed forms; it never writes configuration itself.</p>
  <div class="helper-messages">${renderChatMessages(helperChat, "Crew helper")}</div>
  ${canChat ? `<form class="chat-composer helper-composer" method="post" action="/chats/send"><input type="hidden" name="role" value="crew-helper"><input type="hidden" name="return_to" value="${esc(openHref)}"><textarea name="message" maxlength="20000" placeholder="What would you like to set up?" required></textarea><button>Ask helper</button></form>` : `<p class="help">Start the local CrewRun host and configure a runner to chat with the helper.</p>`}
</aside>`;
}

function renderChatMessages(chat, label) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  if (!messages.length) return '<div class="chat-empty">Start the conversation. This thread will be reused for the next message.</div>';
  return `<div class="chat-messages">${messages.map((message) => `<article class="chat-message${message.author === "user" ? " user" : ""}"><span class="chat-author">${esc(message.author === "user" ? "You" : label)}</span><div class="chat-copy">${esc(message.content)}</div></article>`).join("")}</div>`;
}

function renderApprovals(models, options = {}) {
  const { canDecideApprovals = false, selectedReview = "" } = options;
  const tab = ["actions", "results", "learning", "workspace", "history"].includes(options.tab) ? options.tab : "actions";
  const pending = models.operations.approvals.filter((entry) => entry.status === "pending");
  const header = `<section class="hero"><div><h1>Reviews</h1><p class="sub">Decide what can be sent, accept finished work, and review proposed learning.</p></div></section>${tabs("/reviews", [
    ["actions", `Actions (${pending.length})`], ["results", `Results (${models.operations.runs.filter(reviewableResult).length})`],
    ["learning", `Memory & skills (${models.skillProposals.length + models.prefProposals.length + models.reflectionProposals.length})`], ["workspace", `Workspace (${(models.operations.workspaceProposals || []).filter((p) => ["pending", "applying"].includes(p.status)).length})`], ["history", "History"]
  ], tab)}`;
  if (tab === "results") return header + renderTasks(models, { ...options, reviewMode: true });
  if (tab === "workspace") return header + renderWorkspaceReviews(models, options);
  if (tab === "history") return header + renderReviewHistory(models, options);
  const hostRows = pending.filter((entry) => !selectedReview || entry.id === selectedReview).map((entry) => [
    pill(entry.kind || "host", toneFor(entry.risk || entry.status)),
    `<a href="/reviews?tab=actions&review=${encodeURIComponent(entry.id)}">Open review</a>${entry.runId ? `<div><a href="/tasks?run=${encodeURIComponent(entry.runId)}">Open task</a></div>` : ""}`,
    `${esc(entry.title || "Approval requested")}${selectedReview && entry.description ? `<div class="approval-preview">${esc(entry.description)}</div>` : ""}`,
    esc(entry.requestedBy || entry.role || "host"),
    selectedReview && (entry.source === "crewrun" || canDecideApprovals) ? approvalButtons(entry.id) : '<span class="muted">Open the review to inspect the proposed action.</span>'
  ]);
  const proposalRows = [
    ...models.skillProposals.map((proposal) => ["skill", proposal]),
    ...models.prefProposals.map((proposal) => ["memory", proposal]),
    ...models.reflectionProposals.map((proposal) => ["reflection", proposal])
  ].map(([kind, proposal]) => [
    pill(kind, "info"),
    `<code>${esc(proposal.id)}</code>`,
    esc(kind === "skill" ? `${proposal.skillId} — ${proposal.description}` : kind === "reflection" ? `${proposal.role} → ${proposal.target || "choose destination"} ${proposal.key || ""} — ${proposal.text}` : `${proposal.key} — ${proposal.statement}`),
    esc(proposal.proposedBy || ""),
    `<form class="inline" method="post" action="/reviews/learning/decide"><input type="hidden" name="id" value="${esc(proposal.id)}"><input type="hidden" name="kind" value="${kind === "skill" ? "skill" : kind === "reflection" ? "reflection" : "pref"}"><input type="hidden" name="action" value="approve">${kind === "reflection" && !proposal.target ? `<label>Save as<select name="target"><option value="preference">Context / preference</option><option value="skill">Skill</option></select></label><label>Stable key<input name="key" required></label><label>Skill description (if needed)<input name="description"></label>` : ""}<button class="tiny">Approve</button></form>
     <form class="inline" method="post" action="/reviews/learning/decide"><input type="hidden" name="id" value="${esc(proposal.id)}"><input type="hidden" name="kind" value="${kind === "skill" ? "skill" : kind === "reflection" ? "reflection" : "pref"}"><input type="hidden" name="action" value="reject"><button class="danger tiny">Reject</button></form>`
  ]);
  return header + (tab === "actions" ? `
<section class="section-heading"><h2>Actions requiring review</h2><span class="muted">${hostRows.length} pending</span></section>
${selectedReview ? '<p><a href="/reviews?tab=actions">Back to pending actions</a> · Approval permits this action; it does not accept the task result.</p>' : ""}
${table(["kind", "links", "request", "requested by", "decision"], hostRows, selectedReview ? "This action is no longer pending. Check review history or the task for its outcome." : "No external actions are awaiting approval.", pageOptions("/reviews", options, { tab }))}` : `
<section class="section-heading"><h2>Memory and skill proposals</h2><span class="muted">${proposalRows.length} pending</span></section>
${table(["kind", "id", "proposal", "by", "decision"], proposalRows, "No proposed skills, preferences, or reflections.", pageOptions("/reviews", options, { tab }))}`);
}

function renderReviewHistory(models, options) {
  const decisions = models.operations.runs.flatMap((run) => (run.timeline || [])
    .filter((entry) => ["action.approve", "action.reject", "run.accept"].includes(entry.type))
    .map((entry) => ({ at: entry.created_at, kind: entry.type === "run.accept" ? "result" : "action", title: run.prompt.slice(0, 160),
      status: { "action.approve": "approved", "action.reject": "rejected", "run.accept": "accepted" }[entry.type], runId: run.id })));
  decisions.push(...models.operations.approvals.filter((entry) => entry.status !== "pending" && entry.source !== "runtime").map((entry) => ({ ...entry, at: entry.decidedAt, kind: "action" })));
  decisions.push(...(models.proposalHistory || []).map((entry) => ({ ...entry, at: entry.decidedAt, title: entry.description || entry.statement || entry.text || entry.skillId || entry.key })));
  decisions.push(...(models.operations.workspaceProposals || []).filter((p) => !["pending", "applying"].includes(p.status)).map((p) => ({ ...p, kind: "workspace", at: p.decided_at, runId: p.run_id })));
  decisions.sort((a, b) => (new Date(b.at).getTime() || 0) - (new Date(a.at).getTime() || 0));
  return `<section class="section-heading"><h2>Decision history</h2></section>${table(["time", "kind", "review", "decision", "task"], decisions.map((entry) => [
    when(entry.at), esc(entry.kind), esc(entry.title), pill(entry.status, toneFor(entry.status)), entry.runId ? `<a href="/tasks?run=${encodeURIComponent(entry.runId)}">Open task</a>` : "—"
  ]), "No retained decisions yet.", pageOptions("/reviews", options, { tab: "history" }))}`;
}

function renderActivity(models, options = {}) {
  const tab = options.tab === "events" ? "events" : "actions";
  const search = String(options.search || "").trim().toLowerCase();
  // Search only the same safe projection used for display, never raw provider payloads.
  const filtered = { ...models, operations: { ...models.operations,
    audit: models.operations.audit.filter((entry) => !search || JSON.stringify(entry).toLowerCase().includes(search)),
    events: models.operations.events.filter((entry) => !search || JSON.stringify(entry).toLowerCase().includes(search))
  } };
  return `<section class="hero"><div><h1>Activity</h1><p class="sub">Trace agent actions and incoming integration events.</p></div></section>
${tabs("/activity", [["actions", "Agent actions"], ["events", "Integration events"]], tab)}
<form method="get" action="/activity" class="button-row" style="margin-top:16px"><input type="hidden" name="tab" value="${tab}"><input name="q" aria-label="Search activity" placeholder="Search agent, service, action, or outcome" value="${esc(options.search || "")}"><button class="subtle">Search</button></form>
${tab === "events" ? renderEvents(filtered, options) : renderAudit(filtered, options)}`;
}

function renderAudit(models, options) {
  const rows = models.operations.audit.map((entry) => [
    when(entry.at),
    `${entry.actor ? esc(entry.actor) : "—"}<div class="faint">${models.specs[entry.role] ? `<a href="/agents/${encodeURIComponent(entry.role)}">${esc(entry.role)}</a>` : esc(entry.role || "host")}</div>`,
    `${entry.model ? `<code>${esc(entry.model)}</code>` : "—"}${entry.runner ? `<div class="faint">${esc(entry.runner)}</div>` : ""}`,
    `<code>${esc(entry.toolName || entry.action || "action")}</code>${entry.toolName && entry.action && entry.toolName !== entry.action ? `<div class="faint">${esc(entry.action)}</div>` : ""}`,
    renderAuditAuthority(entry.authority),
    renderAuditData(entry.data),
    renderAuditBudget(entry.budget),
    pill(entry.outcome || "recorded", toneFor(entry.outcome)),
    renderAuditLinks(entry, models)
  ]);
  return `
<p class="help" style="margin-top:16px">Recorded authority, data scopes, and outcomes. Inputs, outputs, and credentials are omitted.</p>
<section class="section-heading"><h2>Action history</h2><span class="muted">${rows.length} safe record${rows.length === 1 ? "" : "s"}</span></section>
${table(["time", "actor / agent", "model", "action", "authority", "data", "budget", "outcome", "related work"], rows, "No actions recorded yet. Connected-service activity will appear here.", pageOptions("/activity", options, { tab: "actions", q: options.search || "" }))}`;
}

function renderAuditLinks(entry, models) {
  const run = models.operations.runs.find((candidate) => entry.approvalId && (candidate.actions || []).some((action) => action.id === entry.approvalId));
  if (!run) return "—";
  const pending = models.operations.approvals.some((approval) => approval.id === entry.approvalId && approval.status === "pending");
  return `<a href="/tasks?run=${encodeURIComponent(run.id)}">Task</a><br><a href="${pending ? `/reviews?tab=actions&review=${encodeURIComponent(entry.approvalId)}` : "/reviews?tab=history"}">${pending ? "Review" : "Decision history"}</a>`;
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

function renderUsage(models, options) {
  const usage = currentUsage(models.operations.usage) || (models.operations.usage?.months ? { month: "Current month", totals: {} } : null);
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
  ${models.operations.delivery ? metric("Accepted deliverables", formatInt(models.operations.delivery.delivered), "accepted this month", models.operations.delivery.costPerDelivered == null ? "Accept a result to calculate cost per deliverable" : formatCurrency(models.operations.delivery.costPerDelivered) + " recorded cost per accepted deliverable (includes estimates)") : ""}
  ${metric("Total spend", formatCurrency(spendFor(totals)), "spend", formatCurrency(totals.estimatedCostUsd || 0) + " subscription estimate", "info")}
  ${metric("Runs", formatInt(totals.runs), "runs", formatInt(totals.failures) + " failed", totals.failures ? "warn" : "success")}
  ${metric("Tokens", formatTokens(Number(totals.inputTokens || 0) + Number(totals.outputTokens || 0)), "tokens", formatTokens(totals.inputTokens) + " in · " + formatTokens(totals.outputTokens) + " out")}
  ${metric("Duration", formatDuration(totals.durationSeconds), "recorded runtime", usage.source ? String(usage.source) : "host ledger")}
</section>
${models.operations.outcomes?.unknownUsageAttempts ? `<p class="help">${models.operations.outcomes.unknownUsageAttempts} attempts have unknown usage. Reported costs may be incomplete.</p>` : ""}
<section class="section-heading"><h2>By runner</h2><span class="muted">${runnerRows.length} runners</span></section>
${table(["runner", "runs", "tokens", "reported", "estimate", "failed"], runnerRows, "No runs recorded for this period.", pageOptions("/usage", options, {}, "runners_page"))}
<section class="section-heading"><h2>By engine</h2></section>
${table(["engine", "runs", "spend", "failed"], engineRows, "No engine totals available.", pageOptions("/usage", options, {}, "engines_page"))}`;
}

function renderSettings(models, options = {}) {
  const tab = ["host", "knowledge"].includes(options.tab) ? options.tab : "providers";
  const header = `<section class="hero"><div><h1>Settings</h1><p class="sub">Model providers, local knowledge, and host configuration.</p></div></section>${tabs("/settings", [["providers", "Providers & credentials"], ["knowledge", "Knowledge"], ["host", "Host"]], tab)}`;
  if (tab === "knowledge") return header + renderKnowledge(models);
  const boundary = models.workspace ? notice("Governed workspace: Claude-compatible runners and the verified Codex SDK on Linux use the internal tool bridge. Native tools are disabled or denied by default. The owner may opt one direct-Claude agent into privileged native shell auto mode from agent settings; this exception is not filesystem isolation. Generic CLI runners fail closed. Daily run limits are supported; hard per-run USD is Claude-only, and hard token/monthly-dollar limits require a reservation-capable host.", "info") : "";
  if (tab === "providers") return header + boundary + renderProviders(models, options);
  const lifecycle = models.workspace ? `<section class="section-heading"><h2>Lifecycle follow-ups</h2></section><p class="help">The helper can propose rules for review. Enable them here only after the agent's hook and authority are configured.</p>${table(["rule", "event", "agent", "enabled"], models.workspace.rules.map((rule) => [esc(rule.id), esc(rule.event), esc(rule.agent), `<form method="post" action="/workspace/lifecycle"><input type="hidden" name="id" value="${esc(rule.id)}"><input type="hidden" name="enabled" value="${rule.enabled ? "" : "1"}"><button class="state-toggle" role="switch" aria-checked="${rule.enabled}" aria-label="Enable ${esc(rule.id)}"></button></form>`]), "No lifecycle follow-ups are configured.", pageOptions("/settings", options, { tab: "host" }))}` : "";
  return header + `<section class="section-heading"><h2>Host configuration</h2></section>
<div class="card flat"><div class="list">${listRow("Workspace", models.targetRoot, "")}${listRow("Calendar mirroring", options.calendarSyncAvailable ? "available" : "not installed", "")}</div><p class="help">Host configuration is managed by the running service. <a href="/integrations">Manage service connections</a>.</p></div>
${boundary}${lifecycle}<section class="section-heading"><h2>Built-in agent tools</h2></section><div class="notice">${[...Object.keys(WORK_TOOLS), ...LEARNING_TOOL_NAMES, ...WEB_TOOL_NAMES].map((name) => `<code>${esc(name)}</code>`).join(" · ")}<p>Each agent's reviewed contract controls which tools it may use.</p></div>
${[...models.validation.problems, ...models.validation.warnings].map((entry) => notice(entry, "warn")).join("")}`;
}

function renderProviders(models, options) {
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
<section class="section-heading"><h2>Providers & credentials</h2></section>
<section class="split">
  <div class="card flat"><div class="section-heading" style="margin-top:0"><h2>Installed runtimes</h2></div><div class="list">
    ${listRow("Claude runtime", tools.claude.available ? "available" : "not found", tools.claude.available ? "success" : "warn")}
    ${listRow("Codex runtime", tools.codex.available ? "available" : "not found", tools.codex.available ? "success" : "warn")}
    ${listRow("Model catalog", models.catalog?.updated_at ? `updated ${when(models.catalog.updated_at)}` : "not refreshed", models.catalog?.updated_at ? "info" : "")}
  </div></div>
  <div class="card flat"><div class="section-heading" style="margin-top:0"><h2>Encrypted secret store</h2></div><p class="usage-amount">${secretsFileExists() ? isUnlocked() ? "Unlocked" : "Locked" : "Not created"}</p><p class="muted" style="margin-top:8px">${secretsLocked ? "Unlock it in the operator process to inspect configured key names." : "Keys are kept out of agent prompts and this dashboard."}</p></div>
</section>
<section class="section-heading"><h2>Credential availability</h2><span class="muted">names and state only</span></section>
${table(["provider", "environment name", "state"], keyRows, "No known provider credentials.", pageOptions("/settings", options, { tab: "providers" }, "credentials_page"))}
<section class="section-heading"><h2>Assignable model profiles</h2><span class="muted">${models.runnerOptions.length} available</span></section>
${table(["provider", "profiles", "count"], providerRows, "No runner profiles found.", pageOptions("/settings", options, { tab: "providers" }, "providers_page"))}
${hostRows.length ? `<section class="section-heading"><h2>Host provider checks</h2></section>${table(["provider", "detail", "state"], hostRows, "", pageOptions("/settings", options, { tab: "providers" }, "host_page"))}` : ""}`;
}

function renderConnectors(models, options = {}) {
  const { selectedIntegration = "" } = options;
  const connector = models.operations.connectors.find((entry) => entry.id === selectedIntegration);
  if (selectedIntegration && !connector) return empty("Integration not found.", "All integrations", "/integrations");
  if (connector) {
    const tab = options.tab === "rules" ? "rules" : "connection";
    const scoped = { ...models, operations: { ...models.operations, connectors: [connector], eventRoutes: models.operations.eventRoutes.filter((route) => route.connectionId === connector.connectionId) } };
    return `<section class="hero"><div><h1>${esc(connector.label)}</h1><p class="sub"><a href="/integrations">All integrations</a></p></div></section>
${tabs("/integrations", [["connection", "Connection"], ["rules", "Event rules"]], tab, { integration: connector.id })}
${tab === "rules" ? renderEvents(scoped, { ...options, rulesOnly: true }) : `<section class="connector-grid" style="margin-top:16px">${renderConnectorCard(connector, { ...options, detail: true })}</section>${renderIntegrationSetup(connector, options)}${/calendar/i.test(connector.id) ? notice(options.calendarSyncAvailable ? "Scheduled tasks can mirror one way to this calendar. CrewRun remains the source of truth." : "Calendar mirroring is not installed in this host.") : ""}`}`;
  }
  const paging = paginate(models.operations.connectors, pageOptions("/integrations", options));
  return `
<section class="hero"><div><h1>Integrations</h1><p class="sub">Manage service connections, permissions, and event rules.</p></div></section>
<section class="connector-grid" style="margin-top:16px">${paging.items.map((connector) => renderConnectorCard(connector, options)).join("")}</section>${paging.html}`;
}

function renderConnectorCard(connector, { canConnect, canDisconnect, canConfigureIntegrations, canCheckIntegrations, canSubscribeIntegrations, detail = false }) {
  const state = connector.state || connector.status || (connector.connected ? "connected" : "not connected");
  const authorityScope = connector.connected && connector.connectionId
    ? `connector:${connector.provider || connector.id}:${connector.connectionId}` : "";
  const action = connector.connected
    ? canDisconnect
      ? `<form method="post" action="/integrations/disconnect"><input type="hidden" name="id" value="${esc(connector.connectionId || connector.id)}"><button class="secondary">Disconnect</button></form>`
      : `<span class="muted">Managed by your integration</span>`
    : connector.connectUrl && safeHref(connector.connectUrl)
      ? `<a class="button" href="${esc(safeHref(connector.connectUrl))}">Continue connection</a>`
      : connector.hostSetup
        ? '<span class="muted">Set up in your CrewRun host gateway.</span>'
      : connector.connectable === false
        ? '<span class="muted">This plugin does not use browser consent.</span>'
      : connector.configured === false
        ? canConfigureIntegrations && connector.setup
          ? `<a class="button" href="/integrations?integration=${encodeURIComponent(connector.id)}#setup">Set up ${esc(connector.label)}</a>`
          : `<span class="muted">${esc(connector.setupMessage || "Configure this integration in the host service before connecting.")}</span>`
      : canConnect
        ? detail ? renderHostedConnect(connector) : `<a class="button" href="/integrations?integration=${encodeURIComponent(connector.id)}#access">${connector.status === "needs_reconnect" ? "Reconnect" : "Connect"} ${esc(connector.label)}</a>`
        : `<span class="muted">Connection setup is unavailable in this integration.</span>`;
  return `<article class="connector-card${connector.capabilityOptions?.length && !connector.connected ? " has-chooser" : ""}">
    <div class="card-head"><div style="display:flex;gap:9px;align-items:center"><span class="connector-icon">${esc(connector.initials || String(connector.label || "?").slice(0, 1).toUpperCase())}</span><div><h2>${esc(connector.label)}</h2><span class="faint">${esc(connector.accountLabel || connector.account || connector.id)}</span></div></div>${pill(state, toneFor(state))}</div>
    <p class="description">${esc(connector.description || "A connected service.")}</p>
    ${detail && connector.connected ? `<p class="help">Account: ${esc(connector.accountHealth?.status || "not checked")}${connector.accountHealth?.checkedAt ? ` · ${when(connector.accountHealth.checkedAt)}` : ""}. Events: ${esc(connector.subscriptionHealth || "not configured")}.</p>` : ""}
    <p class="capabilities">${(connector.capabilities || []).map((entry) => `<code>${esc(entry)}</code>`).join(" · ") || "No actions advertised"}${connector.subscriptionHealth ? ` · ${esc(connector.subscriptionHealth)}` : ""}</p>
    ${authorityScope ? `<p class="faint">Role data scope <code>${esc(authorityScope)}</code></p>` : ""}
    <div class="card-footer">${action}${!detail ? `<a class="button secondary" href="/integrations?integration=${encodeURIComponent(connector.id)}">Manage</a>` : ""}
    ${detail && connector.connected && canCheckIntegrations && connector.canCheck ? integrationButton("check", connector.connectionId, "Check account") : ""}
    ${detail && connector.connected && canSubscribeIntegrations && connector.canSubscribe ? integrationButton("subscribe", connector.connectionId, "Set up event delivery") : ""}</div>
    ${detail && connector.connected && canConnect ? renderHostedConnect(connector) : ""}
  </article>`;
}

function renderHostedConnect(connector) {
  const options = connector.capabilityOptions || [];
  const chooser = options.length
    ? `<details id="access" class="connector-setup" open><summary>Choose access</summary><form method="post" action="/integrations/connect"><input type="hidden" name="id" value="${esc(connector.id)}"><div class="field" style="margin-top:10px"><label for="capability-${esc(connector.id)}">Capabilities</label><select id="capability-${esc(connector.id)}" name="capabilities" multiple size="${Math.min(6, Math.max(2, options.length))}" required>${options.map((entry) => `<option value="${esc(entry.id)}"${connector.selectedCapabilities?.includes(entry.id) ? " selected" : ""}>${esc(entry.label)}${entry.direction === "write" || entry.direction === "both" ? " · includes writes" : ""}</option>`).join("")}</select><span class="help">Choose only what this connection needs. Provider writes still require approval.</span></div><div class="button-row" style="margin-top:10px"><button>${connector.connected || connector.status === "needs_reconnect" ? "Reconnect" : "Connect"} ${esc(connector.label)}</button></div></form></details>`
    : `<form method="post" action="/integrations/connect"><input type="hidden" name="id" value="${esc(connector.id)}"><button>${connector.connected || connector.status === "needs_reconnect" ? "Reconnect" : "Connect"} ${esc(connector.label)}</button></form>`;
  return chooser;
}

function integrationButton(action, id, label) {
  return `<form method="post" action="/integrations/${action}"><input type="hidden" name="id" value="${esc(id)}"><button class="secondary">${esc(label)}</button></form>`;
}

function renderHttpsSetup(connector) {
  const port = Number(connector.ingressPort);
  const target = Number.isInteger(port) && port > 0 && port < 65536 ? port : 4411;
  let origin = "";
  try { origin = new URL(connector.callbackUrl).origin; } catch { /* Not configured yet. */ }
  return `<details class="connector-setup" id="https-setup"${origin ? "" : " open"}>
    <summary>Tailscale HTTPS — recommended default</summary>
    <p>Set this up once per host, then reuse it for every integration. This publishes only callbacks and verified webhooks. Your dashboard and app credentials stay private.</p>
    <ol>
      <li><a href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">Install Tailscale</a> on the CrewRun host and sign in. Enable MagicDNS, HTTPS certificates and Funnel permission in your tailnet.</li>
      <li>Find this device’s full <code>machine.tailnet.ts.net</code> hostname in Tailscale. In the environment of the service that launches CrewRun, set <code>CREWRUN_PUBLIC_BASE_URL=https://YOUR-MACHINE.YOUR-TAILNET.ts.net</code>, then restart CrewRun. Do not use another user’s hostname or put secrets in workspace files.</li>
      <li>Inspect <code>tailscale serve status</code> and <code>tailscale funnel status</code> first. If HTTPS port 443 is already in use, resolve the conflict without resetting unrelated routes.</li>
      <li>When ready to make the callback listener public, run this on the host:<pre><code>tailscale funnel --bg --https=443 http://127.0.0.1:${target}</code></pre>Complete any Tailscale permission prompt. If access is denied on Linux, run the same command with <code>sudo</code> in your own terminal. Never enter a sudo password in CrewRun or grant the agent administrator access. Never substitute the dashboard port.</li>
      <li>Confirm <code>tailscale funnel status</code> points only to <code>127.0.0.1:${target}</code>, then use the exact callback and webhook URLs below when creating your provider apps.</li>
    </ol>
    <p>Configured origin: <code>${esc(origin || "Not configured")}</code>. A configured URL does not prove public reachability or provider event delivery.</p>
    <p class="help">Anyone on the internet can reach Funnel; provider verification and one-time OAuth state still protect the callback routes. No event rules are enabled by publishing them.</p>
    <p>To stop this mapping after checking it is still CrewRun’s: <code>tailscale funnel --https=443 off</code>. This does not revoke provider grants.</p>
    <p><a href="https://tailscale.com/docs/features/tailscale-funnel" target="_blank" rel="noopener noreferrer">Funnel prerequisites</a> · <a href="https://tailscale.com/docs/reference/tailscale-cli/funnel" target="_blank" rel="noopener noreferrer">Commands and troubleshooting</a></p>
    <details><summary>Already have an HTTPS reverse proxy?</summary><p>Use its HTTPS origin instead and forward only to <code>127.0.0.1:${target}</code>. Tailscale is recommended, not required. Keep the dashboard on localhost; private Tailscale Serve needs separate trusted-origin support and must never share Funnel’s external port.</p></details>
  </details>`;
}

function renderIntegrationSetup(connector, options) {
  if (!connector.setup || !options.canConfigureIntegrations) return "";
  const setup = connector.setup;
  const disabled = connector.connected || connector.status === "needs_reconnect";
  return `<section id="setup" class="panel" style="margin-top:20px;padding:20px">
    ${renderHttpsSetup(connector)}
    <h2>Provider app setup</h2>
    <p>One account per provider in this workspace. Credentials stay in encrypted host storage, outside agent chats.</p>
    <p>${esc(setup.instructions)} <a href="${esc(safeHref(setup.docsUrl))}" target="_blank" rel="noopener noreferrer">Open provider app settings ↗</a></p>
    ${connector.setupMessage ? notice(connector.setupMessage) : ""}
    <p>Callback / setup URL: <code>${esc(connector.callbackUrl || "Set CREWRUN_PUBLIC_BASE_URL on the host, then restart.")}</code></p>
    <p>Webhook URL: <code>${esc(connector.webhookUrl || "Available after the HTTPS origin is configured.")}</code></p>
    <p class="help">HTTPS ingress must be published by the operator. Never publish the private console. Connecting does not enable any event rules.</p>
    ${disabled ? notice("Disconnect before editing app credentials. Reconnect above to change consent. Event delivery health is separate from account access.") : ""}
    <form method="post" action="/integrations/setup" autocomplete="off">
      <input type="hidden" name="id" value="${esc(connector.id)}">
      ${setup.fields.map((field) => `<div class="field"><label for="setup-${esc(field.key)}">${esc(field.label)}${field.required ? " (required)" : ""}</label>
        ${field.type === "pem" ? `<textarea id="setup-${esc(field.key)}" name="${esc(field.key)}" rows="4" autocomplete="off" spellcheck="false"${disabled || field.locked ? " disabled" : ""}></textarea>`
          : `<input id="setup-${esc(field.key)}" name="${esc(field.key)}" type="${field.type === "secret" ? "password" : "text"}" autocomplete="off" spellcheck="false"${disabled || field.locked ? " disabled" : ""}>`}
        <span class="help">${field.locked ? "Managed by host environment." : field.configured ? "Saved. Leave blank to keep the current value." : "Not configured."} ${esc(field.help)}</span></div>`).join("")}
      <button${disabled ? " disabled" : ""}>Save app configuration</button>
    </form>
    <h3 style="margin-top:24px">Available capabilities</h3>
    <p class="help">Consent is not agent authority. An agent still needs the relevant tools and connection data scope; external writes require approval.</p>
    ${(connector.capabilityOptions || []).map((capability) => `<p><strong>${esc(capability.label)}</strong> — ${esc(capability.description || capability.direction)}<br><span class="help">${(connector.actions || []).filter((action) => action.capability === capability.id).map((action) => esc(action.label)).join(" · ")}</span></p>`).join("")}
  </section>`;
}

function renderEvents(models, options = {}) {
  const { canManageEventRoutes = false, rulesOnly = false } = options;
  const events = models.operations.events;
  const connected = models.operations.connectors.filter((connector) => connector.connected && connector.connectionId);
  const choices = connected.flatMap((connector) => (connector.eventTypes || []).map((type) => ({ connectionId: connector.connectionId, label: connector.label, type })));
  const eventRows = events.map((event) => [
    when(event.receivedAt || event.occurredAt),
    `<code>${esc(event.type)}</code>`,
    (() => {
      const connector = models.operations.connectors.find((entry) => entry.connectionId === event.connectionId);
      return connector ? `<a href="/integrations?integration=${encodeURIComponent(connector.id)}">${esc(connector.label)}</a>` : `<code>${esc(event.connectionId)}</code>`;
    })(),
    `${pill(event.status || "received", toneFor(event.status))}${event.error ? `<div class="faint">${esc(event.error)}</div>` : ""}`,
    event.providerEventId ? `<code>${esc(event.providerEventId)}</code>` : "—",
    models.operations.runs.filter((run) => run.dedupe_key === `integration:${event.connectionId}:${event.providerEventId}:${run.agent}`)
      .map((run) => `<a href="/tasks?run=${encodeURIComponent(run.id)}">${esc(run.agent)} task</a>`).join("<br>") || "—"
  ]);
  const routeRows = models.operations.eventRoutes.map((route) => [
    `<code>${esc(route.connectionId)}</code>`,
    `<code>${esc(route.eventType)}</code>`,
    `<code>${esc(route.role)}</code>`,
    pill(route.enabled ? "enabled" : "disabled", route.enabled ? "success" : "")
  ]);
  const ruleForm = canManageEventRoutes && choices.length && Object.keys(models.specs).length
    ? `<section class="card" style="margin-top:16px"><div class="section-heading" style="margin-top:0"><div><h2>Add or update event rule</h2><span class="muted">The agent must also list this event in its hooks and have the connection in its contract data authority.</span></div></div><form method="post" action="/integrations/route"><div class="form-grid three"><div class="field"><label for="event-route-source">Connection and event</label><select id="event-route-source" name="source" required>${choices.map((choice) => `<option value="${esc(`${choice.connectionId}|${choice.type}`)}">${esc(choice.label)} — ${esc(choice.type)}</option>`).join("")}</select></div><div class="field"><label for="event-route-role">Agent</label>${roleSelect(models, "", "event-route-role")}</div><label class="checkbox" style="align-self:end"><input type="checkbox" name="enabled" value="1"> Enable this rule</label></div><div class="button-row" style="margin-top:13px"><button>Save event rule</button></div></form></section>`
    : "";
  return rulesOnly ? `
<section class="section-heading"><h2>Event rules</h2><span class="muted">${routeRows.length} configured</span></section>
<p class="help">Choose which incoming events create work for an agent. Unrouted events remain in <a href="/activity?tab=events">Activity</a>.</p>
${table(["connection", "event", "agent", "state"], routeRows, "No event rules yet. Connect a service, then choose a verified event and authorized agent.", pageOptions("/integrations", options, { integration: options.selectedIntegration || "", tab: "rules" }))}
${ruleForm}` : `
<section class="section-heading"><h2>Recent verified receipts</h2><span class="muted">${eventRows.length} retained metadata-only receipt${eventRows.length === 1 ? "" : "s"}</span></section>
<p class="help">These are incoming signals. Only an authorized event rule creates a task. <a href="/integrations">Manage integrations and rules</a>.</p>
${table(["received", "event", "connection", "state", "provider receipt", "created work"], eventRows, "No provider events have arrived.", pageOptions("/activity", options, { tab: "events", q: options.search || "" }))}`;
}

function metric(label, value, summary, detail, tone = "") {
  return `<article class="metric"${summary ? ` data-summary="${esc(summary)}"` : ""}><span class="label">${esc(label)}</span><strong class="${esc(tone)}">${esc(value)}</strong><span class="detail">${esc(detail)}</span></article>`;
}

function table(headers, rows, emptyText = "Nothing here yet.", paging = null) {
  if (!rows.length) return empty(emptyText);
  const page = paging ? paginate(rows, paging) : { items: rows, html: "" };
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${page.items.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${page.html}`;
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
  return `<form class="inline" method="post" action="/reviews/decide"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="action" value="approve"><button class="tiny">Approve</button></form>
  <form class="inline" method="post" action="/reviews/decide"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="action" value="reject"><button class="danger tiny">Reject</button></form>`;
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
  const date = typeof value === "number" && Number.isFinite(value) ? new Date(value) : null;
  return value ? esc(String(date && Number.isFinite(date.getTime()) ? date.toISOString() : value).slice(0, 16).replace("T", " ")) : "—";
}

function dateTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : "time unavailable";
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
  const connectors = normalizedConnectors.filter((entry) => entry.id);
  return {
    runs: asArray(source.runs),
    knowledge: source.knowledge || null,
    workspaceProposals: asArray(source.workspaceProposals),
    delivery: source.delivery || null,
    outcomes: source.outcomes || null,
    usage: source.usage || source.budget || source.ledger || null,
    providers: asArray(source.providers).map(normalizeProvider),
    connectors,
    events: asArray(source.events).map(normalizeIntegrationEvent),
    eventRoutes: asArray(source.eventRoutes).map(normalizeEventRoute),
    chats: asArray(source.chats).map(normalizeChat),
    approvals: asArray(source.approvals).map(normalizeApproval),
    audit: asArray(source.audit ?? source.actions).map(normalizeAudit),
    contracts: source.contracts && typeof source.contracts === "object" ? source.contracts : {},
    hasConnectorData: connectorInput.length > 0
  };
}

function normalizeConnector(value = {}) {
  const provider = String(value.provider || "").trim().toLowerCase();
  const suppliedId = String(value.id || "").trim();
  const connectionId = String(value.connectionId || value.connection_id || (provider ? "" : suppliedId)).trim();
  // Connector metadata uses a connection id plus a provider. The dashboard has
  // one card per provider, so prefer the provider for the action target while
  // retaining a safe account label for the human.
  const id = provider || suppliedId.toLowerCase() || connectionId.toLowerCase();
  const state = String(value.state || value.status || (value.connected ? "connected" : "not connected")).trim().toLowerCase();
  const account = value.account && typeof value.account === "object" && !Array.isArray(value.account) ? value.account : {};
  return {
    id,
    connectionId,
    label: String(value.label || value.name || providerLabel(provider) || id || "Connector").trim(),
    initials: String(value.initials || "").trim().slice(0, 2),
    description: String(value.description || "").trim(),
    capabilities: asArray(value.capabilities || value.actions).map((entry) => typeof entry === "string" ? entry : String(entry?.label || entry?.id || "")).filter(Boolean),
    capabilityOptions: asArray(value.capabilityOptions).map((entry) => {
      const option = object(entry);
      const id = String(option.id || "").trim();
      return id ? { id, label: String(option.label || id).trim(), description: String(option.description || "").trim(), direction: String(option.direction || "read").trim() } : null;
    }).filter(Boolean),
    account: String(account.label || account.id || value.accountLabel || value.accountId || value.workspace || "").trim(),
    state,
    connected: value.connected === true || state === "connected",
    connectUrl: String(value.connectUrl || value.connect_url || "").trim(),
    hostSetup: value.hostSetup === true || value.host_setup === true,
    status: state,
    setup: value.setup ? {
      instructions: String(value.setup.instructions || ""), docsUrl: String(value.setup.docsUrl || ""),
      fields: asArray(value.setup.fields).map((field) => ({
        key: String(field.key || ""), label: String(field.label || ""), type: String(field.type || "secret"),
        help: String(field.help || ""), required: field.required === true, configured: field.configured === true, locked: field.locked === true
      }))
    } : null,
    callbackUrl: String(value.callbackUrl || ""), webhookUrl: String(value.webhookUrl || ""),
    ingressPort: Number(value.ingressPort) || 4411,
    selectedCapabilities: asArray(value.selectedCapabilities).map(String),
    actions: asArray(value.actions).map((action) => ({ capability: String(action.capability || ""), label: String(action.label || "") })),
    canCheck: value.canCheck === true, canSubscribe: value.canSubscribe === true,
    accountHealth: { status: String(value.accountHealth?.status || "not checked"), checkedAt: Number(value.accountHealth?.checkedAt) || null },
    configured: value.configured !== false,
    connectable: value.connectable !== false,
    setupMessage: String(value.setupMessage || value.setup_message || "").trim().slice(0, 240),
    eventTypes: asArray(value.eventTypes || value.events).map((entry) => typeof entry === "string" ? entry : String(entry?.id || "")).filter((entry) => /^[a-z][a-z0-9-]{0,63}\.[A-Za-z][A-Za-z0-9]*$/.test(entry)),
    subscriptionHealth: String(value.subscriptionHealth || value.subscription_health || "").trim().slice(0, 80)
  };
}

function normalizeIntegrationEvent(value = {}) {
  const event = object(value);
  const type = String(event.type || event.eventType || "").trim();
  const connectionId = String(event.connectionId || event.connection_id || "").trim();
  return {
    id: Number(event.id) || 0,
    type: /^[a-z][a-z0-9-]{0,63}\.[A-Za-z][A-Za-z0-9]*$/.test(type) ? type : "integration.event",
    connectionId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(connectionId) ? connectionId : "unknown",
    providerEventId: auditIdentifier(event.providerEventId || event.provider_event_id, 512),
    occurredAt: auditTimestamp(event.occurredAt || event.occurred_at),
    receivedAt: auditTimestamp(event.receivedAt || event.received_at),
    status: auditOutcome(event.status) || "received",
    error: String(event.error || "").trim().slice(0, 240)
  };
}

function normalizeEventRoute(value = {}) {
  const route = object(value);
  const connectionId = String(route.connectionId || route.connection_id || "").trim();
  const eventType = String(route.eventType || route.event_type || "").trim();
  const role = auditRole(route.role);
  return {
    id: auditIdentifier(route.id, 128),
    connectionId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(connectionId) ? connectionId : "unknown",
    eventType: /^[a-z][a-z0-9-]{0,63}\.[A-Za-z][A-Za-z0-9]*$/.test(eventType) ? eventType : "integration.event",
    role: role || "unknown",
    enabled: route.enabled === true || route.enabled === 1 || route.enabled === "1" || route.enabled === "true"
  };
}

function normalizeChat(value = {}) {
  const role = String(value.role || "").trim();
  return {
    id: Number(value.id) || 0,
    role,
    title: String(value.title || `${role} chat`).trim(),
    updatedAt: String(value.updatedAt || value.updated_at || "").trim(),
    purpose: String(value.purpose || "").trim()
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
    source: String(value.source || "").trim(),
    runId: String(value.runId || value.run_id || ""),
    decidedAt: value.decidedAt || value.approvedAt || value.rejectedAt || ""
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
    approvalId: auditIdentifier(object(entry.approval).id, 160),
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
