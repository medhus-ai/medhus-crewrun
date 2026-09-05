import { listSchedules, nextRun, readScheduleState } from "./schedules.js";
import { loadRoleSettings, readHeartbeatState } from "./pulse.js";

// Persist a trigger cursor and its queued task together. Definitions stay human-editable;
// concurrent processes share cursors and claims through the standalone database.
export function createRuntimeScheduler({ targetRoot, runtime, env, now = () => new Date(), log = () => {} }) {
  const { store } = runtime;
  let timer;
  function tick() {
    return store.tx(() => {
      const at = now().getTime();
      const queued = [];
      const last = (key) => store.db.prepare("SELECT fired_at FROM runtime_triggers WHERE key=?").get(key)?.fired_at;
      const active = (agent, workflow) => store.db.prepare("SELECT 1 FROM runtime_runs WHERE agent=? AND workflow=? AND status IN ('queued','running','interrupted','paused') LIMIT 1").get(agent, workflow);
      const legacy = readScheduleState({ targetRoot, env });
      for (const schedule of listSchedules({ targetRoot })) {
        const key = `schedule:${schedule.role}:${schedule.id}`;
        const previous = last(key) ?? Date.parse(legacy.runs?.[`${schedule.role}:${schedule.id}`]?.lastRunAt || legacy.runs?.[schedule.id]?.lastRunAt || "");
        const due = nextRun(schedule.cron, new Date(Number.isFinite(previous) ? previous : at - 60_000));
        if (!schedule.enabled || !due || due.getTime() > at || active(schedule.role, key)) continue;
        queued.push(store.schedule(key, at, { agent: schedule.role, prompt: schedule.prompt, workflow: key }));
      }
      const oldHeartbeats = readHeartbeatState(targetRoot, env);
      for (const setting of Object.values(loadRoleSettings(targetRoot))) {
        const interval = setting.heartbeat.intervalSeconds;
        if (!Number.isFinite(interval) || interval <= 0) continue;
        const key = `heartbeat:${setting.role}`;
        const previous = last(key) ?? Date.parse(oldHeartbeats.roles?.[setting.role]?.lastRunAt || "");
        if (Number.isFinite(previous) && at - previous < interval * 1000 || active(setting.role, key)) continue;
        const cap = setting.heartbeat.budgetUsdPerDay;
        if (cap != null) {
          const today = new Date(at).toISOString().slice(0, 10);
          const spent = store.ledger.readRuns().filter((r) => r.actor === setting.role && r.timestamp.startsWith(today)).reduce((n, r) => n + (r.cost_usd ?? store.ledger.estimateCostUsd(r.runner_id, r.input_tokens, r.output_tokens) ?? 0), 0);
          if (spent >= cap) continue;
        }
        queued.push(store.schedule(key, at, { agent: setting.role, prompt: setting.heartbeat.prompt || "Check for useful work. If nothing needs attention, say so briefly.", workflow: key }));
      }
      return queued.filter(Boolean);
    });
  }
  return {
    tick,
    runNow(request) {
      const input = typeof request === "string" ? { id: request } : request;
      const schedule = listSchedules({ targetRoot }).find((s) => s.id === input.id && (!input.role || s.role === input.role));
      if (!schedule) throw new Error("Scheduled task not found.");
      return store.enqueue({ agent: schedule.role, prompt: schedule.prompt, workflow: `schedule:${schedule.role}:${schedule.id}` });
    },
    start() { if (timer) return; tick(); runtime.start(); timer = setInterval(() => { try { tick(); } catch (error) { log(`[schedule] ${error.message}`); } }, 1000); timer.unref?.(); },
    async stop() { clearInterval(timer); timer = null; await runtime.stop(); }
  };
}
