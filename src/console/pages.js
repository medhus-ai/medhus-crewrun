import { readFileSync } from "node:fs";
import path from "node:path";

import { crewDir } from "../crew-dirs.js";
import { listRoleSpecs, readRoleDefaults, readRoleSpecFile } from "../role-spec.js";
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
    description: "Post a message or reply in a thread under the host’s approval policy.",
    capabilities: ["Post message", "Reply to mention"],
    state: "not connected"
  },
  {
    id: "gmail",
    label: "Gmail",
    initials: "G",
    description: "Draft or send outbound mail with a narrow, user-approved connection.",
    capabilities: ["Draft email", "Send email"],
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
    case "roles": return renderRoles(models, options);
    case "schedules": return renderSchedules(models, options);
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
  const enabledSchedules = models.schedules.filter((schedule) => schedule.enabled).length;
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
    <p class="sub">Run and govern your roles from one local control plane.</p>
  </div>
  <div class="actions">
    <a class="button secondary" href="/roles/new">Add role</a>
    <a class="button" href="/approvals">Review approvals${pending ? ` (${pending})` : ""}</a>
  </div>
</section>
<section class="summary-grid" aria-label="Crew summary">
  ${metric("Roles", roles.length, `${roles.length} roles`, "reviewable contracts")}
  ${metric("Schedules", enabledSchedules, `${enabledSchedules} schedules enabled`, `${models.schedules.length} declared`) }
  ${metric("Approvals", pending, `${pending} proposal${pending === 1 ? "" : "s"} pending`, pending ? "operator attention needed" : "queue clear", pending ? "warn" : "success")}
  ${metric("This month", spend === null ? "—" : formatCurrency(spend), "usage and subscription estimate", usage ? `${usage.totals?.runs || 0} recorded runs` : "no ledger attached", usage ? "info" : "")}
</section>
<section>
    <div class="section-heading"><h2>Governance</h2><a class="button secondary tiny" href="/approvals">Open queue</a></div>
    <div class="card flat">
      <div class="list">
        ${listRow("Role configuration", health, problems.length ? "danger" : warnings.length ? "warn" : "success")}
        ${listRow("Approved preferences", `${models.preferences.length} active`, "info")}
        ${listRow("Connector connections", `${connected} connected`, connected ? "success" : "")}
        ${listRow("Audited actions", `${models.operations.audit.length} safe record${models.operations.audit.length === 1 ? "" : "s"}`, models.operations.audit.length ? "info" : "")}
        ${listRow("Skills", `${models.skills.length} installed`, "")}
      </div>
    </div>
</section>
${problems.length || warnings.length ? `<section><div class="section-heading"><h2>Configuration review</h2></div>${[...problems.map((entry) => notice(entry, "warn")), ...warnings.map((entry) => notice(entry, "warn"))].join("")}</section>` : ""}
<section>
  <div class="section-heading"><h2>Built-in role tools</h2></div>
  <div class="notice">Ordinary bridges include the governed-learning tools ${LEARNING_TOOL_NAMES.map((name) => `<code>${esc(name)}</code>`).join(" · ")}; a strict role contract must list each one it may use. A role receives ${WEB_TOOL_NAMES.map((name) => `<code>${esc(name)}</code>`).join(" · ")} only when its reviewed spec enables web access. Host tools are granted live per role.</div>
</section>`;
}

function renderRoles(models, { selectedRole = "", roleView = "list" } = {}) {
  const roles = Object.values(models.specs);
  const selected = roles.find((spec) => spec.role === selectedRole) || null;
  return `
<section class="hero">
  <div><p class="eyebrow">Roles</p><h1>${roleView === "create" ? "Add role" : roleView === "detail" ? "Manage role" : "Roles"}</h1><p class="sub">${roleView === "create" ? "Create a focused, versioned role specification." : roleView === "detail" ? "Edit this role’s operating surface and reviewed authority." : "Define each role’s operating surface and review its authority."}</p></div>
  ${roleView === "list" ? `<a class="button" href="/roles/new">Add role</a>` : ""}
</section>
${roleView === "list" ? `
<section class="section-heading"><h2>Role directory</h2><span class="muted">${roles.length} installed</span></section>
${roles.length ? `<div class="role-grid">${roles.map((spec) => renderRoleCard(spec, models)).join("")}</div>` : empty("This crew has no roles yet.", "Add role", "/roles/new")}
${renderDefaults(models.defaults)}
` : ""}
${roleView === "create" ? `
<section id="create-role" class="card" style="margin-top:16px">
  <div class="section-heading" style="margin-top:0"><h2>Create a role</h2><span class="muted">Starts as a versioned project spec</span></div>
  <form method="post" action="/roles/add">
    <div class="form-grid three">
      <div class="field"><label for="new-role">Role slug</label><input id="new-role" name="role" placeholder="analyst" pattern="[a-z][a-z0-9-]*" required><span class="help">lowercase letters, digits, hyphens</span></div>
      <div class="field"><label for="new-title">Title</label><input id="new-title" name="title" placeholder="Analyst"></div>
      <div class="field"><label for="new-runner">Model / runner</label>${runnerSelect(models, "", "new-runner")}</div>
    </div>
    <div class="button-row" style="margin-top:13px"><button>Create role</button></div>
  </form>
</section>
` : ""}
${roleView === "detail" && selected ? renderRoleEditor(selected, models) : roleView === "detail" ? empty("This role was not found.", "Back to roles", "/roles") : ""}`;
}

function renderRoleCard(spec, models) {
  const settings = models.settings[spec.role];
  const runnerId = models.runnerFor(spec.role);
  const runner = runnerLabel(models, runnerId);
  const heartbeat = settings?.heartbeat
    ? `every ${settings.heartbeat.intervalSeconds}s${settings.heartbeat.budgetUsdPerDay != null ? ` · $${settings.heartbeat.budgetUsdPerDay}/day` : ""}`
    : "off";
  const contract = contractFor(models, spec);
  const title = spec.title || "Untitled role";
  return `
<article class="role-card">
  <div class="card-head">
    <div><div class="role-name" aria-label="${esc(`${spec.role} — ${title}`)}">${esc(spec.role)}</div><div class="role-title">${esc(title)}</div></div>
    ${contract?.status ? pill(contract.status, toneFor(contract.status)) : pill("role", "info")}
  </div>
  <div class="role-meta">
    <div>Model <code>${esc(runner)}</code></div>
    <div>Memory ${spec.memory_pointers.length ? `${spec.memory_pointers.length} pointer${spec.memory_pointers.length === 1 ? "" : "s"}` : "none"} · ${spec.schedules.length} schedule${spec.schedules.length === 1 ? "" : "s"}</div>
    <div>Heartbeat <span class="pill ${settings?.heartbeat ? "on" : ""}">${esc(heartbeat)}</span></div>
    ${contract?.summary ? `<div>${esc(contract.summary)}</div>` : ""}
  </div>
  <div class="card-footer"><span class="faint">${spec.web ? "web enabled" : "host tools only"}</span><a class="button secondary tiny" href="/roles/${encodeURIComponent(spec.role)}">Manage</a></div>
</article>`;
}

function renderRoleEditor(spec, models) {
  const own = readRoleSpecFile(models.targetRoot, spec.role) || {};
  const raw = roleJson(models.targetRoot, spec, own);
  const ownPointers = Array.isArray(own.memory_pointers) ? own.memory_pointers.map(String) : [];
  return `
<section id="role-detail" class="card" style="margin-top:16px">
  <div class="section-heading" style="margin-top:0"><div><h2>${esc(spec.role)} — ${esc(spec.title || "Untitled role")}</h2><span class="muted">Role contract basics</span></div><a class="button secondary tiny" href="/schedules?role=${encodeURIComponent(spec.role)}">Edit schedules</a></div>
  <form method="post" action="/roles/update">
    <input type="hidden" name="role" value="${esc(spec.role)}">
    <div class="form-grid">
      <div class="field"><label for="role-title">Title</label><input id="role-title" name="title" value="${esc(own.title ?? spec.title)}" placeholder="Operations lead"></div>
      <div class="field"><label for="role-runner">Model / runner</label>${runnerSelect(models, own.runner ?? "", "role-runner")}<span class="help">Leave inherited to use <code>_defaults.json</code> or the project default.</span></div>
      <div class="field wide"><label for="role-memory">Role memory pointers</label><textarea id="role-memory" name="memory_pointers" placeholder=".crew/roles/${esc(spec.role)}.md&#10;docs/domain-notes.md">${esc(ownPointers.join("\n"))}</textarea><span class="help">One repository-relative file per line. Shared pointers in <code>_defaults.json</code> remain inherited.</span></div>
    </div>
    <div class="button-row" style="margin-top:13px"><button>Save role</button><a class="button secondary" href="/roles/${encodeURIComponent(spec.role)}">Discard changes</a></div>
  </form>
  ${renderContractSummary(spec)}
  ${renderContractEditor(spec, own)}
  <details>
    <summary>Advanced JSON editor</summary>
    <p class="help" style="margin:8px 0">Use this only for reviewed fields not represented above. Saving preserves exactly this JSON object.</p>
    <form method="post" action="/roles/save">
      <input type="hidden" name="role" value="${esc(spec.role)}">
      <textarea class="code-input" name="json">${esc(raw)}</textarea>
      <div class="button-row" style="margin-top:10px"><button class="subtle">Save advanced JSON</button></div>
    </form>
  </details>
</section>`;
}

function renderContractEditor(spec, own) {
  const contract = own.contract && typeof own.contract === "object" ? own.contract : null;
  if (!contract) {
    return `<section class="notice warn" style="margin-top:12px">
      <div class="card-head"><div><h3>Start a governed contract</h3><p class="help" style="margin-top:3px">This is a deliberate migration step; it does not silently rewrite a legacy role.</p></div>
      <form class="inline" method="post" action="/roles/initialize-contract"><input type="hidden" name="role" value="${esc(spec.role)}"><button class="tiny">Initialize v1 contract</button></form></div>
    </section>`;
  }
  const tools = Array.isArray(contract.authority?.tools) ? contract.authority.tools : [];
  const toolLines = tools.map((tool) => `${tool.name || tool} | ${tool.impact || "external-write"}`).join("\n");
  return `<section class="card flat" style="margin-top:12px">
    <div class="section-heading" style="margin-top:0"><div><h3>Contract controls</h3><span class="muted">v${esc(contract.version || 1)} · saving creates revision ${esc(Number(contract.revision || 1) + 1)}</span></div></div>
    <form method="post" action="/roles/contract">
      <input type="hidden" name="role" value="${esc(spec.role)}">
      <div class="form-grid">
        <div class="field wide"><label for="contract-mandate">Mandate</label><textarea id="contract-mandate" name="mandate" maxlength="1000" placeholder="What this role is accountable for.">${esc(contract.mandate || "")}</textarea></div>
        <div class="field wide"><label for="contract-tools">Authorized tools</label><textarea id="contract-tools" name="contract_tools" placeholder="slack.replyToMention | external-write&#10;knowledge.search | read">${esc(toolLines)}</textarea><span class="help">One tool per line: <code>tool.name | read</code>, <code>internal-write</code>, <code>external-write</code>, <code>destructive</code>, or <code>financial</code>. Data scopes, handoffs, approval floors, and budgets stay in the reviewed advanced JSON.</span></div>
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
    ? "This role has no governed contract yet. Initialize a reviewed v1 contract before requiring contract enforcement."
    : `${summary.mandate || "No mandate recorded."} ${tools.length ? `${tools.length} authorized tool${tools.length === 1 ? "" : "s"}.` : "No tools are authorized."}`;
  return `<section class="notice${summary.status === "governed" ? "" : " warn"}" style="margin-top:16px">
    <div class="card-head"><div><h3>Authority contract</h3><p class="help" style="margin-top:3px">${esc(detail)}</p></div>${pill(summary.status || "legacy", toneFor(summary.status))}</div>
    ${summary.version ? `<p class="help" style="margin-top:8px">v${esc(summary.version)} · revision ${esc(summary.revision)}${summary.fingerprint ? ` · ${esc(String(summary.fingerprint).slice(0, 12))}` : ""}</p>` : ""}
    ${tools.length ? `<p class="help" style="margin-top:8px">Tools: ${tools.map((tool) => `<code>${esc(tool.name || tool)}</code>`).join(" · ")}</p>` : ""}
    ${approvals.length ? `<p class="help" style="margin-top:5px">Host approval: ${approvals.map((impact) => `<code>${esc(impact)}</code>`).join(" · ")}</p>` : ""}
    ${handoffs.send?.length || handoffs.receive?.length ? `<p class="help" style="margin-top:5px">Handoffs: send ${esc((handoffs.send || []).join(", ") || "none")} · receive ${esc((handoffs.receive || []).join(", ") || "none")}</p>` : ""}
    ${budgetParts.length ? `<p class="help" style="margin-top:5px">Budget: ${esc(budgetParts.join(" · "))}</p>` : ""}
  </section>`;
}

function renderDefaults(defaults) {
  return `<section class="card" style="margin-top:16px"><div class="section-heading" style="margin-top:0"><div><h2>Shared defaults</h2><span class="muted">The floor every role inherits</span></div></div><pre>${esc(JSON.stringify(defaults, null, 2))}</pre></section>`;
}

function renderSchedules(models, { canRunNow = false, selectedRole = "", selectedSchedule = "" } = {}) {
  const selected = models.schedules.find((schedule) => schedule.role === selectedRole && schedule.id === selectedSchedule) || null;
  const schedule = selected || {
    role: selectedRole && models.specs[selectedRole] ? selectedRole : Object.keys(models.specs)[0] || "",
    id: "",
    title: "",
    cron: "0 9 * * 1-5",
    prompt: "",
    enabled: true
  };
  const recurrence = recurrenceFromCron(schedule.cron);
  return `
<section class="hero">
  <div><p class="eyebrow">Schedules</p><h1>Schedules</h1><p class="sub">The spec defines what should run; the host owns the scheduler process and execution state.</p></div>
  <a class="button" href="#schedule-editor">Add schedule</a>
</section>
<section class="section-heading"><h2>Declared schedules</h2><span class="muted">${models.schedules.filter((entry) => entry.enabled).length} enabled</span></section>
${renderScheduleTable(models.schedules, { canRunNow, actions: true })}
${canRunNow ? notice("Run once now starts this scheduled task immediately. It does not enable a disabled schedule.") : notice("Run now is available when the crew host is running. The saved timing still uses this host’s local time.", "warn")}
${renderScheduleForm(models, { schedule, selected, recurrence })}`;
}

function renderScheduleForm(models, { schedule, selected, recurrence }) {
  const cadenceOptions = [
    ["daily", "Every day"],
    ["weekdays", "Weekdays"],
    ["weekly", "Every week"],
    ["monthly", "Every month"],
    ["every-days", "Every N days"],
    ...(recurrence.cadence === "advanced" ? [["advanced", "Keep existing advanced schedule"]] : [])
  ];
  return `
<section id="schedule-editor" class="card" style="margin-top:16px">
  <div class="section-heading" style="margin-top:0"><div><h2>${selected ? `Edit ${esc(selected.role)}:${esc(selected.id)}` : "Add a schedule"}</h2><span class="muted">Runs in this host’s local time</span></div></div>
  ${recurrence.cadence === "advanced" ? notice("This schedule already uses an advanced repeat rule. Keep that option to preserve it, or choose a standard repeat rule below to replace it.", "warn") : ""}
  ${Object.keys(models.specs).length ? `<form method="post" action="/schedules/save">
    <input type="hidden" name="previous_role" value="${esc(selected?.role || "")}"><input type="hidden" name="previous_id" value="${esc(selected?.id || "")}"><input type="hidden" name="existing_cron" value="${esc(recurrence.existingCron)}">
    <div class="form-grid three">
      <div class="field"><label for="schedule-role">Role</label>${roleSelect(models, schedule.role, "schedule-role")}</div>
      <div class="field"><label for="schedule-id">Schedule ID</label><input id="schedule-id" name="id" value="${esc(schedule.id)}" placeholder="daily-brief" pattern="[a-z][a-z0-9-]*" required></div>
      <div class="field"><label for="schedule-title">Title</label><input id="schedule-title" name="title" value="${esc(schedule.title || "")}" placeholder="Daily brief"></div>
    </div>
    <div class="form-grid three" style="margin-top:12px">
      <div class="field"><label for="schedule-recurrence">Runs</label><select id="schedule-recurrence" name="recurrence">${cadenceOptions.map(([value, label]) => `<option value="${value}"${value === recurrence.cadence ? " selected" : ""}>${label}</option>`).join("")}</select></div>
      <div class="field"><label for="schedule-time">At</label><input id="schedule-time" name="time" type="time" value="${esc(recurrence.time)}" required></div>
      <div class="field"><label for="schedule-weekday">Weekly on</label><select id="schedule-weekday" name="weekday">${SCHEDULE_WEEKDAYS.map((day) => `<option value="${day.value}"${day.value === recurrence.weekday ? " selected" : ""}>${day.label}</option>`).join("")}</select></div>
      <div class="field"><label for="schedule-month-day">Monthly on day</label><input id="schedule-month-day" name="day_of_month" type="number" min="1" max="31" value="${esc(recurrence.dayOfMonth)}"></div>
      <div class="field"><label for="schedule-interval">Every N days</label><input id="schedule-interval" name="interval_days" type="number" min="2" max="31" value="${esc(recurrence.intervalDays)}"></div>
      <div class="field"><span class="help">Pick the field that matches “Runs.” Only that setting is used.</span></div>
    </div>
    <div class="field" style="margin-top:12px"><label for="schedule-prompt">What should this role do?</label><textarea id="schedule-prompt" name="prompt" placeholder="Prepare the daily brief for review." required>${esc(schedule.prompt)}</textarea></div>
    <label class="checkbox" style="margin-top:12px"><input type="checkbox" name="enabled" value="1"${schedule.enabled ? " checked" : ""}> Enable this schedule</label>
    <div class="button-row" style="margin-top:13px"><button>${selected ? "Save schedule" : "Create schedule"}</button>${selected ? `<a class="button secondary" href="/schedules">Cancel</a>` : ""}</div>
  </form>` : empty("Create a role before adding a schedule.", "Add role", "/roles/new")}
</section>`;
}

function renderScheduleTable(schedules, { compact = false, canRunNow = false, actions = false } = {}) {
  const rows = schedules.map((schedule) => {
    const manage = actions ? `<a class="button secondary tiny" href="/schedules?role=${encodeURIComponent(schedule.role)}&schedule=${encodeURIComponent(schedule.id)}#schedule-editor">Edit</a>
      <form class="inline" method="post" action="/schedules/toggle"><input type="hidden" name="role" value="${esc(schedule.role)}"><input type="hidden" name="id" value="${esc(schedule.id)}"><input type="hidden" name="enabled" value="${schedule.enabled ? "" : "1"}"><button class="subtle tiny">${schedule.enabled ? "Disable" : "Enable"}</button></form>
      <form class="inline" method="post" action="/schedules/delete"><input type="hidden" name="role" value="${esc(schedule.role)}"><input type="hidden" name="id" value="${esc(schedule.id)}"><button class="danger tiny">Delete</button></form>
      ${canRunNow
        ? `<form class="inline" method="post" action="/schedules/run"><input type="hidden" name="role" value="${esc(schedule.role)}"><input type="hidden" name="id" value="${esc(schedule.id)}"><button class="tiny">Run now</button></form>`
        : `<span class="button secondary tiny disabled" title="Start the crew host to run this now">Run now</span>`}` : "";
    return [
      `<code>${esc(schedule.role)}:${esc(schedule.id)}</code>${schedule.title && schedule.title !== schedule.id ? `<div class="faint">${esc(schedule.title)}</div>` : ""}`,
      `${esc(describeScheduleRecurrence(schedule.cron))}<div class="faint">host local time</div>`,
      pill(schedule.enabled ? "enabled" : "disabled", schedule.enabled ? "success" : ""),
      compact ? when(schedule.nextRunAt) : `${esc(schedule.lastStatus || "never ran")}<div class="faint">${when(schedule.lastRunAt)}</div>`,
      compact ? "" : when(schedule.nextRunAt),
      manage
    ];
  });
  const headers = compact ? ["schedule", "timing", "state", "next run"] : ["schedule", "timing", "state", "last outcome", "next run", ""];
  const renderedRows = compact ? rows.map((row) => row.slice(0, 4)) : rows;
  return table(headers, renderedRows, "No schedules declared in any role spec.");
}

function renderSkills(models) {
  const rows = models.skills.map((skill) => [
    `<code>${esc(skill.id)}</code>`, esc(skill.description),
    skill.roles.length ? skill.roles.map((role) => `<code>${esc(role)}</code>`).join(" ") : "all",
    esc(skill.scope)
  ]);
  return `
<section class="hero"><div><p class="eyebrow">Skills</p><h1>Skills</h1><p class="sub">Roles can read approved skills on demand; proposals land in the approval queue.</p></div><a class="button" href="/approvals">Review proposals</a></section>
<section class="section-heading"><h2>Installed skills</h2><span class="muted">${models.skills.length} indexed</span></section>
${table(["skill", "description", "roles", "scope"], rows, "No skills yet — roles can propose them with skill.propose.")}`;
}

function renderApprovals(models, { canDecideApprovals = false } = {}) {
  const hostRows = models.operations.approvals.filter((entry) => entry.status === "pending").map((entry) => [
    pill(entry.kind || "host", toneFor(entry.risk || entry.status)),
    `<code>${esc(entry.id)}</code>`,
    `${esc(entry.title || entry.description || "Approval requested")}${entry.description && entry.title ? `<div class="faint">${esc(entry.description)}</div>` : ""}`,
    esc(entry.requestedBy || entry.role || "host"),
    (entry.source === "crewrun" || canDecideApprovals) ? approvalButtons(entry.id) : '<span class="muted">Host decision required</span>'
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
<section class="hero"><div><p class="eyebrow">Approvals</p><h1>Approvals</h1><p class="sub">This queue combines host action approvals with crewrun skill and memory proposals.</p></div></section>
<section class="section-heading"><h2>Host action approvals</h2><span class="muted">${hostRows.length} pending</span></section>
${table(["kind", "id", "request", "requested by", "decision"], hostRows, "No external actions are awaiting approval. Attach a host approval queue to surface Slack, Gmail, and other connector actions here.")}
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
<section class="section-heading"><h2>Host audit records</h2><span class="muted">${rows.length} safe record${rows.length === 1 ? "" : "s"}</span></section>
${table(["time", "actor / role", "model", "action", "authority", "data", "budget", "outcome"], rows, "No host audit records are attached. Return an audit array from the host operations snapshot to surface governed activity.")}`;
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
  <div class="card flat"><div class="section-heading" style="margin-top:0"><h2>Encrypted secret store</h2></div><p class="usage-amount">${secretsFileExists() ? isUnlocked() ? "Unlocked" : "Locked" : "Not created"}</p><p class="muted" style="margin-top:8px">${secretsLocked ? "Unlock it in the operator process to inspect configured key names." : "Keys are kept out of role prompts and this dashboard."}</p></div>
</section>
<section class="section-heading"><h2>Credential availability</h2><span class="muted">names and state only</span></section>
${table(["provider", "environment name", "state"], keyRows, "No known provider credentials.")}
<section class="section-heading"><h2>Assignable model profiles</h2><span class="muted">${models.runnerOptions.length} available</span></section>
${table(["provider", "profiles", "count"], providerRows, "No runner profiles found.")}
${hostRows.length ? `<section class="section-heading"><h2>Host provider checks</h2></section>${table(["provider", "detail", "state"], hostRows)}` : ""}`;
}

function renderConnectors(models, { canConnect = false, canDisconnect = false } = {}) {
  const hasHostData = models.operations.hasConnectorData;
  return `
<section class="hero"><div><p class="eyebrow">Connectors</p><h1>Integrations</h1><p class="sub">Slack and Gmail connections belong to the host’s OAuth store. Roles receive bounded actions, never OAuth tokens.</p></div></section>
${hasHostData ? "" : notice("No connector host is attached. These cards are safe placeholders: this console will not request or store credentials on its own.")}
<section class="connector-grid" style="margin-top:16px">${models.operations.connectors.map((connector) => renderConnectorCard(connector, { canConnect, canDisconnect })).join("")}</section>`;
}

function renderConnectorCard(connector, { canConnect, canDisconnect }) {
  const state = connector.state || (connector.connected ? "connected" : "not connected");
  const action = connector.connected
    ? canDisconnect
      ? `<form method="post" action="/connectors/disconnect"><input type="hidden" name="id" value="${esc(connector.connectionId || connector.id)}"><button class="secondary">Disconnect</button></form>`
      : `<span class="button secondary disabled">Managed by host</span>`
    : connector.connectUrl && safeHref(connector.connectUrl)
      ? `<a class="button" href="${esc(safeHref(connector.connectUrl))}">Continue connection</a>`
      : canConnect
        ? `<form method="post" action="/connectors/connect"><input type="hidden" name="id" value="${esc(connector.id)}"><button>Connect ${esc(connector.label)}</button></form>`
        : `<span class="button secondary disabled">Host connection required</span>`;
  return `<article class="connector-card">
    <div class="card-head"><div style="display:flex;gap:9px;align-items:center"><span class="connector-icon">${esc(connector.initials || String(connector.label || "?").slice(0, 1).toUpperCase())}</span><div><h2>${esc(connector.label)}</h2><span class="faint">${esc(connector.account || connector.id)}</span></div></div>${pill(state, toneFor(state))}</div>
    <p class="description">${esc(connector.description || "A host-controlled connector.")}</p>
    <p class="capabilities">${(connector.capabilities || []).map((entry) => `<code>${esc(entry)}</code>`).join(" · ") || "No actions advertised"}</p>
    <div class="card-footer">${action}</div>
  </article>`;
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

function runnerSelect(models, selected, id) {
  const known = new Set(models.runnerOptions.map((entry) => entry.id));
  const options = [
    `<option value=""${selected ? "" : " selected"}>Inherit default</option>`,
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
    return readFileSync(path.join(targetRoot, crewDir(), "roles", `${spec.role}.json`), "utf8");
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
