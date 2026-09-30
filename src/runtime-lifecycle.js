import { readWorkspace } from "./workspace-manifest.js";
import { loadRoleSpec } from "./role-spec.js";

// Cursor and queue entries commit together. A crash can repeat a scan, never a delivery.
export function routeLifecycleEvents({ targetRoot, store, governance }) {
  return store.tx(() => {
    const rules = readWorkspace(targetRoot)?.rules.filter((r) => r.enabled) || [];
    const events = store.db.prepare("SELECT * FROM runtime_events WHERE id>? ORDER BY id LIMIT 100").all(store.meta("lifecycle.cursor") || 0);
    let created = 0;
    for (const event of events) {
      const source = store.getRun(event.run_id);
      for (const rule of rules.filter((r) => r.event === event.type)) {
        const spec = loadRoleSpec(targetRoot, rule.agent);
        if (!spec?.contract || !spec.hooks.includes(event.type)) continue;
        if (source.agent !== rule.agent && (!governance.authorizeHandoff({ role: source.agent, peerRole: rule.agent }).allowed || !governance.authorizeHandoff({ role: rule.agent, peerRole: source.agent, direction: "receive" }).allowed)) continue;
        try {
          const run = store.enqueue({ agent: rule.agent, prompt: `Lifecycle event ${event.type} for task ${source.id}. Inspect only work within your authority; do not repeat a rejected action.`, title: `Follow up: ${event.type}`, workflow: "lifecycle", parentId: source.id, dedupeKey: `lifecycle:${event.id}:${rule.id}` });
          if (run.created) created++;
        } catch (error) {
          store.event(source.id, "lifecycle.blocked", { rule: rule.id, reason: error.message });
        }
      }
      store.setMeta("lifecycle.cursor", event.id);
    }
    return { created, scanned: events.length };
  });
}
