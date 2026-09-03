import path from "node:path";
import { pathToFileURL } from "node:url";

import { createPulse } from "./pulse.js";
import { listReflectionProposals } from "./reflection-proposals.js";
import { listSkillProposals } from "./skill-proposals.js";
import { listPreferenceProposals } from "./preference-memory.js";
import { createRoleRunner } from "./runner.js";
import { createScheduler } from "./schedules.js";

// The crew loop as a library: schedules + heartbeats + hooks + host housekeeping around one
// target project, with every opinionated piece injected by an optional host module. The
// `crewrun up` CLI is a thin wrapper over createUp; hosts can equally import it directly and
// keep their own entry point.
//
// Host contract — a plain object, everything optional:
//   runTurn(role, prompt, meta)   -> { ok, text?, reason? }   turn execution (default: a
//                                     tool-less kernel runner via runRoleCapture)
//   runSchedule(schedule)         -> { ok, ... }              override schedule runs entirely
//   enqueue({role, body, externalId}) -> { created }          hook delivery; hooks are disabled
//                                     (with one logged notice) when absent
//   routeEvent(event, payload, settings) -> [roles]           default: every subscribed role
//   renderEvent(event, payload)   -> prompt string
//   spentToday(role)              -> USD number               backs heartbeat budget caps
//   tick({ emit })                                            periodic housekeeping (queues, outboxes)
//   start({ emit }) / stop()                                  lifecycle (servers, watchers)

export function defaultRouteEvent(event, payload, settings) {
  return Object.values(settings).filter((entry) => entry.hooks.includes(event)).map((entry) => entry.role);
}

// Accepts: default export object, default export factory, named createHost({ targetRoot, log }).
export async function loadHostModule(spec, { targetRoot, log = () => {} } = {}) {
  if (!spec) return {};
  const resolved = /^(\.|\/)/.test(spec) ? pathToFileURL(path.resolve(spec)).href : spec;
  const mod = await import(resolved);
  const factory = mod.createHost || mod.default?.createHost || (typeof mod.default === "function" ? mod.default : null);
  if (factory) return await factory({ targetRoot, log });
  if (mod.default && typeof mod.default === "object") return mod.default;
  throw new Error(`host module ${spec} exports neither createHost({ targetRoot, log }) nor a host object`);
}

export function createUp({
  targetRoot,
  host = {},
  heartbeatTickMs = 1000,
  hostTickMs = 15000,
  log = () => {},
  env = process.env,
  now = () => new Date()
} = {}) {
  if (!targetRoot) throw new Error("createUp requires targetRoot");
  const root = path.resolve(targetRoot);

  let fallbackRunner = null;
  const runTurn = host.runTurn || ((role, prompt, meta = {}) => {
    // The kernel runner carries the built-in crew tools by default, so hostless turns
    // still complete the learning loop.
    fallbackRunner = fallbackRunner || createRoleRunner({});
    return fallbackRunner.runRoleCapture({ root, role, prompt, label: meta.label || meta.workflow || role, log });
  });

  let hooksNoticeShown = false;
  const enqueue = host.enqueue || (() => {
    if (!hooksNoticeShown) {
      hooksNoticeShown = true;
      log("[up] hooks are disabled: the host provides no enqueue({ role, body, externalId })");
    }
    return { created: false };
  });

  const pulse = createPulse({
    targetRoot: root,
    runTurn: (role, prompt) => runTurn(role, prompt, { workflow: "heartbeat", label: `heartbeat:${role}` }),
    enqueue,
    routeEvent: host.routeEvent || defaultRouteEvent,
    ...(host.renderEvent ? { renderEvent: host.renderEvent } : {}),
    ...(host.spentToday ? { spentToday: host.spentToday } : {}),
    log,
    env,
    now
  });

  const scheduler = createScheduler({
    targetRoot: root,
    run: host.runSchedule || ((schedule) => runTurn(schedule.role, schedule.prompt, { workflow: "schedule", label: `schedule:${schedule.id}`, schedule })),
    env,
    now,
    log,
    error: log
  });

  let timers = [];

  async function tickOnce() {
    await scheduler.tick();
    await pulse.tickHeartbeats();
    await host.tick?.({ emit: pulse.emit });
  }

  async function start() {
    scheduler.start();
    const heartbeat = setInterval(() => { void pulse.tickHeartbeats(); }, heartbeatTickMs);
    heartbeat.unref?.();
    timers.push(heartbeat);
    if (host.tick) {
      const housekeeping = setInterval(() => { void Promise.resolve(host.tick({ emit: pulse.emit })).catch((error) => log(`[up] host tick failed: ${error.message}`)); }, hostTickMs);
      housekeeping.unref?.();
      timers.push(housekeeping);
    }
    await host.start?.({ emit: pulse.emit });
    try {
      const pending = listSkillProposals({ targetRoot: root }).length
        + listPreferenceProposals({ targetRoot: root }).length
        + listReflectionProposals({ targetRoot: root }).length;
      if (pending) log(`[up] ${pending} proposal${pending === 1 ? "" : "s"} pending operator review — crewrun proposals list ${root}`);
    } catch { /* proposals are optional */ }
    log(`[up] crew loop running on ${root}`);
  }

  async function stop() {
    scheduler.stop();
    for (const timer of timers) clearInterval(timer);
    timers = [];
    await host.stop?.();
  }

  return { start, stop, tickOnce, emit: pulse.emit, scheduler, pulse };
}
