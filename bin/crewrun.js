#!/usr/bin/env node
// v6 workspace CLI; the bundled host is the only execution path.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRoleSettings, validateRoleSettings } from "../src/pulse.js";
import { writeSkillIndexFile, renderSkillIndexFile } from "../src/skills.js";
import { approveSkill, listSkillProposals, rejectSkill } from "../src/skill-proposals.js";
import { approvePreference, listPreferenceProposals, rejectPreference } from "../src/preference-memory.js";
import { approveReflection, listReflectionProposals, rejectReflection } from "../src/reflection-proposals.js";
import { createUp } from "../src/up.js";
import { createConsole } from "../src/console/server.js";
import { initializeWorkspace } from "../src/workspace-setup.js";
import { requireWorkspace, LIFECYCLE_EVENTS } from "../src/workspace-manifest.js";
import { installIntegrationPlugin, listInstalledPlugins, scaffoldIntegrationPlugin } from "../src/integration-plugins.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : undefined;
}

// Flags may appear before or after the project. Do not mistake a flag's value (such as a host
// module or port number) for the target root.
function targetArgument(args, valueFlags = []) {
  const values = new Set(valueFlags);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (values.has(value)) { index += 1; continue; }
    if (!value.startsWith("-")) return value;
  }
  return "";
}

const [command, ...rest] = process.argv.slice(2);
if (rest.includes("--host")) fail("v6 removed --host modules. Use the bundled host and integration plugins; see docs/v6-migration.md.");
async function commandHost(targetRoot) {
  const manifest = requireWorkspace(targetRoot);
  const { createHost, loadReferencePlugins } = await import("@medhus-ai/crewrun-reference-host");
  process.env.TZ = manifest.timezone;
  return createHost({ targetRoot, log, plugins: await loadReferencePlugins() });
}

if (command === "--version" || command === "-v") {
  console.log(JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version);
} else if (command === "plugins") {
  if (rest[0] === "list") console.log(JSON.stringify(await listInstalledPlugins(), null, 2));
  else if (rest[0] === "create" && rest[1]) console.log(await scaffoldIntegrationPlugin(rest[1], { id: argValue(rest, "--id") || "example" }));
  else if (rest[0] === "install" && rest[1]) {
    console.log(JSON.stringify(await installIntegrationPlugin(rest[1], { trust: rest.includes("--trust") }), null, 2));
    console.log("Installed. Restart CrewRun to load the reviewed plugin; no agent permissions or event rules were enabled.");
  } else fail("usage: crewrun plugins list | create <new-directory> [--id slug] | install <package@1.2.3|./directory> --trust");
} else if (command === "init") {
  const targetRoot = targetArgument(rest, ["--preset", "--name", "--timezone"]);
  if (!targetRoot) fail("usage: crewrun init <targetRoot> [--preset personal|organization] [--name name] [--timezone UTC]");
  const workspace = initializeWorkspace(targetRoot, { kind: argValue(rest, "--preset") || "personal", name: argValue(rest, "--name") || path.basename(path.resolve(targetRoot)), timezone: argValue(rest, "--timezone") || "UTC" });
  console.log(`Initialized ${workspace.name}. Start with crewrun up ${targetRoot} --console, then open the side helper to tailor the setup.`);
} else if (command === "up") {
  const targetRoot = targetArgument(rest, ["--host", "--console-host", "--console-port"]);
  if (!targetRoot) fail("usage: crewrun up <targetRoot> ");
  const host = await commandHost(targetRoot);
  const consoleHost = argValue(rest, "--console-host") || "127.0.0.1";
  if (rest.includes("--console") && host.privateConsoleOnly && !isLoopbackHost(consoleHost)) fail("this host requires a loopback-only console; publish only its documented callback ingress");
  const up = createUp({ targetRoot, host, log });
  await up.start();
  if (rest.includes("--console")) {
    await createConsole({ targetRoot, up, knownEvents: host.knownEvents || [], operations: up.operations, port: Number(argValue(rest, "--console-port")) || 4400, host: consoleHost, log }).listen();
  }
  const shutdown = () => { void up.stop().finally(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  setInterval(() => {}, 1 << 30); // keep the process alive; the loop's own timers are unref'd
} else if (command === "console") {
  const targetRoot = targetArgument(rest, ["--host", "--console-host", "--port"]);
  if (!targetRoot) fail("usage: crewrun console <targetRoot> [--port N] [--console-host <address>] ");
  const host = await commandHost(targetRoot);
  const consoleHost = argValue(rest, "--console-host") || "127.0.0.1";
  if (host.privateConsoleOnly && !isLoopbackHost(consoleHost)) fail("this host requires a loopback-only console; publish only its documented callback ingress");
  const consoleApp = createConsole({ targetRoot, knownEvents: host.knownEvents || [], operations: host.operations || (Object.keys(host).length ? host : null), port: Number(argValue(rest, "--port")) || 4400, host: consoleHost, log });
  let hostStarted = false;
  try {
    await host.start?.();
    hostStarted = true;
    await consoleApp.listen();
  } catch (error) {
    if (hostStarted) {
      try { await host.stop?.(); } catch { /* preserve startup error */ }
    }
    throw error;
  }
  const shutdown = () => { void consoleApp.close().finally(async () => { if (hostStarted) await host.stop?.(); process.exit(0); }); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  setInterval(() => {}, 1 << 30);
} else if (command === "skills" && rest[0] === "index") {
  const targetRoot = rest.slice(1).find((arg) => !arg.startsWith("-")) || ".";
  if (rest.includes("--write")) console.log(`wrote ${writeSkillIndexFile(targetRoot)}`);
  else process.stdout.write(renderSkillIndexFile(targetRoot));
} else if (command === "proposals") {
  const sub = rest[0];
  const targetRoot = rest.slice(1).find((arg) => !arg.startsWith("-")) || ".";
  const id = rest.slice(1).filter((arg) => !arg.startsWith("-"))[1];
  const skills = listSkillProposals({ targetRoot });
  const prefs = listPreferenceProposals({ targetRoot });
  const reflections = listReflectionProposals({ targetRoot });
  if (sub === "list" || !sub) {
    for (const proposal of skills) console.log(`skill  ${proposal.id}  ${proposal.skillId} — ${proposal.description} (by ${proposal.proposedBy})`);
    for (const proposal of prefs) console.log(`pref   ${proposal.id}  ${proposal.key} — ${proposal.statement} (by ${proposal.proposedBy})`);
    for (const proposal of reflections) console.log(`memory ${proposal.id}  ${proposal.role} — ${proposal.text} (by ${proposal.proposedBy})`);
    if (!skills.length && !prefs.length && !reflections.length) console.log("no pending proposals");
  } else if (sub === "approve" || sub === "reject") {
    if (!id) fail(`usage: crewrun proposals ${sub} <targetRoot> <proposal-id>`);
    const kind = skills.some((proposal) => proposal.id === id) ? "skill"
      : prefs.some((proposal) => proposal.id === id) ? "pref"
        : reflections.some((proposal) => proposal.id === id) ? "reflection" : "";
    if (!kind) fail(`pending proposal ${id} was not found`);
    const handlers = {
      skill: sub === "approve" ? approveSkill : rejectSkill,
      pref: sub === "approve" ? approvePreference : rejectPreference,
      reflection: sub === "approve" ? approveReflection : rejectReflection
    };
    const fn = handlers[kind];
    const result = fn({ targetRoot, proposalId: id, approvedBy: "operator" });
    console.log(`${sub === "approve" ? "approved" : "rejected"} ${id}${result?.installedAt ? ` → ${result.installedAt}` : ""}`);
  } else {
    fail("usage: crewrun proposals list|approve|reject <targetRoot> [proposal-id]");
  }
} else if (command === "agents" && rest[0] === "check") {
  const targetRoot = targetArgument(rest.slice(1), ["--host"]);
  if (!targetRoot) fail("usage: crewrun agents check <targetRoot> ");
  requireWorkspace(targetRoot);
  const { loadReferencePlugins } = await import("@medhus-ai/crewrun-reference-host");
  const referencePlugins = await loadReferencePlugins();
  const knownEvents = [...LIFECYCLE_EVENTS, ...referencePlugins.flatMap((plugin) => plugin.events.map((event) => typeof event === "string" ? event : event.id))];
  const settings = loadRoleSettings(targetRoot);
  const { problems, warnings } = validateRoleSettings(settings, { knownEvents });
  for (const entry of Object.values(settings)) {
    const hb = entry.heartbeat ? `every ${entry.heartbeat.intervalSeconds}s${entry.heartbeat.budgetUsdPerDay != null ? ` (cap $${entry.heartbeat.budgetUsdPerDay}/day)` : ""}` : "off";
    console.log(`${entry.role.padEnd(14)} heartbeat: ${hb.padEnd(28)} hooks: ${entry.hooks.join(", ") || "none"}`);
  }
  for (const warning of warnings) console.warn(`WARN ${warning}`);
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(problems.length ? 1 : 0);
} else {
  console.log(`crewrun — run a crew of AI agents on the runtimes you already pay for

  crewrun init <targetRoot> [--preset personal|organization] [--name name] [--timezone UTC]
  crewrun up <targetRoot>  [--console] [--console-host <address>]   run the crew loop on a project (+ console)
  crewrun console <targetRoot> [--port N] [--console-host <address>]                  the operator UI without the loop
  crewrun agents check <targetRoot>   validate agent heartbeat/hook settings
  crewrun plugins list | create <new-directory> [--id slug] | install <package@1.2.3|./directory> --trust
  crewrun skills index <targetRoot> [--write]         print or write the generated skills/_index.md
  crewrun proposals list|approve|reject <targetRoot> [id]   review agent-proposed skills/memory
  crewrun --version

The bundled one-owner host manages tasks, reviews, schedules, and integration plugins.
Set up connections in Integrations; outgoing actions require approval. No public listener starts until an HTTPS callback origin is configured.`);
  if (command && command !== "help") process.exit(2);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function isLoopbackHost(value) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(String(value || "").toLowerCase());
}
