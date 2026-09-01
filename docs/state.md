---
type: implementation-state
audience: founder + engineer + ai-agent
updated: 2026-08-31
status: active
---

# medhus-router State

## Direction

Extracted from GitCrew on 2026-08-31 so the company-org automation can share the agent
runtime without depending on GitCrew. The kernel holds only host-neutral code; product
identity is injected (see README → Host contract). GitCrew is the first consumer and pins a
tag; the org automation is the second.

## Boundaries (what stays out)

- Workflow state / SQLite store, dispatcher, plan pipeline, verification contract — GitCrew.
- Forges (GitHub, Azure DevOps), PR sync, merge policy — GitCrew.
- Cockpit shell, pages, styles, control API — GitCrew (the generic pieces `auth`,
  `request-context`, `markdown`, `process` are here).
- Persona roles and company control-file tooling — org automation.

## Candidates for a later move

- Conversations/messages store (currently GitCrew `cockpit/src/store.js`) once a second host
  needs durable chats. The budget ledger already follows the intended pattern: kernel schema and
  math, host-owned database handle.
- A markdown work-item source (tasks as files) — useful to both hosts.

## Last Check

- (2) 2026-08-31 — Renamed to `medhus-router` / `@medhus/router` (was medhus-crewcore). Added:
  the shared token/cost budget ledger (`src/budget.js`, host-injected SQLite handle so GitCrew's
  rows stay in cockpit.db); OpenRouter as a provider (secret `OPENROUTER_API_KEY`, preset
  `openrouter-auto`, discovery filtered to tool-calling models, Anthropic-protocol route at
  `https://openrouter.ai/api` per OpenRouter's Claude Code guide); per-runner `auth:
  "subscription" | "api-key"` forcing on both agent engines; and routed profiles now blank
  `ANTHROPIC_API_KEY` so the Bearer token wins (latent GLM/Kimi bug, required by OpenRouter).
  better-sqlite3 added as a devDependency for ledger tests only.

- (1) 2026-08-31 — Initial extraction: 27 modules, 21 test files; GitCrew consumes it via
  thin binding modules and its full suite stays green.
