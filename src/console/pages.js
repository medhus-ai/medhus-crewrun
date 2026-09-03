import { readFileSync } from "node:fs";

import { listRoleSpecs, readRoleDefaults } from "../role-spec.js";
import { loadRoleSettings, validateRoleSettings, readHeartbeatState } from "../pulse.js";
import { scheduleOverview } from "../schedules.js";
import { listSkills } from "../skills.js";
import { listSkillProposals } from "../skill-proposals.js";
import { listPreferenceProposals, listPreferences } from "../preference-memory.js";
import { runnerIdForRole } from "../runner.js";
import { LEARNING_TOOL_NAMES, WEB_TOOL_NAMES } from "../crew-tools.js";
import { esc } from "./shell.js";

export function collectModels(targetRoot, { knownEvents = [] } = {}) {
  const specs = listRoleSpecs(targetRoot);
  const settings = loadRoleSettings(targetRoot);
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
    preferences: listPreferences({ targetRoot }).effective,
    runnerFor: (role) => runnerIdForRole(role, targetRoot)
  };
}

function table(headers, rows, empty = "Nothing here yet.") {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<table><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function when(value) {
  return value ? esc(String(value).slice(0, 16).replace("T", " ")) : "—";
}

export function renderPartial(page, models, { canRunNow = false } = {}) {
  switch (page) {
    case "roles": return renderRoles(models);
    case "schedules": return renderSchedules(models, canRunNow);
    case "skills": return renderSkills(models);
    case "proposals": return renderProposals(models);
    default: return renderDashboard(models);
  }
}

function renderDashboard(models) {
  const { problems, warnings } = models.validation;
  const pending = models.skillProposals.length + models.prefProposals.length;
  const enabledSchedules = models.schedules.filter((schedule) => schedule.enabled).length;
  const heartbeatsOn = Object.values(models.settings).filter((entry) => entry.heartbeat).length;
  return `
<h1>Dashboard</h1><p class="sub">The crew at a glance.</p>
<div class="card">
  <span class="pill">${Object.keys(models.specs).length} roles</span>
  <span class="pill ${enabledSchedules ? "on" : ""}">${enabledSchedules} schedule${enabledSchedules === 1 ? "" : "s"} enabled</span>
  <span class="pill ${heartbeatsOn ? "on" : ""}">${heartbeatsOn} heartbeat${heartbeatsOn === 1 ? "" : "s"} on</span>
  <span class="pill">${models.skills.length} skills</span>
  <span class="pill ${pending ? "warn" : ""}">${pending} proposal${pending === 1 ? "" : "s"} pending</span>
</div>
<h2>Validation</h2>
${problems.length || warnings.length
    ? [...problems.map((problem) => `<p><span class="pill err">problem</span> ${esc(problem)}</p>`),
       ...warnings.map((warning) => `<p><span class="pill warn">warning</span> ${esc(warning)}</p>`)].join("")
    : '<p class="muted">Role specs are valid.</p>'}
<h2>Approved preferences</h2>
${table(["Key", "Scope", "Statement"], models.preferences.map((entry) => [esc(entry.key), esc(entry.scope), esc(entry.statement)]), "No approved preferences yet.")}
<h2>Built-in tools</h2>
<p class="muted">Always available to every role (a host tool with the same name overrides): ${LEARNING_TOOL_NAMES.map((name) => `<code>${esc(name)}</code>`).join(" · ")}. Per role, when its spec sets <code>"web"</code>: ${WEB_TOOL_NAMES.map((name) => `<code>${esc(name)}</code>`).join(" · ")}. Host tools advertise themselves live at turn time.</p>`;
}

function renderRoles(models) {
  const cards = Object.values(models.specs).map((spec) => {
    const raw = spec.hasSpecFile
      ? readFileSync(`${models.targetRoot}/.crew/roles/${spec.role}.json`, "utf8")
      : JSON.stringify({ title: spec.title, runner: spec.runner, memory_pointers: spec.memory_pointers, hooks: spec.hooks }, null, 2);
    const settings = models.settings[spec.role];
    const heartbeat = settings?.heartbeat ? `every ${settings.heartbeat.intervalSeconds}s${settings.heartbeat.budgetUsdPerDay != null ? ` · cap $${settings.heartbeat.budgetUsdPerDay}/day` : ""}` : "off";
    return `
<div class="card">
  <h2 style="margin-top:0">${esc(spec.role)}${spec.title ? ` — ${esc(spec.title)}` : ""}</h2>
  <p class="muted">runner <code>${esc(models.runnerFor(spec.role) || "(provider default)")}</code>
   · heartbeat <span class="pill ${settings?.heartbeat ? "on" : ""}">${esc(heartbeat)}</span>
   · hooks ${spec.hooks.length ? spec.hooks.map((hook) => `<code>${esc(hook)}</code>`).join(" ") : '<span class="muted">none</span>'}
   · reflections ${spec.reflections === false ? "off" : `last ${spec.reflections.limit}`}
   · web <span class="pill ${spec.web ? "on" : ""}">${spec.web ? esc(`${spec.web.search ? "fetch + search" : "fetch"}${spec.web.allow.length ? ` · ${spec.web.allow.join(", ")}` : " · open"}`) : "off"}</span></p>
  <p class="muted">pointers: ${spec.memory_pointers.map((pointer) => `<code>${esc(pointer)}</code>`).join(" ") || "none"}</p>
  <form method="post" action="/roles/save">
    <input type="hidden" name="role" value="${esc(spec.role)}">
    <textarea name="json">${esc(raw)}</textarea><br>
    <button>Save ${esc(spec.role)}.json</button>
    <span class="muted">writes .crew/roles/${esc(spec.role)}.json and re-validates</span>
  </form>
</div>`;
  }).join("");
  return `
<h1>Roles</h1><p class="sub">Each role is one JSON spec; _defaults.json supplies the shared floor.</p>
<div class="card">
  <form method="post" action="/roles/add">
    <b>Add role</b>&nbsp;
    slug <input name="role" placeholder="analyst" pattern="[a-z][a-z0-9-]*" required>
    title <input name="title" placeholder="Analyst">
    runner <input name="runner" placeholder="(inherit default)">
    <button>Create</button>
  </form>
</div>
${cards}
<h2>_defaults.json</h2>
<pre>${esc(JSON.stringify(models.defaults, null, 2))}</pre>`;
}

function renderSchedules(models, canRunNow) {
  const rows = models.schedules.map((schedule) => [
    `<code>${esc(schedule.role)}:${esc(schedule.id)}</code>`,
    `<code>${esc(schedule.cron)}</code>`,
    `<span class="pill ${schedule.enabled ? "on" : ""}">${schedule.enabled ? "enabled" : "disabled"}</span>`,
    esc(schedule.lastStatus || "never ran"),
    when(schedule.lastRunAt),
    when(schedule.nextRunAt),
    `<form class="inline" method="post" action="/schedules/toggle"><input type="hidden" name="id" value="${esc(schedule.id)}"><input type="hidden" name="enabled" value="${schedule.enabled ? "" : "1"}"><button class="subtle">${schedule.enabled ? "Disable" : "Enable"}</button></form>` +
    (canRunNow ? `<form class="inline" method="post" action="/schedules/run"><input type="hidden" name="id" value="${esc(schedule.id)}"><button>Run now</button></form>` : "")
  ]);
  return `
<h1>Schedules</h1><p class="sub">Declared inside each role's spec; run state lives in the crew home.${canRunNow ? "" : " Run-now needs the console attached to a running loop (crewrun up --console)."}</p>
${table(["schedule", "cron", "state", "last outcome", "last run", "next run", ""], rows, "No schedules declared in any role spec.")}`;
}

function renderSkills(models) {
  const rows = models.skills.map((skill) => [
    `<code>${esc(skill.id)}</code>`, esc(skill.description),
    skill.roles.length ? skill.roles.map((role) => `<code>${esc(role)}</code>`).join(" ") : "all",
    esc(skill.scope)
  ]);
  return `
<h1>Skills</h1><p class="sub">Loaded on demand with <code>skill.read</code>; the index below is what every prompt carries. Regenerate the repo copy with <code>crewrun skills index --write</code>.</p>
${table(["skill", "description", "roles", "scope"], rows, "No skills yet — roles can propose them with skill.propose.")}`;
}

function renderProposals(models) {
  const rows = [
    ...models.skillProposals.map((proposal) => ["skill", proposal]),
    ...models.prefProposals.map((proposal) => ["pref", proposal])
  ].map(([kind, proposal]) => [
    `<span class="pill">${kind}</span>`,
    `<code>${esc(proposal.id)}</code>`,
    esc(kind === "skill" ? `${proposal.skillId} — ${proposal.description}` : `${proposal.key} — ${proposal.statement}`),
    esc(proposal.proposedBy || ""),
    `<form class="inline" method="post" action="/proposals/decide"><input type="hidden" name="id" value="${esc(proposal.id)}"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="action" value="approve"><button>Approve</button></form>
     <form class="inline" method="post" action="/proposals/decide"><input type="hidden" name="id" value="${esc(proposal.id)}"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="action" value="reject"><button class="danger">Reject</button></form>`
  ]);
  return `
<h1>Proposals</h1><p class="sub">Agent-proposed skills and preferences wait here for the operator. Approving a skill writes .crew/skills/&lt;id&gt;.md and regenerates the index; approving a preference makes it part of every future turn.</p>
${table(["", "id", "proposal", "by", "decision"], rows, "No pending proposals.")}`;
}
