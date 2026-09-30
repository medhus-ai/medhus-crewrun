// Shared lease/cancellation boundary; hosts retain their provider adapters and approval policy.
export async function executeLeasedRun({ store, run, controllers, heartbeatMs = 1000, execute, errorMessage = (error) => error.message }) {
  const controller = new AbortController();
  controllers.set(run.id, controller);
  const heartbeat = setInterval(() => {
    if (!store.renew("run", run.id, run.lease) || store.getRun(run.id)?.desired !== "active") controller.abort();
  }, heartbeatMs);
  heartbeat.unref?.();
  try {
    let result;
    try { result = await execute(controller.signal); }
    catch (error) { result = { ok: false, reason: errorMessage(error) }; }
    store.finishRun(run, result);
    return { ...result, runId: run.id };
  } finally {
    clearInterval(heartbeat);
    controllers.delete(run.id);
  }
}
