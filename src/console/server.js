import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { agentFile } from "../agent-paths.js";
import { cronFromRecurrence, listSchedules, normalizeSchedule, removeSchedule, upsertSchedule } from "../schedules.js";
import { approveSkill, rejectSkill } from "../skill-proposals.js";
import { approvePreference, rejectPreference } from "../preference-memory.js";
import { approveReflection, rejectReflection } from "../reflection-proposals.js";
import { approveAction, getActionApproval, listActionApprovals, rejectAction } from "../action-approvals.js";
import { normalizeRoleContract } from "../role-contract.js";
import { readAgentSpecForEditing, roleScheduledEntries } from "../role-spec.js";
import { parseInterval, validateRoleSettings, loadRoleSettings } from "../pulse.js";
import { createStandaloneRuntime } from "../standalone.js";
import { renderPage } from "./shell.js";
import { pageFromUrl } from "./navigation.js";
import { collectModels, renderPartial } from "./pages.js";

// The crewrun console is a local operator surface over one project's .crew/.
// `operations` is optional host integration:
// {
//   getSnapshot?: ({ targetRoot }) => { usage, providers, connectors, approvals, contracts },
//   connect?: ({ targetRoot, connectorId }), disconnect?: (...),
//   decideApproval?: ({ targetRoot, id, action })
// }
// It is deliberately data/action shaped rather than a product dependency. The
// console uses the standalone local connector adapter when none is supplied.
const ROLE_SLUG = /^[a-z][a-z0-9-]{0,79}$/;
const VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")).version; } catch { return ""; }
})();

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; if (body.length > 1_000_000) request.destroy(); });
    request.on("end", () => resolve(Object.fromEntries(new URLSearchParams(body))));
    request.on("error", reject);
  });
}

function specPath(targetRoot, role) {
  return agentFile(targetRoot, role);
}

function defaultsPath(targetRoot) {
  return agentFile(targetRoot, "_defaults");
}

function readSpec(file) {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("agent spec must be a JSON object");
  return parsed;
}

function writeSpec(file, spec) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(spec, null, 2) + "\n");
}

function lines(value) {
  return [...new Set(String(value || "").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))];
}

function contractTools(value, existing = []) {
  return lines(value).map((line) => {
    const parts = line.split("|").map((entry) => entry.trim());
    if (parts.length > 2 || !parts[0]) throw new Error("each contract tool must be tool.name | impact");
    const [name, impact] = parts;
    return { ...existing.find((tool) => tool.name === name), name, ...(impact ? { impact } : {}) };
  });
}

function initialContract(role, title = "") {
  return normalizeRoleContract({
    version: 1,
    revision: 1,
    mandate: title ? `Operate as ${title}.` : "",
    authority: { tools: [{ name: "skill.read", impact: "read" }, ...["memory.reflect", "skill.propose", "prefs.propose"].map((name) => ({ name, impact: "internal-write" }))] }
  }, { role });
}

function persistedContract(contract) {
  const { role: _role, ...value } = contract;
  return value;
}

function roleUrl(role, tab = "manage") {
  const href = "/agents/" + encodeURIComponent(role);
  return tab === "defaults" ? href + "?tab=defaults" : href;
}

function roleRoute(url) {
  const segments = url.pathname.split("/").filter(Boolean);
  if (!["agents", "roles"].includes(segments[0])) return null;
  const roleTab = url.searchParams.get("tab") === "defaults" ? "defaults" : "manage";
  if (segments.length === 1) {
    const selectedRole = String(url.searchParams.get("role") || "");
    return ROLE_SLUG.test(selectedRole) ? { view: "detail", selectedRole, roleTab } : { view: "list", selectedRole: "", roleTab: "manage" };
  }
  if (segments.length === 2 && segments[1] === "new") return { view: "create", selectedRole: "", roleTab: "manage" };
  if (segments.length === 2 && ROLE_SLUG.test(segments[1])) return { view: "detail", selectedRole: segments[1], roleTab };
  return null;
}

function redirectTarget(value, fallback) {
  const target = String(value || "").trim();
  if (!target || /[\r\n]/.test(target)) return fallback;
  // An OAuth connection may leave localhost for a provider, but arbitrary URI
  // schemes are never allowed into a response header.
  return /^(?:https?:\/\/|\/(?!\/))/.test(target) ? target : fallback;
}

export function createConsole({ targetRoot, up = null, knownEvents = [], operations = null, port = 4400, host = "127.0.0.1", env = process.env, log = () => {} } = {}) {
  if (!targetRoot) throw new Error("createConsole requires targetRoot");
  const root = path.resolve(targetRoot);
  const standalone = !operations && !up?.operations ? createStandaloneRuntime({ targetRoot: root, env, log }) : null;
  operations ||= up?.operations || standalone?.operations;

  async function snapshot() {
    // The kernel's small host-local approval queue is useful even without a product host. A
    // host snapshot may add its own queue; IDs are de-duplicated in the host's favor.
    const coreApprovals = listActionApprovals({ targetRoot: root, env }).map((approval) => ({ ...approval, source: "crewrun" }));
    try {
      const getter = typeof operations === "function" ? operations : operations?.getSnapshot || operations?.snapshot;
      const value = typeof getter === "function" ? await getter({ targetRoot: root }) : operations;
      const hostSnapshot = value && typeof value === "object" ? value : {};
      const merged = new Map(coreApprovals.filter((a) => !(hostSnapshot.supersededApprovalIds || []).includes(a.id)).map((approval) => [approval.id, approval]));
      for (const approval of Array.isArray(hostSnapshot.approvals) ? hostSnapshot.approvals : []) {
        if (approval && typeof approval === "object") merged.set(String(approval.id || ""), approval);
      }
      return { ...hostSnapshot, approvals: [...merged.values()] };
    } catch (error) {
      // A host dashboard integration should never take away the local role UI.
      log(`[console] host snapshot unavailable: ${error.message}`);
      return { approvals: coreApprovals };
    }
  }

  function operation(names) {
    for (const name of names) {
      const fn = operations?.[name] || operations?.actions?.[name];
      if (typeof fn === "function") return fn;
    }
    return null;
  }

  async function callOperation(names, payload, fallback) {
    const fn = operation(names);
    if (!fn) throw new Error(`${names[0]} needs a console host integration`);
    const result = await fn({ targetRoot: root, ...payload });
    return redirectTarget(result?.redirect || result?.url || result, fallback);
  }

  async function handleAction(pathname, form) {
    // Keep old console forms and bookmarks working while the operator surface
    // calls these Scheduled tasks.
    pathname = pathname.replace(/^\/agents(?=\/|$)/, "/roles");
    pathname = pathname.replace(/^\/schedules(?=\/|$)/, "/scheduled");
    if (pathname === "/roles/save") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid agent slug");
      const parsed = JSON.parse(String(form.json || "{}"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("agent spec must be a JSON object");
      roleScheduledEntries(parsed);
      writeSpec(specPath(root, role), parsed);
      const { problems } = validateRoleSettings(loadRoleSettings(root), { knownEvents });
      if (problems.length) log(`[console] saved ${role}.json with validation problems: ${problems.join("; ")}`);
      return roleUrl(role);
    }
    if (pathname === "/roles/update") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid agent slug");
      const file = specPath(root, role);
      const spec = readAgentSpecForEditing(root, role);
      const title = String(form.title || "").trim();
      const runner = String(form.runner || "").trim();
      if (title.length > 160) throw new Error("agent title must be at most 160 characters");
      if (runner.length > 120) throw new Error("runner id must be at most 120 characters");
      if (title) spec.title = title;
      else delete spec.title;
      if (runner) spec.runner = runner;
      else delete spec.runner;
      spec.memory_pointers = lines(form.memory_pointers);
      if (Object.hasOwn(form, "instructions")) spec.instructions = String(form.instructions).slice(0, 20_000);
      writeSpec(file, spec);
      return roleUrl(role);
    }
    if (pathname === "/roles/behavior") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid agent slug");
      const file = specPath(root, role);
      const spec = readAgentSpecForEditing(root, role);
      const interval = String(form.heartbeat || "off").trim();
      const seconds = parseInterval(interval);
      if (Number.isNaN(seconds) || seconds !== null && (seconds < 1 || seconds > 31_536_000)) throw new Error("Use a heartbeat such as 30m, 2h, or off.");
      const limit = Number(form.reflection_limit || 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Reflection limit must be between 1 and 100.");
      if (form.reflections === "inherit") delete spec.reflections;
      else spec.reflections = form.reflections === "off" ? false : { limit };
      if (form.web === "inherit") delete spec.web;
      else if (form.web === "off") spec.web = false;
      else {
        const allow = lines(form.web_allow);
        if (allow.some((domain) => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain))) throw new Error("Enter website domains only, such as docs.example.com.");
        spec.web = { ...(typeof spec.web === "object" ? spec.web : {}), allow };
      }
      if (form.heartbeat_mode === "inherit") delete spec.heartbeat;
      else spec.heartbeat = { ...(typeof spec.heartbeat === "object" ? spec.heartbeat : {}), interval, prompt: String(form.heartbeat_prompt || "").slice(0, 20_000) };
      writeSpec(file, spec);
      return roleUrl(role);
    }
    if (pathname === "/roles/contract") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid agent slug");
      const file = specPath(root, role);
      const spec = readAgentSpecForEditing(root, role);
      const existing = spec.contract ? normalizeRoleContract(spec.contract, { role }) : initialContract(role, spec.title || "");
      const next = normalizeRoleContract({
        ...existing,
        revision: existing.revision + 1,
        mandate: String(form.mandate || ""),
        authority: {
          ...existing.authority,
          tools: contractTools(form.contract_tools, existing.authority.tools),
          data: {
            read: Object.hasOwn(form, "data_read") ? lines(form.data_read) : existing.authority.data.read,
            write: Object.hasOwn(form, "data_write") ? lines(form.data_write) : existing.authority.data.write
          }
        }
      }, { role });
      spec.contract = persistedContract(next);
      writeSpec(file, spec);
      return roleUrl(role);
    }
    if (pathname === "/roles/initialize-contract") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid agent slug");
      const file = specPath(root, role);
      const spec = readAgentSpecForEditing(root, role);
      if (spec.contract) throw new Error(`${role} already has an agent-specific contract`);
      spec.contract = persistedContract(initialContract(role, spec.title || ""));
      writeSpec(file, spec);
      return roleUrl(role);
    }
    if (pathname === "/roles/add") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid agent slug");
      const file = specPath(root, role);
      if (existsSync(file)) throw new Error(`agent ${role} already exists`);
      const title = String(form.title || "").trim();
      const runner = String(form.runner || "").trim();
      const spec = {
        ...(title ? { title } : {}),
        ...(runner ? { runner } : {}),
        memory_pointers: [],
        instructions: String(form.instructions || "").slice(0, 20_000),
        hooks: [],
        contract: persistedContract(initialContract(role, title))
      };
      writeSpec(file, spec);
      return roleUrl(role);
    }
    if (pathname === "/roles/defaults/update") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid agent slug");
      const file = defaultsPath(root);
      const defaults = readSpec(file);
      const runner = String(form.runner || "").trim();
      if (runner.length > 120) throw new Error("runner id must be at most 120 characters");
      if (runner) defaults.runner = runner;
      else delete defaults.runner;
      defaults.memory_pointers = lines(form.memory_pointers);
      writeSpec(file, defaults);
      return roleUrl(role, "defaults");
    }
    if (pathname === "/roles/defaults/save") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid agent slug");
      const parsed = JSON.parse(String(form.json || "{}"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shared defaults must be a JSON object");
      if (parsed.contract != null) normalizeRoleContract(parsed.contract, { role: "" });
      writeSpec(defaultsPath(root), parsed);
      const { problems } = validateRoleSettings(loadRoleSettings(root), { knownEvents });
      if (problems.length) log("[console] saved _defaults.json with validation problems: " + problems.join("; "));
      return roleUrl(role, "defaults");
    }
    if (pathname === "/scheduled/save") {
      const role = String(form.role || "").trim();
      const id = String(form.id || "").trim();
      const previousRole = String(form.previous_role || "").trim();
      const previousId = String(form.previous_id || "").trim();
      // Validate before replacing a renamed task, so a typo in cron never
      // destroys the existing declaration.
      const cron = form.recurrence
        ? cronFromRecurrence({
          cadence: form.recurrence,
          time: form.time,
          weekday: form.weekday,
          dayOfMonth: form.day_of_month,
          intervalDays: form.interval_days,
          existingCron: form.existing_cron
        })
        : String(form.cron || "").trim();
      const task = normalizeSchedule({
        role,
        id,
        title: String(form.title || "").trim(),
        cron,
        prompt: String(form.prompt || "").trim(),
        enabled: form.enabled === "1"
      });
      if (previousId && (previousRole !== role || previousId !== id)) {
        removeSchedule({ targetRoot: root, role: previousRole, id: previousId });
      }
      upsertSchedule({ targetRoot: root, schedule: task });
      return `/scheduled?role=${encodeURIComponent(role)}&task=${encodeURIComponent(id)}`;
    }
    if (pathname === "/scheduled/toggle") {
      const role = String(form.role || "").trim();
      const id = String(form.id || "").trim();
      const task = listSchedules({ targetRoot: root }).find((entry) => entry.id === id && (!role || entry.role === role));
      if (!task) throw new Error(`task ${id} was not found`);
      upsertSchedule({ targetRoot: root, schedule: { ...task, enabled: form.enabled === "1" } });
      return "/scheduled";
    }
    if (pathname === "/scheduled/delete") {
      const removed = removeSchedule({ targetRoot: root, role: String(form.role || ""), id: String(form.id || "") });
      if (!removed) throw new Error("task was not found");
      return "/scheduled";
    }
    if (pathname === "/scheduled/run") {
      if (!up?.scheduler?.runNow) throw new Error("run task now needs the console attached to a running crew loop");
      void Promise.resolve(up.scheduler.runNow({ role: String(form.role || ""), id: String(form.id || "") })).catch((error) => log(`[console] run-now failed: ${error.message}`));
      return "/scheduled";
    }
    if (pathname === "/proposals/decide") {
      const approve = form.action === "approve";
      const kind = String(form.kind || "");
      const handlers = {
        skill: approve ? approveSkill : rejectSkill,
        pref: approve ? approvePreference : rejectPreference,
        reflection: approve ? approveReflection : rejectReflection
      };
      const fn = handlers[kind];
      if (!fn) throw new Error("proposal kind must be skill, pref, or reflection");
      fn({ targetRoot: root, proposalId: String(form.id || ""), approvedBy: "operator", target: form.target, key: form.key, description: form.description, env });
      return "/approvals";
    }
    if (pathname === "/approvals/decide") {
      const approvalId = String(form.id || "");
      const action = String(form.action || "").trim().toLowerCase();
      const local = getActionApproval({ targetRoot: root, approvalId, env });
      if (local) {
        if (action === "approve") approveAction({ targetRoot: root, approvalId, approvedBy: "operator", env });
        else if (action === "reject") rejectAction({ targetRoot: root, approvalId, rejectedBy: "operator", env });
        else throw new Error("approval action must be approve or reject");
        await operation(["afterApproval"])?.({ id: approvalId, action });
        return "/approvals";
      }
      return callOperation(["decideApproval", "decide"], { id: String(form.id || ""), action: String(form.action || "") }, "/approvals");
    }
    if (pathname === "/connectors/connect") {
      return callOperation(["connect", "connectConnector"], { connectorId: String(form.id || ""), credentials: form }, "/connectors");
    }
    if (pathname === "/connectors/disconnect") {
      return callOperation(["disconnect", "disconnectConnector"], { connectorId: String(form.id || "") }, "/connectors");
    }
    if (pathname === "/tasks/create") return callOperation(["enqueueTask"], { agent: String(form.agent || ""), prompt: String(form.prompt || ""), dependencies: form.dependency ? [String(form.dependency)] : [] }, "/tasks");
    if (pathname === "/tasks/control") return callOperation(["controlTask"], { id: String(form.id || ""), action: String(form.action || "") }, "/tasks");
    if (pathname === "/tasks/check-delivery") return callOperation(["checkDelivery"], { id: String(form.id || "") }, "/tasks");
    if (pathname === "/tasks/reconcile") return callOperation(["reconcileAction"], { id: String(form.id || ""), outcome: String(form.outcome || ""), evidence: String(form.evidence || ""), receipt: form.receipt ? { reference: String(form.receipt) } : null }, "/tasks");
    throw new Error("unknown action");
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    try {
      const url = new URL(request.url, "http://console");
      // The console owns local credentials and outgoing approvals. Reject browser
      // requests from another origin, including DNS rebinding onto loopback.
      const authority = request.headers.host || "";
      const expected = `${host}:${server.address()?.port}`;
      if (authority !== expected && authority !== `localhost:${server.address()?.port}`) {
        response.writeHead(403).end("Invalid console host"); return;
      }
      if (request.method === "POST" && ((request.headers.origin && request.headers.origin !== `http://${authority}`) || request.headers["sec-fetch-site"] === "cross-site")) {
        response.writeHead(403).end("Open the console directly to make changes"); return;
      }
      if (request.method === "POST") {
        const form = await parseBody(request);
        const back = await handleAction(url.pathname, form);
        response.writeHead(303, { location: back }).end();
        return;
      }
      if (url.pathname === "/tasks/artifact") {
        const data = await snapshot();
        const artifact = (data.runs || []).flatMap((r) => r.artifacts || []).find((a) => a.id === url.searchParams.get("id"));
        if (!artifact) { response.writeHead(404).end("Artifact not found"); return; }
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-disposition": 'attachment; filename="crewrun-result.txt"' }).end(artifact.content); return;
      }
      const page = pageFromUrl(url.pathname);
      if (!page) { response.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
      const roles = page === "agents" ? roleRoute(url) : null;
      if (page === "agents" && !roles) { response.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
      const hostOperations = await snapshot();
      const models = collectModels(root, { knownEvents, operations: hostOperations });
      const roleSubpage = roles?.view === "create" || roles?.view === "detail";
      const html = renderPage(page, renderPartial(page, models, {
        selectedRun: String(url.searchParams.get("run") || ""),
        canManageTasks: Boolean(operation(["enqueueTask"])),
        canRunNow: Boolean(up?.scheduler?.runNow),
        selectedRole: roles?.selectedRole || String(url.searchParams.get("role") || ""),
        roleView: roles?.view || "list",
        roleTab: roles?.roleTab || "manage",
        agentSearch: String(url.searchParams.get("q") || ""),
        selectedTask: String(url.searchParams.get("task") || url.searchParams.get("schedule") || url.searchParams.get("id") || ""),
        showTaskEditor: url.searchParams.get("new") === "1",
        canConnect: Boolean(operation(["connect", "connectConnector"])),
        canDisconnect: Boolean(operation(["disconnect", "disconnectConnector"])),
        canDecideApprovals: Boolean(operation(["decideApproval", "decide"]))
          || Array.isArray(hostOperations.approvals) && hostOperations.approvals.some((approval) => approval?.source === "crewrun" && approval?.status === "pending")
      }), {
        targetRoot: root,
        version: VERSION,
        backHref: roleSubpage ? "/agents" : page === "dashboard" ? "" : "/",
        backLabel: roleSubpage ? "Back to agents" : "Back to dashboard"
      });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain" }).end(`error: ${error.message}`);
    }
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => {
      server.removeListener("error", reject);
      standalone?.start();
      log(`[console] http://${host}:${server.address().port}/`);
      resolve(server.address().port);
    }); }),
    close: async () => { await standalone?.close(); return new Promise((resolve) => server.close(resolve)); }
  };
}
