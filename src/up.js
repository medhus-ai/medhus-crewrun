import path from "node:path";
import { createRuntimeScheduler } from "./runtime-scheduler.js";
import { requireWorkspace } from "./workspace-manifest.js";

// One runtime owns queued work, trigger claims, delivery, and shutdown. Provider
// events enter through the host's verified ingress, never an in-memory hook bus.
export function createUp({ targetRoot, host, hostTickMs = 15000, log = () => {}, now = () => new Date() } = {}) {
  if (!targetRoot) throw new Error("createUp requires targetRoot");
  const root = path.resolve(targetRoot);
  requireWorkspace(root);
  if (!host?.durableRuntime || !host.operations) throw new Error("v6 requires the bundled governed host and its durable runtime");
  const scheduler = createRuntimeScheduler({ targetRoot: root, runtime: host.durableRuntime, now, log });
  let timer;
  let started = false;
  let ticking = null;
  function tickOnce() {
    if (ticking) return ticking;
    ticking = Promise.resolve().then(async () => {
      await scheduler.tick();
      await host.tick();
    }).finally(() => { ticking = null; });
    return ticking;
  }
  async function start() {
    if (started) return;
    try {
      await host.start();
      scheduler.start();
      started = true;
      timer = setInterval(() => { void tickOnce().catch((error) => log(`[up] tick failed: ${error.message}`)); }, hostTickMs);
      timer.unref?.();
      log(`[up] workspace running on ${root}`);
    } catch (error) {
      await scheduler.stop();
      await host.stop();
      throw error;
    }
  }
  async function stop() {
    clearInterval(timer);
    timer = null;
    await ticking?.catch(() => {});
    await scheduler.stop();
    await host.stop();
    started = false;
  }
  return { start, stop, tickOnce, scheduler, operations: host.operations };
}
