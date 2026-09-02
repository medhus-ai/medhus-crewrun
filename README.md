# crewrun

**Run a crew of AI roles on the agent runtimes you already pay for.**

crewrun is a small Node library for building your own multi-role agent system on top of the
vendors' *agent* runtimes — the Claude Agent SDK, the Codex SDK, or any CLI — instead of raw
model APIs. Define roles as markdown files, route each role to a provider and model, expose
exactly the tools that role may call over MCP, sandbox edits in a git worktree or a container,
and keep a ledger of what every run cost.

- **Your local sign-ins work.** Operator-owned Claude and ChatGPT/Codex subscriptions can drive
  local turns through the official SDKs; API keys (Anthropic, OpenAI, OpenRouter, GLM, Kimi)
  and local servers work too. Choose per role.
- **One key, any model.** OpenRouter's whole catalog is a provider; local Ollama / LM Studio /
  llama.cpp servers are another.
- **Roles are files.** A role is a Markdown prompt plus a role → runner mapping.
  `memory_pointers` is kernel context; other frontmatter is available to the host. No framework
  classes.
- **Tools are brokered.** A per-role allowlist decides what the model can call; the bridge
  serves host-defined tools to Claude in-process and to Codex over a stdio MCP server. The model
  never sees a tool it is not allowed to use.
- **Edits are isolated.** Execute-mode turns run in a dedicated git worktree on a fresh branch,
  or inside a locked-down Docker container. Propose mode is read-only.
- **Everything is accounted for.** Token counts, reported cost, duration, and result per run,
  aggregated per month, project, engine, and runner — with cost estimates for subscription runs.

crewrun grew out of two very different hosts — an engineering control plane and a
company-operations automation — and carries no opinion about *what* your roles do.

## Quick start

```bash
npm install medhus-crewrun
node examples/brief.mjs        # a "CEO" role reads an inbox through a brokered tool and writes a brief
```

The example needs a signed-in `claude` CLI or `ANTHROPIC_API_KEY`; set `OPENROUTER_API_KEY`
and `CREW_EXAMPLE_RUNNER=openrouter-auto` to run it on OpenRouter instead. What it does, in
order ([examples/brief.mjs](examples/brief.mjs)):

```js
import { createMcpBridge } from "medhus-crewrun/mcp";
import { createRoleRunner } from "medhus-crewrun/runner";
import { createToolBroker } from "medhus-crewrun/tool-broker";

const broker = createToolBroker({ allowlists: { ceo: ["inbox.list"] } });
const tools = createMcpBridge({
  serverName: "company",
  toolsForRole: (role) => broker.toolsForRole(role),
  describe: () => "List work items, optionally filtered by status.",
  inputSchema: (name, z) => ({ status: z.string().optional() }),
  call: ({ role, toolName, input }) => broker.callTool({ role, toolName, input, registry })
});

const runner = createRoleRunner({ tools });
const result = await runner.runRoleCapture({ root: project, role: "ceo", prompt: "Write today's brief." });
```

A project is any directory with a `.crew/` folder: `roles/<role>.md` and
`memory/ai-runners.json` (`{ "default_role_runners": { "ceo": "claude-agent-sonnet-high" } }`).
Concrete runner profiles are machine-level, in `~/.crew/ai-runners.json`, so keys and vendor
choices never enter a repository.

## What is inside

| Module | Purpose |
|---|---|
| `runner` | `createRoleRunner(host)` → `startRoleTurn`, `runRoleCapture`, prompt assembly, `loadRoleMemory` |
| `engines/*` | `cli` (any vendor CLI), `claude-agent`, `codex-agent`, `container` (Docker sandbox) |
| `mcp`, `mcp-stdio` | `createMcpBridge(registry)` — host-tool MCP server bridge: in-process for Claude, stdio for Codex |
| `tool-broker` | `createToolBroker({ allowlists, … })` — role → tool allowlist enforcement |
| `role-capabilities` | Subagent policy per role kind; Claude subagent definitions |
| `roles`, `templates` | Role catalog installer; template reader |
| `runner-config`, `model-catalog` | Runner profiles (global + per-project role mapping), live model discovery |
| `secret-store` | Encrypted per-operator API-key store (scrypt + AES-256-GCM, 0600 file) |
| `budget` | `createBudgetLedger({ getDb })` — per-run rows, monthly report, subscription cost estimates |
| `conversations` | `createConversationStore({ getDb })` — durable chat threads and messages per project/role |
| `work-items` | `createWorkItemSource({ dir })` — tasks as markdown files (frontmatter or bold bullets) |
| `handoffs` | `createHandoffQueue({ getDb })` — durable inputs for a role's thread: attach once, claim in leased batches, recover after a crash ("wake the manager") |
| `schedules` | Cron-scheduled role turns: `<crew dir>/schedules.json`, `parseCron`, `dueSchedules`, `createScheduler({ run })` |
| `up` | `createUp({ targetRoot, host })` + the `crewrun up` CLI — the crew loop (schedules, heartbeats, hooks, host housekeeping) around one project; the optional host module injects tools, turn recording, routing, and lifecycle |
| `pulse` | Role heartbeats (`heartbeat: 30m` frontmatter, 1s–1y, budget-capped, non-overlapping) and event hooks (`hooks: […]` → debounced enqueue), host-routed |
| `skills`, `skill-proposals` | Scoped `SKILL.md` skills; agent-proposed skills that a human approves into a scope |
| `preference-memory`, `reflections`, `recall` | Approved preferences; per-role journals; episodic recall over past conversations |
| `execution-policy` | Container sandbox policy |
| `auth`, `request-context`, `markdown`, `process`, `platform`, `frontmatter`, `agent-output` | Framework-free helpers for a host UI and OS |

Import by subpath: `import { createRoleRunner } from "medhus-crewrun/runner"`.

## Providers and auth

A runner profile names an engine, a provider, a model, a thinking effort, and how it authenticates:

| `auth` | Behaviour |
|---|---|
| *(absent — auto)* | Leaves the vendor runtime's normal credential resolution in place |
| `"subscription"` | For native Claude/Codex SDK profiles, forces local vendor sign-in by stripping ambient API keys |
| `"api-key"` | For direct native-provider profiles, forces the stored key (`secret_ref` or provider default) and fails loudly if none exists |

Routed profiles (`base_url`) speak the Anthropic protocol at a third-party endpoint with a
Bearer token (`ANTHROPIC_AUTH_TOKEN`) and blank `ANTHROPIC_API_KEY` so the token always wins:

- **OpenRouter** (`https://openrouter.ai/api`) — one `OPENROUTER_API_KEY` for the catalog. The
  `openrouter-auto` preset targets `openrouter/auto`; concrete models are discovered from
  `/api/v1/models?supported_parameters=tools` (tool-calling models only).
- **GLM** (`api.z.ai`), **Kimi** (`api.moonshot.ai`), **local servers** (Ollama, LM Studio, llama.cpp).

> **Authentication scope.** Subscription auth is for an operator using their own local vendor
> sign-in. Anthropic permits ordinary use of Claude Code/Agent SDK under eligible subscriptions,
> but third-party products and services must use API keys or a supported cloud provider: they may
> not offer Claude.ai login or route Free, Pro, or Max credentials for their users. See
> [Anthropic's policy](https://code.claude.com/docs/en/legal-and-compliance). Codex officially
> supports local ChatGPT subscription login as well as API-key login; see [OpenAI's
> authentication documentation](https://learn.chatgpt.com/docs/auth).

## Live integration tests

`npm test` skips all live-provider and Docker tests. They are opt-in, make real calls, and never
run from normal CI by accident. The subscription checks force `auth: "subscription"`, so they
exercise the signed-in local Claude or Codex client rather than an ambient API key.

```bash
CREW_LIVE_E2E=1 CREW_LIVE_CLAUDE=1 node --test test/live-e2e.test.js
CREW_LIVE_E2E=1 CREW_LIVE_CODEX=1 node --test test/live-e2e.test.js
CREW_LIVE_E2E=1 CREW_LIVE_OPENROUTER=1 OPENROUTER_API_KEY=… node --test test/live-e2e.test.js
CREW_LIVE_E2E=1 CREW_LIVE_DOCKER=1 node --test test/live-e2e.test.js
```

`CREW_LIVE_OPENROUTER_MODEL` selects a model for the OpenRouter run;
`CREW_LIVE_DOCKER_IMAGE` selects the Docker image.

## The crew loop: schedules, heartbeats, hooks, handoffs

Run everything with one command — or compose the same loop from the library:

```bash
npx crewrun up <targetRoot>                      # schedules + heartbeats on the kernel's tool-less runner
npx crewrun up <targetRoot> --host ./host.mjs    # your tools, turn recording, hook routing, lifecycle
npx crewrun roles check <targetRoot>             # validate role heartbeat/hook settings
```

```js
import { createUp, loadHostModule } from "medhus-crewrun/up";
const up = createUp({ targetRoot, host: await loadHostModule("./host.mjs", { targetRoot }) });
await up.start();
```

A host module is a plain object (or `createHost({ targetRoot, log })` factory) with optional
`runTurn`, `runSchedule`, `enqueue` (hook delivery — hooks disable politely without it),
`routeEvent`, `renderEvent`, `spentToday`, `tick` (housekeeping), and `start`/`stop`.

**Heartbeats and hooks** are declared per role, in the same frontmatter the runner reads —
flat keys, absent means off:

```yaml
heartbeat: 30m                       # off | 1s … 1y (s|m|h|d|w|mo|y) — a duration enables the pulse
heartbeat_prompt: optional override
heartbeat_budget_usd_per_day: 2      # optional daily cap via the host's spentToday
hooks: [task.assigned, run.failed]   # event names are the host's; the kernel routes and debounces
```

A heartbeat is a periodic autonomous turn: missed windows fire once, a pulse never overlaps
itself, and run state lives in the crew home. A hook firing is delivered through the host's
enqueue with a debounced externalId, so bursts and retries coalesce (`pulse` module).

Four ways work reaches a role without a person typing in a chat — hooks and heartbeats above, plus:

- **Handoffs** — `enqueueHandoff({ targetRoot, conversationId, taskKey, body, externalId })` queues an input
  for a role's singleton thread (a task's manager conversation). A worker claims a bounded
  batch under a lease; queued bodies are attached to the transcript exactly once, retries never
  duplicate them, an expired lease makes a crashed worker's batch reclaimable, and an
  `externalId` makes a retried caller idempotent.
- **Schedules** — `<crew dir>/schedules.json` holds `{ id, role, cron, prompt, enabled }` entries
  (numeric five-field cron in local time; `*`, lists, ranges, and steps are supported).
  `createScheduler({ targetRoot, run })` ticks, fires each due schedule once (a schedule that
  missed several windows fires once, not per window), and records outcomes under the crew home
  so the repository never churns. Scheduling is deliberately **host-owned**: this helper is for
  one scheduler process per project, not distributed claiming. A multi-process host must elect
  one scheduler owner or claim scheduled work transactionally in its own database/queue before
  it calls `runner.runRoleCapture`; `handoffs` shows the token-and-expiry claim pattern. A run
  whose scheduler process died becomes due after an hour by default (`staleAfterMs`).

## Memory and learning

crewrun's position on agent memory is *proposed → approved → versioned file*. Nothing an agent
writes becomes durable context on its own; every layer is a plain file in the crew directory a
human can read, edit, and revoke.

| Layer | What it is | Who writes it |
|---|---|---|
| Role memory | Files named in a role's `memory_pointers`, injected into every turn (a doctrine, house rules, domain notes) | Humans; versioned with the repo |
| Skills | `.crew/skills/<id>/SKILL.md` — reusable, scoped workflows (user → workspace → repository), indexed in the prompt and loaded on demand | Humans, or agents via **skill proposals** a human approves |
| Preferences | Short approved statements with repository > workspace > user precedence | Agents propose (`preference-memory`), humans approve |
| Reflections | A per-role append-only journal ("what worked, what to avoid"), read back bounded and injected as a prompt section | The role, at the end of a turn; humans review and prune |
| Recall | "What happened last time this role touched this task or file" — a query over the conversation store, summarised to ask + outcome | Nobody; it is derived |

What it deliberately does not do: unsupervised "remember everything" vector memory. Silent
drift, no provenance, and nothing to revoke are the failure modes that model avoids.

## Host integration

The supported embedding boundary is [Host API and schema contract v1](docs/host-api-v1.md).
The notes below explain the host-owned pieces behind that contract.

crewrun has neutral defaults and no product identity; a host injects its own.

- **State directory.** `.crew/` by default. Call `configureCrew({ dirName, legacyEnvPrefix })`
  once before the first use to brand it (a host might choose `.acme` and accept its older `ACME_*` env).
  The session cookie name follows it.
- **Environment.** Every override reads `CREW_<NAME>` (then the configured legacy prefix):
  `HOME`, `SECRETS_FILE`, `RUNNERS_FILE`, `MODEL_CATALOG_FILE`, `AUTH_FILE`, `WORKSPACE`,
  `EXTRA_PATH`, `MCP_ROLE`, `MCP_CONTEXT_FILE`, `MCP_AUTH_FILE`.
- **Runner hooks.** `createRoleRunner({ tools, displayRoleName, universalMemory, memoryTitles,
  extraMemory, capabilityProfile, capabilityInstructions, protocol, turnInstructions,
  proposeModeInstruction, createWorktree, container, noise })` — all optional. Memory files a
  host wants in every prompt (a doctrine, house rules) are the host's files, named in
  `universalMemory`; the runtime injects none by itself.
- **Tool registry.** `createMcpBridge({ serverName, toolsForRole, describe, inputSchema, call,
  validate?, alwaysLoad?, instructions?, toolInstructions?, enabled?, serializeContext?,
  childEnvPassthrough?, childEnvPrefixes?, childAuthEnv?, stdioServerEntry? })`.
- **Two host entry scripts.** Codex and the container sandbox run tools in a child process, so
  a host ships a stdio MCP server entry (`serveStdio({ bridge, role, toolContext })`) and a
  container worker entry (`runContainerWorker({ engineId, tools })`), passed as
  `stdioServerEntry` and `container.workerEntry`.
- **Storage.** `budget` and `conversations` take a `getDb()` returning a better-sqlite3-compatible
  handle; the host owns the file. `work-items` takes a directory.

## Security notes

- API keys live in one AES-256-GCM file (`~/.crew/secrets.json`, kept at mode 0600 on every write) sealed
  with the operator password; they are exported to vendor SDKs as environment variables only
  for the duration of the process that unlocked the store.
- Codex reaches host tools through a child process. The tool context crosses that boundary as
  plain data (no closures); remote-auth tokens travel in a 0600 file, never in the child
  environment.
- Execute mode is opt-in per profile; shell access inside it is a second opt-in
  (`allow_shell`). The container runtime drops all capabilities, mounts the repository
  read-only, and refuses to mount subscription credentials — API keys only.

## Develop

```bash
npm install
npm test
```

Node 20 or newer. Runtime dependencies: the Claude Agent SDK, the Codex SDK, the MCP SDK, zod.
`better-sqlite3` is a dev dependency for the ledger and conversation tests only.

Contributions: keep the runtime host-neutral — anything with a product name in it belongs in a
host. Smallest correct change, no speculative structure, no casual dependencies.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
