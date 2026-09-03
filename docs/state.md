---
type: implementation-state
audience: maintainer + ai-agent
updated: 2026-08-31
status: active
---

# crewrun State

## Direction

An open-source, host-neutral agent runtime (Apache-2.0, npm `medhus-crewrun`), extracted on
2026-08-31 from its first production hosts so any application can share it. The kernel holds only
host-neutral code; product identity is injected (see README → Host contract). Hosts pin a tag.

## Boundaries (what stays out)

Anything with a product opinion belongs in a host, never in the kernel:

- Workflow/pipeline state, dispatchers, verification contracts, forge integrations (GitHub,
  Azure DevOps), PR sync, and merge policy.
- UI shells, pages, styles, and control APIs (the generic pieces `auth`, `request-context`,
  `markdown`, `process` are here).
- Role catalogs and domain-specific file tooling.
- Memory files (doctrine, conventions) — each host's own; the runtime injects none.

## Done since extraction

- Web access (v0.5.0): roles opt in with `"web": true | { allow, search, max_chars }` in their
  spec; the kernel's built-in `web.fetch` (read-only GET, redirect hops re-checked, private
  addresses refused, HTML→text, capped) and `web.search` (DuckDuckGo HTML, no key) then ride the
  role's bridge. Off by default — the tools are not even advertised to roles without `web`.
  `roles check` warns on open (allowlist-less) access; the console shows the setting per role.

- Console (v0.4.0): `crewrun console <root>` / `crewrun up --console` — a local operator UI
  (127.0.0.1, node:http, zero deps; shell/pages/navigation structure) over one project's
  .crew/: dashboard + validation, role spec editing and add-role, schedule toggles and
  run-now (when attached to a loop), the skill index, and proposal approve/reject. An
  operations surface by design — no chat, no assistant UX. The kernel's built-in tools
  (crew-tools.js) are now merged into every bridge automatically (host names win;
  `crewTools: false` opts out) and the default runner carries them.

- Role specs (v0.3.0): `.crew/roles/<role>.json` (+ `_defaults.json`) holds runner, pointers,
  reflections knob, hooks, heartbeat, and that role's schedules; role `.md` is optional prose
  read via pointers; reflections auto-inject (bounded) closing the learning loop; skills go
  flat (`skills/<id>.md`) with a generated `_index.md`; `crewrun proposals list|approve|reject`
  gives the operator a native approval surface, and hostless `crewrun up` attaches the kernel's
  own learning-loop tools bridge. All legacy forms still resolve.

- `crewrun up` (v0.2.0): the crew loop as a library (`src/up.js`, createUp + loadHostModule) and
  a first CLI (`bin/crewrun.js`: up, roles check). Hosts inject runTurn/enqueue/routing/tick;
  without a host module, schedules and heartbeats run on a tool-less kernel runner.

- Conversations/messages store (`src/conversations.js`) and tasks-as-files work items (`src/work-items.js`).
- Delivery/outcome report on the ledger (`deliveryReport`): cost per delivered item, touches per item.
- Handoff queue (`handoffs`) and cron schedules for roles (`schedules`).
- Learning layers: skill proposals (`skill-proposals`), episodic recall (`recall` + `conversations.searchMessages`), per-role reflections (`reflections`).

## Candidates for a later move


## Review findings closed in v0.1.6

The 2026-08-31 review recorded five gaps; all are fixed and covered by tests:

- Role names are validated as slugs at every filesystem boundary (`removeRole`, `startRoleTurn`), so
  a role identifier can never build a path outside the roles directory.
- A schedule whose process died after `lastStartedAt` is released after `staleAfterMs` (default
  one hour, configurable) instead of staying "running" forever. Run state is still a JSON file
  without a cross-process claim: run one scheduler per project.
- Singleton-conversation unique indexes include `role`, so two singleton roles can each hold a
  thread on the same reference.
- `enqueueHandoff` verifies the conversation exists and belongs to `targetRoot`.
- Secret and auth files are chmod'ed to 0600 on every write, not only on creation.

## Last Check

- (10) 2026-09-01 — v0.1.6: closes the five review findings above (role-name validation at
  filesystem boundaries, stale-run release for schedules, per-role singleton indexes, handoff
  root check, continuous 0600 on sensitive files).

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

- (4) 2026-08-31 — v0.1.1: native-Windows runtime fixes ported from a production host (`resolveExecutable`
  prefers PATHEXT launchers and the claude/codex `.exe` behind npm's `.cmd` shims, restores real
  file case; the `cli` engine resolves its command the same way). v0.1.0 stays as pushed.

- (3) 2026-08-31 — Renamed `crewrun` (repo and npm package `medhus-crewrun`; the runtime calls itself crewrun), Apache-2.0 + NOTICE,
  publishable manifest. Neutral defaults: `configureCrew()` replaces the first host's directory/env
  hardcoding (`crewDir()`, `sessionCookieName()`); the engineering-doctrine template returned to
  its host and the runner's universal memory defaults to none. Added `conversations` (schema +
  CRUD + singleton get-or-create) and `work-items` (tasks as markdown
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
