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
- Handoff queue (`handoffs`) and cron schedules for roles (`schedules`).
- Learning layers: skill proposals (`skill-proposals`), episodic recall (`recall` + `conversations.searchMessages`), per-role reflections (`reflections`).

## Candidates for a later move


## Known gaps from the 2026-08-31 review

- Schedule state is a JSON file without a cross-process claim. Hosts must currently run one
  scheduler per project. If a process exits after writing `lastStartedAt` but before
  `lastRunAt`, that schedule remains classified as running; add a lease/recovery rule before
  treating schedules as crash-safe.
- Singleton-conversation unique indexes cover `(target_root, reference)` across every role in
  `singletonRoles`, while lookup includes `role`. Configuring two singleton roles for the same
  reference can therefore make the second `getOrCreateConversation` fail; include `role` in the
  indexes or explicitly narrow the contract to one singleton role.
- `enqueueHandoff` accepts `targetRoot` separately from `conversationId` without verifying that
  it matches the conversation row. Validate that relationship before using pending handoffs to
  select a project to run.
- Role identifiers are not validated consistently at filesystem boundaries. `removeRole` does
  not apply the slug validation used by `addRole`, so traversal segments can move markdown files
  outside the roles directory; `startRoleTurn` also interpolates an unvalidated role into its
  role-file path. Validate before constructing either path.
- Secret and auth files are created with mode 0600, but `writeFileSync(..., { mode: 0o600 })`
  does not repair permissions on an existing file. Explicitly chmod after writes before claiming
  the mode is continuously enforced.


## Last Check

- (8) 2026-09-01 — v0.1.5: Codex SDK `^0.152.0` (GPT-5.6 model ids); no code change.

- (9) 2026-08-31 — Code and documentation review. The non-SQLite suite passes under Node 20;
  SQLite-backed tests were skipped because the installed native `better-sqlite3` binding requires
  GLIBC 2.38 while the available Node 20 image provides an older GLIBC. Corrected the public
  handoff signature, cron feature description, and secret-file mode wording; recorded the
  scheduler-recovery, singleton-index, handoff-root, path-validation, and file-mode gaps above.

- (7) 2026-08-31 — v0.1.4: `handoffs` (the leased input queue that wakes a role's singleton
  thread; table name is host-configurable so an existing table is reused as-is) and `schedules`
  (five-field cron parser, project-versioned definitions, crew-home run state, a scheduler that
  fires once per due schedule and records outcomes).

- (6) 2026-08-31 — v0.1.3: governed learning. `skill-proposals` (agent proposes a SKILL.md,
  human approves into a scope; reuses the preference proposal/audit helpers), `recall`
  (episodes = ask + outcome, by role / reference / mention; LIKE with escaped wildcards), and
  `reflections` (per-role append-only journal, bounded read, prompt section). Hosts expose these
  as tools and decide where to inject; the kernel ships no skill or memory content.

- (5) 2026-08-31 — v0.1.2: `deliveryReport` on the ledger; no host is named anywhere in the repo;
  the `cli` engine publishes prompt-file env under `CREW_*` plus the configured legacy prefix;
  `EXTRA_PATH` reads through `crewEnv`; catalog cache keys on size + mtime.

- (4) 2026-08-31 — v0.1.1: native-Windows runtime fixes ported from the engineering host (`resolveExecutable`
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
