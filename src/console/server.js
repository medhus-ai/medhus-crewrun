import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { crewDir } from "../crew-dirs.js";
import { cronFromRecurrence, listSchedules, normalizeSchedule, removeSchedule, upsertSchedule } from "../schedules.js";
import { approveSkill, rejectSkill } from "../skill-proposals.js";
import { approvePreference, rejectPreference } from "../preference-memory.js";
import { approveReflection, rejectReflection } from "../reflection-proposals.js";
import { approveAction, getActionApproval, listActionApprovals, rejectAction } from "../action-approvals.js";
import { normalizeRoleContract } from "../role-contract.js";
import { validateRoleSettings, loadRoleSettings } from "../pulse.js";
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
// console still works (and never asks for OAuth credentials) without it.
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
  return path.join(path.resolve(targetRoot), crewDir(), "roles", `${role}.json`);
}

function defaultsPath(targetRoot) {
  return path.join(path.resolve(targetRoot), crewDir(), "roles", "_defaults.json");
}

function readSpec(file) {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("role spec must be a JSON object");
  return parsed;
}

function writeSpec(file, spec) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(spec, null, 2) + "\n");
}

function lines(value) {
  return [...new Set(String(value || "").split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))];
}

function contractTools(value) {
  return lines(value).map((line) => {
    const parts = line.split("|").map((entry) => entry.trim());
    if (parts.length > 2 || !parts[0]) throw new Error("each contract tool must be tool.name | impact");
    const [name, impact] = parts;
    return { name, ...(impact ? { impact } : {}) };
  });
}

function initialContract(role, title = "") {
  return normalizeRoleContract({
    version: 1,
    revision: 1,
    mandate: title ? `Operate as ${title}.` : "",
    authority: { tools: [] }
  }, { role });
}

function persistedContract(contract) {
  const { role: _role, ...value } = contract;
  return value;
}

function roleUrl(role) {
  return "/roles/" + encodeURIComponent(role);
}

function roleRoute(url) {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "roles") return null;
  if (segments.length === 1) {
    const selectedRole = String(url.searchParams.get("role") || "");
    return ROLE_SLUG.test(selectedRole) ? { view: "detail", selectedRole } : { view: "list", selectedRole: "" };
  }
  if (segments.length === 2 && segments[1] === "new") return { view: "create", selectedRole: "" };
  if (segments.length === 2 && ROLE_SLUG.test(segments[1])) return { view: "detail", selectedRole: segments[1] };
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

  async function snapshot() {
    // The kernel's small host-local approval queue is useful even without a product host. A
    // host snapshot may add its own queue; IDs are de-duplicated in the host's favor.
    const coreApprovals = listActionApprovals({ targetRoot: root, env }).map((approval) => ({ ...approval, source: "crewrun" }));
    try {
      const getter = typeof operations === "function" ? operations : operations?.getSnapshot || operations?.snapshot;
      const value = typeof getter === "function" ? await getter({ targetRoot: root }) : operations;
      const hostSnapshot = value && typeof value === "object" ? value : {};
      const merged = new Map(coreApprovals.map((approval) => [approval.id, approval]));
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
    if (pathname === "/roles/save") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid role slug");
      const parsed = JSON.parse(String(form.json || "{}"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("role spec must be a JSON object");
      writeSpec(specPath(root, role), parsed);
      const { problems } = validateRoleSettings(loadRoleSettings(root), { knownEvents });
      if (problems.length) log(`[console] saved ${role}.json with validation problems: ${problems.join("; ")}`);
      return roleUrl(role);
    }
    if (pathname === "/roles/update") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid role slug");
      const file = specPath(root, role);
      const spec = readSpec(file);
      const title = String(form.title || "").trim();
      const runner = String(form.runner || "").trim();
      if (title.length > 160) throw new Error("role title must be at most 160 characters");
      if (runner.length > 120) throw new Error("runner id must be at most 120 characters");
      if (title) spec.title = title;
      else delete spec.title;
      if (runner) spec.runner = runner;
      else delete spec.runner;
      spec.memory_pointers = lines(form.memory_pointers);
      writeSpec(file, spec);
      return roleUrl(role);
    }
    if (pathname === "/roles/contract") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid role slug");
      const file = specPath(root, role);
      const spec = readSpec(file);
      const existing = spec.contract ? normalizeRoleContract(spec.contract, { role }) : initialContract(role, spec.title || "");
      const next = normalizeRoleContract({
        ...existing,
        revision: existing.revision + 1,
        mandate: String(form.mandate || ""),
        authority: { ...existing.authority, tools: contractTools(form.contract_tools) }
      }, { role });
      spec.contract = persistedContract(next);
      writeSpec(file, spec);
      return roleUrl(role);
    }
    if (pathname === "/roles/initialize-contract") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid role slug");
      const file = specPath(root, role);
      const spec = readSpec(file);
      if (spec.contract) throw new Error(`${role} already has a role-specific contract`);
      spec.contract = persistedContract(initialContract(role, spec.title || ""));
      writeSpec(file, spec);
      return roleUrl(role);
    }
    if (pathname === "/roles/add") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid role slug");
      const file = specPath(root, role);
      if (existsSync(file)) throw new Error(`role ${role} already exists`);
      const title = String(form.title || "").trim();
      const runner = String(form.runner || "").trim();
      const spec = {
        ...(title ? { title } : {}),
        ...(runner ? { runner } : {}),
        memory_pointers: [],
        hooks: [],
        contract: persistedContract(initialContract(role, title))
      };
      writeSpec(file, spec);
      return roleUrl(role);
    }
    if (pathname === "/roles/defaults/update") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid role slug");
      const file = defaultsPath(root);
      const defaults = readSpec(file);
      const runner = String(form.runner || "").trim();
      if (runner.length > 120) throw new Error("runner id must be at most 120 characters");
      if (runner) defaults.runner = runner;
      else delete defaults.runner;
      defaults.memory_pointers = lines(form.memory_pointers);
      writeSpec(file, defaults);
      return roleUrl(role);
    }
    if (pathname === "/roles/defaults/save") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid role slug");
      const parsed = JSON.parse(String(form.json || "{}"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shared defaults must be a JSON object");
      if (parsed.contract != null) normalizeRoleContract(parsed.contract, { role: "" });
      writeSpec(defaultsPath(root), parsed);
      const { problems } = validateRoleSettings(loadRoleSettings(root), { knownEvents });
      if (problems.length) log("[console] saved _defaults.json with validation problems: " + problems.join("; "));
      return roleUrl(role);
    }
    if (pathname === "/schedules/save") {
      const role = String(form.role || "").trim();
      const id = String(form.id || "").trim();
      const previousRole = String(form.previous_role || "").trim();
      const previousId = String(form.previous_id || "").trim();
      // Validate before replacing a renamed schedule, so a typo in cron never
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
      const schedule = normalizeSchedule({
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
      upsertSchedule({ targetRoot: root, schedule });
      return `/schedules?role=${encodeURIComponent(role)}&schedule=${encodeURIComponent(id)}`;
    }
    if (pathname === "/schedules/toggle") {
      const role = String(form.role || "").trim();
      const id = String(form.id || "").trim();
      const schedule = listSchedules({ targetRoot: root }).find((entry) => entry.id === id && (!role || entry.role === role));
      if (!schedule) throw new Error(`schedule ${id} was not found`);
      upsertSchedule({ targetRoot: root, schedule: { ...schedule, enabled: form.enabled === "1" } });
      return "/schedules";
    }
    if (pathname === "/schedules/delete") {
      const removed = removeSchedule({ targetRoot: root, role: String(form.role || ""), id: String(form.id || "") });
      if (!removed) throw new Error("schedule was not found");
      return "/schedules";
    }
    if (pathname === "/schedules/run") {
      if (!up?.scheduler?.runNow) throw new Error("run-now needs the console attached to a running crew loop");
      void up.scheduler.runNow({ role: String(form.role || ""), id: String(form.id || "") }).catch((error) => log(`[console] run-now failed: ${error.message}`));
      return "/schedules";
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
      fn({ targetRoot: root, proposalId: String(form.id || ""), approvedBy: "operator" });
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
        return "/approvals";
      }
      return callOperation(["decideApproval", "decide"], { id: String(form.id || ""), action: String(form.action || "") }, "/approvals");
    }
    if (pathname === "/connectors/connect") {
      return callOperation(["connect", "connectConnector"], { connectorId: String(form.id || "") }, "/connectors");
    }
    if (pathname === "/connectors/disconnect") {
      return callOperation(["disconnect", "disconnectConnector"], { connectorId: String(form.id || "") }, "/connectors");
    }
    throw new Error("unknown action");
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://console");
      if (request.method === "POST") {
        const form = await parseBody(request);
        const back = await handleAction(url.pathname, form);
        response.writeHead(303, { location: back }).end();
        return;
      }
      const page = pageFromUrl(url.pathname);
      if (!page) { response.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
      const roles = page === "roles" ? roleRoute(url) : null;
      if (page === "roles" && !roles) { response.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
      const hostOperations = await snapshot();
      const models = collectModels(root, { knownEvents, operations: hostOperations });
      const roleSubpage = roles?.view === "create" || roles?.view === "detail";
      const html = renderPage(page, renderPartial(page, models, {
        canRunNow: Boolean(up?.scheduler?.runNow),
        selectedRole: roles?.selectedRole || String(url.searchParams.get("role") || ""),
        roleView: roles?.view || "list",
        selectedSchedule: String(url.searchParams.get("schedule") || url.searchParams.get("id") || ""),
        canConnect: Boolean(operation(["connect", "connectConnector"])),
        canDisconnect: Boolean(operation(["disconnect", "disconnectConnector"])),
        canDecideApprovals: Boolean(operation(["decideApproval", "decide"]))
          || Array.isArray(hostOperations.approvals) && hostOperations.approvals.some((approval) => approval?.source === "crewrun" && approval?.status === "pending")
      }), {
        targetRoot: root,
        version: VERSION,
        backHref: roleSubpage ? "/roles" : page === "dashboard" ? "" : "/",
        backLabel: roleSubpage ? "Back to roles" : "Back to dashboard"
      });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain" }).end(`error: ${error.message}`);
    }
  });

  return {
    server,
    listen: () => new Promise((resolve) => server.listen(port, host, () => {
      log(`[console] http://${host}:${server.address().port}/`);
      resolve(server.address().port);
    })),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
