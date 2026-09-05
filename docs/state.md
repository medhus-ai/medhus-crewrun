# Capabilities and limits

[Documentation](README.md) / Capabilities and limits

This page describes the code on this branch. Published package versions may differ;
use the documentation at your installed version's Git tag.

## Available

| Area | Support |
|---|---|
| Agents | JSON specs, instructions, shared defaults, permissions, and a local management console |
| Runners | Claude Agent SDK, Codex SDK, and configured CLI/API routes |
| Tasks | Manual requests, accepted dependencies, saved artifacts, receipts, and timelines |
| Recovery | Transactional local storage, atomic claims, delivery retries, pause/cancel, and restart recovery |
| Scheduling | Cron tasks, periodic check-ins, and application-supplied hooks |
| Integrations | Approved Slack posts/replies and Gmail existing-draft sends; optional Gmail reads |
| Learning | Scoped Skills, reviewed preferences, and optional reflection proposals |
| Usage | Run ledger, reported and estimated spend, and cost per accepted deliverable |
| Embedding | Host APIs for tools, governance, storage, events, and console data |

## Current limits

- Restart recovery resumes queued work. Interrupted model turns need review and an explicit retry;
  pause/resume does not restore an exact model checkpoint.
- An external action already in flight can finish after pause/cancel. Uncertain delivery needs
  reconciliation before resending. A provider receipt is not proof of recipient delivery or reading.
- Standalone storage supports processes sharing a local database, not a distributed worker cluster.
  Exported file-based host helpers still require one operator process or host-provided coordination.
- Standalone Gmail sends existing drafts. Incoming Slack subscriptions, Gmail draft creation,
  and browser OAuth callbacks require additional integration work.
- Usage may be incomplete when a provider does not report it. Subscription costs are estimates;
  budget reservations and hard provider spending limits are not implemented.
- Reflections are off by default. Reviewed proposals update preferences or Skills;
  legacy journals are retained but are not automatically loaded.

See [Tasks and recovery](runtime-recovery.md) for operational details and the
[Roadmap](product-direction.md) for planned improvements.
