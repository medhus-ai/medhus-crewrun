# medhus-router

**The shared agent runtime behind Medhus crews.**

`@medhus/router` runs one role turn on a vendor engine with brokered tools: it
resolves the runner profile, assembles the prompt from the role file and its
declared memory, exposes the host's tools to the model over MCP, isolates
execute-mode edits in a git worktree or container, and reports usage. Everything
that gives a product its identity — role names, tool tables, prompt boilerplate,
branch prefixes, the cockpit UI — stays in the host.

Two hosts consume it, and neither depends on the other:

| Host | What it adds on top |
|---|---|
| [medhus-gitcrew](https://github.com/medhus-ai/medhus-gitcrew) | Engineering control plane: dispatcher, plan pipeline, verification contract, GitHub/Azure forges, cockpit |
| medhus-org automation | Company operating system: persona roles (CEO, TECH, OPS, …), inbox/approvals tooling, timers |

## What is inside

| Module | Purpose |
|---|---|
| `crew-dirs` | `CREW_DIR` (per-project state directory), `crewHome()`, `crewEnv()` |
| `runner` | `createRoleRunner(host)` → `startRoleTurn`, `runRoleCapture`, prompt builders, `loadRoleMemory` |
| `engines/*` | `cli` (any vendor CLI), `claude-agent`, `codex-agent`, `container` (Docker sandbox), worker |
| `mcp`, `mcp-stdio` | `createMcpBridge(registry)` — in-process Claude MCP server + stdio server for Codex |
| `tool-broker` | `createToolBroker({ allowlists, … })` — role → tool allowlist enforcement |
| `role-capabilities` | Subagent policy per role kind; Claude subagent definitions |
| `roles`, `templates` | Role catalog installer; template reader; the lean-engineering doctrine |
| `runner-config`, `model-catalog` | Runner profiles (global + per-project role mapping), live model discovery |
| `secret-store` | Encrypted per-operator API-key store (scrypt + AES-256-GCM) |
| `budget` | `createBudgetLedger({ getDb })` — token/cost ledger: per-run rows, monthly report, subscription cost estimates |
| `skills`, `preference-memory`, `execution-policy` | Scoped skills, approved preferences, container policy |
| `auth`, `request-context`, `markdown`, `process`, `platform`, `frontmatter`, `agent-output` | Framework-free cockpit and OS helpers |

Import by subpath: `import { createRoleRunner } from "@medhus/router/runner";`.

## Host contract

- **Directory name.** State lives in `<repo>/<CREW_DIR>/` (`roles/`, `memory/`, `skills/`).
  The default is `.gitcrew` (the first consumer); set `CREW_DIR_NAME` before the first
  import to use another name. The session cookie name follows it.
- **Environment.** Every override reads `CREW_<NAME>` first and `GITCREW_<NAME>` second:
  `HOME`, `SECRETS_FILE`, `RUNNERS_FILE`, `MODEL_CATALOG_FILE`, `AUTH_FILE`, `WORKSPACE`,
  `EXTRA_PATH`, `MCP_ROLE`, `MCP_CONTEXT_FILE`, `MCP_AUTH_FILE`.
- **Runner hooks.** `createRoleRunner({ tools, displayRoleName, universalMemory, memoryTitles,
  extraMemory, capabilityProfile, capabilityInstructions, protocol, turnInstructions,
  proposeModeInstruction, createWorktree, container, noise })` — all optional; defaults are
  neutral. `tools` is an MCP bridge.
- **Tool registry.** `createMcpBridge({ serverName, toolsForRole, describe, inputSchema, call,
  validate?, alwaysLoad?, instructions?, toolInstructions?, enabled?, serializeContext?,
  childEnvPassthrough?, childEnvPrefixes?, childAuthEnv?, stdioServerEntry? })`.
- **Two host entry scripts.** Codex and the container sandbox run tools in a child process, so
  the host ships (1) a stdio MCP server entry that rebuilds its tool context and calls
  `serveStdio({ bridge, role, toolContext })`, and (2) a container worker entry that calls
  `runContainerWorker({ engineId, tools })`; pass their paths as `stdioServerEntry` and
  `container.workerEntry`.

## Providers and auth

Runner profiles route each role to a provider, model, and thinking effort. Per profile, `auth` picks how it authenticates:

| `auth` | Behaviour |
|---|---|
| *(absent — auto)* | Today's default: ambient/stored API key if present, else the vendor CLI's subscription login |
| `"subscription"` | Forces vendor login (Claude Pro/Max, ChatGPT) by stripping ambient API keys from the turn |
| `"api-key"` | Forces the stored key (secret store `secret_ref` or the provider default) and fails loudly if none exists |

Routed profiles (`base_url`) speak the Anthropic protocol at a third-party endpoint with a Bearer token
(`ANTHROPIC_AUTH_TOKEN`), and blank `ANTHROPIC_API_KEY` so the token always wins:

- **GLM** (`api.z.ai`), **Kimi** (`api.moonshot.ai`), **local servers** (Ollama, LM Studio, llama.cpp)
- **OpenRouter** (`openrouter.ai/api`) — one `OPENROUTER_API_KEY` for its whole catalog. The
  `openrouter-auto` preset targets `openrouter/auto`; concrete models are discovered from
  `/api/v1/models?supported_parameters=tools` (tool-calling models only) once the key is stored.

## Budget ledger

`createBudgetLedger({ getDb, describeSource, pricing })` records one row per agent run
(tokens, reported cost, duration, result) into a `budget_runs` table in the host's SQLite
database, and `report()` aggregates by month with per-project/engine/runner rows, estimating
API-equivalent cost for subscription runs from a pricing table hosts can override.

## Install

```bash
npm install "github:medhus-ai/medhus-router#v0.1.0"
```

Node 20 or newer. Dependencies: the Claude Agent SDK, the Codex SDK, the MCP SDK, and zod.

## Develop

```bash
npm install
npm test
```

Changes follow [templates/memory/lean-engineering.md](templates/memory/lean-engineering.md):
smallest correct change, no speculative structure, no casual dependencies. Anything a host
needs that is not host-specific belongs here; anything with a product name in it does not.

## License

Business Source License 1.1 — see [LICENSE](LICENSE).
