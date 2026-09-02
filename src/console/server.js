import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { crewDir } from "../crew-dirs.js";
import { setScheduleEnabled } from "../schedules.js";
import { approveSkill, rejectSkill } from "../skill-proposals.js";
import { approvePreference, rejectPreference } from "../preference-memory.js";
import { validateRoleSettings, loadRoleSettings } from "../pulse.js";
import { renderPage } from "./shell.js";
import { pageFromUrl } from "./navigation.js";
import { collectModels, renderPartial } from "./pages.js";

// The crewrun console: a local operator surface over one project's .crew/ — roles, schedules,
// skills, and the proposal approvals the consent model needs a human to click. Deliberately an
// operations page, not an assistant: no chat, no vendor coworker UX. Binds 127.0.0.1 only.
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

export function createConsole({ targetRoot, up = null, knownEvents = [], port = 4400, host = "127.0.0.1", log = () => {} } = {}) {
  if (!targetRoot) throw new Error("createConsole requires targetRoot");
  const root = path.resolve(targetRoot);

  async function handleAction(pathname, form) {
    if (pathname === "/roles/save") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid role slug");
      const parsed = JSON.parse(String(form.json || "{}"));
      writeFileSync(specPath(root, role), JSON.stringify(parsed, null, 2) + "\n");
      const { problems } = validateRoleSettings(loadRoleSettings(root), { knownEvents });
      if (problems.length) log(`[console] saved ${role}.json with validation problems: ${problems.join("; ")}`);
      return "/roles";
    }
    if (pathname === "/roles/add") {
      const role = String(form.role || "");
      if (!ROLE_SLUG.test(role)) throw new Error("invalid role slug");
      const file = specPath(root, role);
      if (existsSync(file)) throw new Error(`role ${role} already exists`);
      const spec = {
        ...(form.title ? { title: String(form.title) } : {}),
        ...(form.runner ? { runner: String(form.runner) } : {}),
        memory_pointers: [],
        hooks: []
      };
      writeFileSync(file, JSON.stringify(spec, null, 2) + "\n");
      return "/roles";
    }
    if (pathname === "/schedules/toggle") {
      setScheduleEnabled({ targetRoot: root, id: String(form.id || ""), enabled: Boolean(form.enabled) });
      return "/schedules";
    }
    if (pathname === "/schedules/run") {
      if (!up?.scheduler?.runNow) throw new Error("run-now needs the console attached to a running crew loop");
      void up.scheduler.runNow(String(form.id || "")).catch((error) => log(`[console] run-now failed: ${error.message}`));
      return "/schedules";
    }
    if (pathname === "/proposals/decide") {
      const isSkill = form.kind === "skill";
      const approve = form.action === "approve";
      const fn = approve ? (isSkill ? approveSkill : approvePreference) : (isSkill ? rejectSkill : rejectPreference);
      fn({ targetRoot: root, proposalId: String(form.id || ""), approvedBy: "operator" });
      return "/proposals";
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
      const models = collectModels(root, { knownEvents });
      const html = renderPage(page, renderPartial(page, models, { canRunNow: Boolean(up?.scheduler?.runNow) }), { targetRoot: root, version: VERSION });
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
