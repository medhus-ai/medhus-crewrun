# Tasks and recovery

`crewrun up <workspace> --console` starts the shared durable worker, scheduler and
owner console. `crewrun console <workspace>` starts the host without recurring
trigger polling. Use `up` for unattended queued work and delivery processing.

Tasks, attempts, artifacts, questions, decisions and trigger cursors live in private
SQLite. Claims carry lease tokens; expired workers cannot commit over a new owner.
Trigger advancement and internal enqueue happen in one transaction.

| State | Next action |
|---|---|
| Queued | Worker claims when dependencies and authority permit |
| Interrupted | Inspect partial work and explicitly retry |
| Paused/cancelled | Future claims stop; an in-flight external action may still finish |
| Question | Owner answer resumes the same task once internally |
| Completed result | Owner accepts or requests changes with feedback |
| Approved external write | Worker rechecks authority and connection before delivery |
| Uncertain delivery | Manually reconcile with evidence; never silently resend |

Reviews are decisions; Activity is read-only history; Tasks contains work and
questions. Result completion is distinct from human acceptance. Rejecting an
external action never sends it or creates an automatic retry.

Provider receipts prove API acceptance, not recipient delivery or reading.
Retry guarantees depend on the provider; there is no universal exactly-once
external delivery. Preserve evidence when reconciling an ambiguous result.

No old JSON tasks, action approvals, connection credentials, heartbeat cursors,
or schedule state are imported in v6. Existing backups remain untouched.
Use a fresh workspace identity when retiring an old automation.

Usage distinguishes reported values, estimates and unavailable subscription costs.
Supported limits and rollback guidance are in [workspaces](workspaces.md).
