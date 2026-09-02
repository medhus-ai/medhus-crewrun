#!/usr/bin/env node
// The crewrun CLI — a thin wrapper over the library:
//   crewrun up <targetRoot> [--host <module>]   run the crew loop (schedules + heartbeats +
//                                               hooks + host housekeeping) on a project
//   crewrun roles check <targetRoot> [--host <module>]   validate role frontmatter settings
//   crewrun --version | help
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadRoleSettings, validateRoleSettings } from "../src/pulse.js";
import { createUp, loadHostModule } from "../src/up.js";

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
  const shutdown = () => { void up.stop().finally(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  setInterval(() => {}, 1 << 30); // keep the process alive; the loop's own timers are unref'd
} else if (command === "roles" && rest[0] === "check") {
  const targetRoot = rest.slice(1).find((arg) => !arg.startsWith("-"));
  if (!targetRoot) fail("usage: crewrun roles check <targetRoot> [--host <module>]");
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
  console.log(`crewrun — run a crew of AI roles on the runtimes you already pay for

  crewrun up <targetRoot> [--host <module>]           run the crew loop on a project
  crewrun roles check <targetRoot> [--host <module>]  validate role heartbeat/hook settings
  crewrun --version

A host module (optional) injects tools, turn recording, hook routing, and housekeeping:
export createHost({ targetRoot, log }) or a plain host object — see src/up.js for the contract.
Without one, schedules and heartbeats run on a tool-less kernel runner and hooks are disabled.`);
  if (command && command !== "help") process.exit(2);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
