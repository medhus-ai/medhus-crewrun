#!/usr/bin/env node
// The crewrun CLI — a thin wrapper over the library:
//   crewrun up <targetRoot> [--host <module>]   run the crew loop (schedules + heartbeats +
//                                               hooks + host housekeeping) on a project
//   crewrun agents check <targetRoot> [--host <module>]   validate agent frontmatter settings
//   crewrun --version | help
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRoleSettings, validateRoleSettings } from "../src/pulse.js";
import { writeSkillIndexFile, renderSkillIndexFile } from "../src/skills.js";
import { approveSkill, listSkillProposals, rejectSkill } from "../src/skill-proposals.js";
import { approvePreference, listPreferenceProposals, rejectPreference } from "../src/preference-memory.js";
import { approveReflection, listReflectionProposals, rejectReflection } from "../src/reflection-proposals.js";
import { createUp, loadHostModule } from "../src/up.js";
import { createConsole } from "../src/console/server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : undefined;
}

const [command, ...rest] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
  console.log(JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version);
} else if (command === "up") {
  const targetRoot = rest.find((arg) => !arg.startsWith("-"));
  if (!targetRoot) fail("usage: crewrun up <targetRoot> [--host <module>]");
  const host = await loadHostModule(argValue(rest, "--host"), { targetRoot, log });
  const up = createUp({ targetRoot, host, log });
  await up.start();
  if (rest.includes("--console")) {
    await createConsole({ targetRoot, up, knownEvents: host.knownEvents || [], operations: up.operations, port: Number(argValue(rest, "--console-port")) || 4400, log }).listen();
  }
  const shutdown = () => { void up.stop().finally(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  setInterval(() => {}, 1 << 30); // keep the process alive; the loop's own timers are unref'd
} else if (command === "console") {
  const targetRoot = rest.find((arg) => !arg.startsWith("-"));
  if (!targetRoot) fail("usage: crewrun console <targetRoot> [--port N] [--host <module>]");
  const host = await loadHostModule(argValue(rest, "--host"), { targetRoot, log });
  await createConsole({ targetRoot, knownEvents: host.knownEvents || [], operations: host.operations || (Object.keys(host).length ? host : null), port: Number(argValue(rest, "--port")) || 4400, log }).listen();
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
} else if ((command === "agents" || command === "roles") && rest[0] === "check") {
  const targetRoot = rest.slice(1).find((arg) => !arg.startsWith("-"));
  if (!targetRoot) fail("usage: crewrun agents check <targetRoot> [--host <module>]");
  const host = await loadHostModule(argValue(rest, "--host"), { targetRoot, log: () => {} });
  const settings = loadRoleSettings(targetRoot);
  const { problems, warnings } = validateRoleSettings(settings, { knownEvents: host.knownEvents || [] });
  for (const entry of Object.values(settings)) {
    const hb = entry.heartbeat ? `every ${entry.heartbeat.intervalSeconds}s${entry.heartbeat.budgetUsdPerDay != null ? ` (cap $${entry.heartbeat.budgetUsdPerDay}/day)` : ""}` : "off";
    console.log(`${entry.role.padEnd(14)} heartbeat: ${hb.padEnd(28)} hooks: ${entry.hooks.join(", ") || "none"}`);
  }
  for (const warning of warnings) console.warn(`WARN ${warning}`);
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(problems.length ? 1 : 0);
} else {
  console.log(`crewrun — run a crew of AI agents on the runtimes you already pay for

  crewrun up <targetRoot> [--host <module>] [--console]   run the crew loop on a project (+ local console)
  crewrun console <targetRoot> [--port N]             the local operator UI without the loop
  crewrun agents check <targetRoot> [--host <module>]  validate agent heartbeat/hook settings
  crewrun skills index <targetRoot> [--write]         print or write the generated skills/_index.md
  crewrun proposals list|approve|reject <targetRoot> [id]   review agent-proposed skills/memory
  crewrun --version

A host module (optional) injects tools, turn recording, hook routing, and housekeeping:
export createHost({ targetRoot, log }) or a plain host object — see src/up.js for the contract.
Without one, schedules and heartbeats use built-in tools and configured Slack/Gmail connections.
Set up connections in Integrations; outgoing actions require approval. Event hooks need an enqueue adapter.`);
  if (command && command !== "help") process.exit(2);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
