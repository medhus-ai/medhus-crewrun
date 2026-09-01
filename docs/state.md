---
type: implementation-state
audience: founder + engineer + ai-agent
updated: 2026-08-31
status: active
---

# crewrun State

## Direction

Extracted from GitCrew on 2026-08-31 so the company-org automation can share the agent
runtime without depending on GitCrew; positioned as an open-source library (Apache-2.0, npm `crewrun`). The kernel holds only host-neutral code; product
identity is injected (see README → Host contract). GitCrew is the first consumer and pins a
tag; the org automation is the second.

## Boundaries (what stays out)

- Workflow state / SQLite store, dispatcher, plan pipeline, verification contract — GitCrew.
- Forges (GitHub, Azure DevOps), PR sync, merge policy — GitCrew.
- Cockpit shell, pages, styles, control API — GitCrew (the generic pieces `auth`,
  `request-context`, `markdown`, `process` are here).
- Persona roles and company control-file tooling — org automation.
- Memory files (engineering doctrine, conventions) — each host's own; the runtime injects none.

## Done since extraction

- Conversations/messages store (`src/conversations.js`) and tasks-as-files work items (`src/work-items.js`) — both hosts use them.

## Candidates for a later move

- Delivery/outcome reporting on top of the ledger, once a second host wants it.

## Last Check

- (4) 2026-09-01 — v0.1.1: native-Windows runtime fixes ported from GitCrew (`resolveExecutable`
  prefers PATHEXT launchers and the claude/codex `.exe` behind npm's `.cmd` shims, restores real
  file case; the `cli` engine resolves its command the same way). v0.1.0 stays as pushed.

- (3) 2026-08-31 — Renamed `crewrun` (repo and npm package `medhus-crewrun`; the runtime calls itself crewrun), Apache-2.0 + NOTICE,
  publishable manifest. Neutral defaults: `configureCrew()` replaces the `.gitcrew`/`GITCREW_*`
  hardcoding (`crewDir()`, `sessionCookieName()`); the lean-engineering template returned to
  GitCrew and the runner's universal memory defaults to none. Added `conversations` (schema +
  CRUD + singleton get-or-create, GitCrew delegates to it) and `work-items` (tasks as markdown
  files), plus `examples/brief.mjs` and an open-source README.

- (2) 2026-08-31 — Renamed to `crewrun` / `crewrun` (was medhus-crewcore). Added:
  the shared token/cost budget ledger (`src/budget.js`, host-injected SQLite handle so GitCrew's
  rows stay in cockpit.db); OpenRouter as a provider (secret `OPENROUTER_API_KEY`, preset
  `openrouter-auto`, discovery filtered to tool-calling models, Anthropic-protocol route at
  `https://openrouter.ai/api` per OpenRouter's Claude Code guide); per-runner `auth:
  "subscription" | "api-key"` forcing on both agent engines; and routed profiles now blank
  `ANTHROPIC_API_KEY` so the Bearer token wins (latent GLM/Kimi bug, required by OpenRouter).
  better-sqlite3 added as a devDependency for ledger tests only.

- (1) 2026-08-31 — Initial extraction: 27 modules, 21 test files; GitCrew consumes it via
  thin binding modules and its full suite stays green.
