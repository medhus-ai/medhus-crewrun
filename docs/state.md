---
type: implementation-state
audience: founder + engineer + ai-agent
updated: 2026-08-31
status: active
---

# crewrun State

## Direction

Extracted on 2026-08-31 from the first host (an engineering control plane) so a second host (a
company-operations automation) can share the agent runtime without depending on the first; positioned
as an open-source library (Apache-2.0, npm `medhus-crewrun`). The kernel holds only host-neutral code;
product identity is injected (see README → Host contract). Hosts pin a tag.

## Boundaries (what stays out)

- Workflow state / SQLite store, dispatcher, plan pipeline, verification contract — the engineering host.
- Forges (GitHub, Azure DevOps), PR sync, merge policy — the engineering host.
- Cockpit shell, pages, styles, control API — the engineering host (the generic pieces `auth`,
  `request-context`, `markdown`, `process` are here).
- Persona roles and company control-file tooling — org automation.
- Memory files (engineering doctrine, conventions) — each host's own; the runtime injects none.

## Done since extraction

- Conversations/messages store (`src/conversations.js`) and tasks-as-files work items (`src/work-items.js`) — both hosts use them.
- Delivery/outcome report on the ledger (`deliveryReport`): cost per delivered item, touches per item.
- Learning layers: skill proposals (`skill-proposals`), episodic recall (`recall` + `conversations.searchMessages`), per-role reflections (`reflections`).

## Candidates for a later move


## Last Check

- (6) 2026-09-01 — v0.1.3: governed learning. `skill-proposals` (agent proposes a SKILL.md,
  human approves into a scope; reuses the preference proposal/audit helpers), `recall`
  (episodes = ask + outcome, by role / reference / mention; LIKE with escaped wildcards), and
  `reflections` (per-role append-only journal, bounded read, prompt section). Hosts expose these
  as tools and decide where to inject; the kernel ships no skill or memory content.

- (5) 2026-09-01 — v0.1.2: `deliveryReport` on the ledger; no host is named anywhere in the repo;
  the `cli` engine publishes prompt-file env under `CREW_*` plus the configured legacy prefix;
  `EXTRA_PATH` reads through `crewEnv`; catalog cache keys on size + mtime.

- (4) 2026-09-01 — v0.1.1: native-Windows runtime fixes ported from the engineering host (`resolveExecutable`
  prefers PATHEXT launchers and the claude/codex `.exe` behind npm's `.cmd` shims, restores real
  file case; the `cli` engine resolves its command the same way). v0.1.0 stays as pushed.

- (3) 2026-08-31 — Renamed `crewrun` (repo and npm package `medhus-crewrun`; the runtime calls itself crewrun), Apache-2.0 + NOTICE,
  publishable manifest. Neutral defaults: `configureCrew()` replaces the first host's directory/env
  hardcoding (`crewDir()`, `sessionCookieName()`); the engineering-doctrine template returned to
  its host and the runner's universal memory defaults to none. Added `conversations` (schema +
  CRUD + singleton get-or-create; the engineering host delegates to it) and `work-items` (tasks as markdown
  files), plus `examples/brief.mjs` and an open-source README.

- (2) 2026-08-31 — Renamed to `crewrun` / `crewrun` (was medhus-crewcore). Added:
  the shared token/cost budget ledger (`src/budget.js`, host-injected SQLite handle so each host's
  rows stay in its own database); OpenRouter as a provider (secret `OPENROUTER_API_KEY`, preset
  `openrouter-auto`, discovery filtered to tool-calling models, Anthropic-protocol route at
  `https://openrouter.ai/api` per OpenRouter's Claude Code guide); per-runner `auth:
  "subscription" | "api-key"` forcing on both agent engines; and routed profiles now blank
  `ANTHROPIC_API_KEY` so the Bearer token wins (latent GLM/Kimi bug, required by OpenRouter).
  better-sqlite3 added as a devDependency for ledger tests only.

- (1) 2026-08-31 — Initial extraction: 27 modules, 21 test files; the first host consumes it via
  thin binding modules and its full suite stays green.
