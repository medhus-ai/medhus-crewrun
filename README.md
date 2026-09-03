# crewrun

**The self-hosted, vendor-neutral, git-governed runtime for AI crews you're accountable for.**

Run a crew of AI roles on the agent runtimes you already use — with role configuration,
authority, schedules, and shared learning kept as reviewable project state. Vendor-native
schedules and coworker connectors are convenience on their infrastructure; crewrun is control
on yours, and the two complement each other.

crewrun is a small Node library for building your own multi-role agent system on top of the
vendors' *agent* runtimes — the Claude Agent SDK, the Codex SDK, or any CLI — instead of raw
model APIs. Define roles as small JSON specs plus optional Markdown, route each role to a
provider and model, give it a versioned authority contract, expose only approved host tools over
MCP, sandbox edits in a git worktree or a container, and keep a ledger of what every run cost.

- **Local sign-ins, not credential delegation.** An operator can run native Claude and Codex
  turns with their own local `claude` / `codex` sign-in. This does not turn a subscription into
  an API key or let a hosted product accept, relay, or share another user's subscription.
  Anthropic, OpenAI, OpenRouter, GLM, Kimi, and local-server API routes work too; choose per role.
- **One key, any model.** OpenRouter's whole catalog is a provider; local Ollama / LM Studio /
  llama.cpp servers are another.
- **Roles are files.** A role is one JSON spec — `.crew/roles/<role>.json` holds its runner,
  memory pointers, contract, hooks, heartbeat, and schedules, with `_defaults.json` supplying a
  shared floor — plus optional Markdown prose injected via its own pointers. No framework classes.
- **Authority is enforceable.** A host joins a role contract and per-role allowlist in the broker;
  it checks again at invocation, and high-impact actions can require host approval and append a
  redacted audit record.
- **MCP is a host-tool bridge.** `createMcpBridge` serves the tools your host defines to Claude
  in-process and Codex over stdio. It is not a client for discovering, configuring, or proxying
  arbitrary remote MCP servers.
- **Edits are isolated.** Execute-mode turns run in a dedicated git worktree on a fresh branch,
  or inside a locked-down Docker container. Propose mode is read-only.
- **Everything is accounted for.** Token counts, reported cost, duration, and result per run,
  aggregated per month, project, engine, and runner — with cost estimates for subscription runs.

crewrun was extracted from production hosts in two very different domains and carries no
opinion about *what* your roles do.

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
import { createRoleGovernance } from "medhus-crewrun/role-contract";
import { loadRoleSpec } from "medhus-crewrun/role-spec";
import { createToolBroker } from "medhus-crewrun/tool-broker";

const governance = createRoleGovernance({
  targetRoot: project,
  requireContracts: true,
  getContract: (role) => loadRoleSpec(project, role)?.contract
});
const broker = createToolBroker({ allowlists: { ceo: ["inbox.list"] }, governance });
const tools = createMcpBridge({
  serverName: "company",
  governance,
  toolsForRole: (role) => broker.toolsForRole(role),
  describe: () => "List work items, optionally filtered by status.",
  inputSchema: (name, z) => ({ status: z.string().optional() }),
  call: ({ role, toolName, input }) => broker.callTool({ role, toolName, input, registry })
});

const runner = createRoleRunner({ tools });
const result = await runner.runRoleCapture({ root: project, role: "ceo", prompt: "Write today's brief." });
```

A project is any directory with a `.crew/` folder. Each role is a spec at
`roles/<role>.json`:

```json
{
  "title": "Analyst",
  "runner": "claude-agent-sonnet-high",
  "memory_pointers": [".crew/roles/analyst.md", "docs/analyst-notes.md"],
  "reflections": { "limit": 10 },
  "hooks": ["task.assigned"],
  "heartbeat": "off",
  "web": { "allow": ["*.arxiv.org", "github.com"] },
  "scheduled": [{ "id": "brief", "cron": "30 8 * * 1-5", "prompt": "…", "enabled": true }],
  "contract": {
    "version": 1,
    "revision": 1,
    "mandate": "Prepare a daily research brief.",
    "authority": { "tools": [{ "name": "inbox.list", "impact": "read" }] }
  }
}
```

**Web access** is off unless a role opts in with `"web": true` or `{ "allow": [...], "search":
true, "max_chars": 40000 }`. The runtime then hands the role the best web tools the engine has:
Claude's own `WebSearch`/`WebFetch` (the allowlist is enforced with a PreToolUse hook), Codex's
built-in web search (open access only — Codex cannot scope hosts), and for every other engine, or
for allowlisted Codex roles, the kernel's built-in `web.fetch` (read-only GET, redirect hops
re-checked, private/loopback addresses refused, HTML→text, capped) and `web.search` (DuckDuckGo,
no key). `*.example.com` covers subdomains; `"search": false` drops search. Roles without `web`
never see any web tool, so the model cannot be talked into browsing.

`roles/_defaults.json` supplies values every role inherits (its `memory_pointers` prepend as the
shared floor). Contract defaults are a floor too: a role may add authority, but cannot relax a
default approval requirement or budget cap. Pointers may name any file in the repository —
including the role's own optional `.md` prose, which is read only when listed. A bounded window
of the role's **operator-approved** reflections (`memory.reflect` creates a proposal) is
injected back each turn. Legacy projects keep working: `.md` frontmatter,
`memory/ai-runners.json`, and a global `schedules.json` all still resolve. Concrete runner
profiles are machine-level, in `~/.crew/ai-runners.json`, so keys and vendor choices never enter
a repository.

## What is inside

| Module | Purpose |
|---|---|
| `runner` | `createRoleRunner(host)` → `startRoleTurn`, `runRoleCapture`, prompt assembly, `loadRoleMemory` |
| `engines/*` | `cli` (any vendor CLI), `claude-agent`, `codex-agent`, `container` (Docker sandbox) |
| `mcp`, `mcp-stdio` | `createMcpBridge(registry)` — host-tool MCP server bridge: in-process for Claude, stdio for Codex |
| `tool-broker`, `role-contract` | Role allowlist + versioned authority enforcement, handoff checks, and redacted tamper-evident action audit |
| `action-approvals` | Host-local, single-use approval queue for high-impact actions; stores summaries and digests, never action payloads or credentials |
| `connectors` | Narrow Slack/Gmail action descriptors and OAuth URL metadata; the host owns OAuth callbacks, tokens, and provider calls |
| `crew-tools`, `web` | Built-in tools available on each bridge: proposal-gated learning tools + `skill.read`, and per-role gated `web.fetch` / `web.search` (all subject to a strict role contract when one is enforced) |
| `role-capabilities` | Subagent policy per role kind; Claude subagent definitions |
| `roles`, `templates` | Role catalog installer; template reader |
| `runner-config`, `model-catalog` | Runner profiles (global + per-project role mapping), live model discovery |
| `secret-store` | Encrypted per-operator API-key store (scrypt + AES-256-GCM, 0600 file) |
| `budget` | `createBudgetLedger({ getDb })` — per-run rows, monthly report, subscription cost estimates |
| `conversations` | `createConversationStore({ getDb })` — durable chat threads and messages per project/role |
| `work-items` | `createWorkItemSource({ dir })` — tasks as markdown files (frontmatter or bold bullets) |
| `handoffs` | `createHandoffQueue({ getDb, governance? })` — durable inputs for a role's thread: attach once, claim in leased batches, recover after a crash ("wake the manager") |
| `schedules` | Cron-scheduled role turns: `<crew dir>/schedules.json`, `parseCron`, `dueSchedules`, `createScheduler({ run })` |
| `up` | `createUp({ targetRoot, host })` + the `crewrun up` CLI — the crew loop (schedules, heartbeats, hooks, host housekeeping) around one project; the optional host module injects tools, turn recording, routing, and lifecycle |
| `pulse` | Role heartbeats (`heartbeat: 30m` frontmatter, 1s–1y, budget-capped, non-overlapping) and event hooks (`hooks: […]` → debounced enqueue), host-routed |
| `skills`, `skill-proposals` | Scoped `SKILL.md` skills; agent-proposed skills that a human approves into a scope |
| `preference-memory`, `reflection-proposals`, `reflections`, `recall` | Approved preferences and per-role journals; episodic recall over past conversations |
| `execution-policy` | Container sandbox policy |
| `console/*` | Local operations UI for roles, schedules, approvals, audit, connectors, providers, and usage; host data arrives through the stable operations API |
| `auth`, `request-context`, `markdown`, `process`, `platform`, `frontmatter`, `agent-output` | Framework-free helpers for a host UI and OS |

Import by subpath: `import { createRoleRunner } from "medhus-crewrun/runner"`.

## Providers and auth

A runner profile names an engine, a provider, a model, a thinking effort, and how it authenticates:

| `auth` | Behaviour |
|---|---|
| *(absent — auto)* | Leaves the vendor runtime's normal credential resolution in place |
| `"subscription"` | Native Claude/Codex only: removes the relevant API-key environment variable so the installed runtime can use the **local operator's** existing sign-in |
| `"api-key"` | Forces the stored key (`secret_ref` or provider default) for a direct provider profile and fails loudly if none exists |

Routed profiles (`base_url`) speak the Anthropic protocol at a third-party endpoint with a
Bearer token (`ANTHROPIC_AUTH_TOKEN`) and blank `ANTHROPIC_API_KEY` so the token always wins:

- **OpenRouter** (`https://openrouter.ai/api`) — one `OPENROUTER_API_KEY` for the catalog. The
  `openrouter-auto` preset targets `openrouter/auto`; concrete models are discovered from
  `/api/v1/models?supported_parameters=tools` (tool-calling models only).
- **GLM** (`api.z.ai`), **Kimi** (`api.moonshot.ai`), **local servers** (Ollama, LM Studio, llama.cpp).

> **Authentication scope.** Subscription mode selects an already-authenticated local vendor
> runtime; CrewRun never reads, copies, stores, or forwards a subscription credential. It is for
> the operator running CrewRun on their own machine. A product acting for other users needs its
> own API-key or supported cloud-provider integration. Review the current
> [Anthropic policy](https://code.claude.com/docs/en/legal-and-compliance) and
> [OpenAI guidance for using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) before deploying.

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

## Governed operations

v0.6 makes a role contract a first-class part of the role spec. Contract v1 records its
revision, mandate, allowed tools and data scopes, permitted handoff peers, approval requirements,
and optional limits. A host enforces it with `createRoleGovernance` plus its tool broker; setting
`requireContracts: true` makes uncontracted legacy roles fail closed. With the bundled approval
policy wired into governance, high-impact actions remain visible only to request approval, then
must be claimed and used once by the host immediately before the provider call.

The audit record is append-only and hashes inputs/outputs instead of storing them. It records the
role, action, model/runner when supplied, authority revision, data scopes, budget, approval, and
outcome. Cross-role work belongs in the durable handoff queue; authorize both sides with
`governance.authorizeHandoff` rather than using free-form agent chat. The complete schema and
host wiring are in [Governed operations v1](docs/governed-operations-v1.md) and the stable
[Host API and schema contract v1](docs/host-api-v1.md).

## The crew loop: schedules, heartbeats, hooks, handoffs

Run everything with one command — or compose the same loop from the library:

```bash
npx crewrun up <targetRoot> --console            # the loop + the local operator UI (127.0.0.1:4400)
npx crewrun console <targetRoot>                 # UI alone: roles, schedules, approvals, connectors, providers, usage
npx crewrun up <targetRoot>                      # schedules + heartbeats on the kernel runner (built-in tools attached)
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
`routeEvent`, `renderEvent`, `spentToday`, `tick` (housekeeping), and `start`/`stop`. Its optional
`operations` object feeds the local console's usage, provider, connector, approval, audit, and
contract cards and handles Connect / Disconnect / approval decisions. See the stable
[Host API and schema contract v1](docs/host-api-v1.md).

**Heartbeats and hooks** are declared in the role spec — absent means off:

```json
{ "heartbeat": { "interval": "30m", "budget_usd_per_day": 2 }, "hooks": ["task.assigned"] }
```

(`"heartbeat": "30m"` shorthand works; intervals 1s … 1y as s|m|h|d|w|mo|y.) A heartbeat is a periodic autonomous turn: missed windows fire once, a pulse never overlaps
itself, and run state lives in the crew home. A hook firing is delivered through the host's
enqueue with a debounced externalId, so bursts and retries coalesce (`pulse` module).

Four ways work reaches a role without a person typing in a chat — hooks and heartbeats above, plus:

- **Handoffs** — `createHandoffQueue({ getDb, governance })` can enforce governed handoffs;
  `enqueueHandoff({ targetRoot, conversationId, taskKey, body, externalId, fromRole })` queues an input
  for a role's singleton thread (a task's manager conversation). A worker claims a bounded
  batch under a lease; queued bodies are attached to the transcript exactly once, retries never
  duplicate them, an expired lease makes a crashed worker's batch reclaimable, and an
  `externalId` makes a retried caller idempotent. For a role-originated handoff, the **host** sets
  `fromRole` from the authenticated turn context (never from model-provided input); the queue
  resolves the receiver from the conversation and checks both contracts. Omitting `fromRole`
  preserves the existing trusted host/webhook ingress path, which is not a role-to-role handoff.
- **Scheduled tasks** — role specs hold `{ id, role, cron, prompt, enabled }` entries under
  `"scheduled"` (numeric five-field cron in local time; `*`, lists, ranges, and steps are
  supported); the older role key `"schedules"` and
  `<crew dir>/schedules.json` remain readable. `createScheduler({ targetRoot, run })` ticks,
  fires each due task once (a task that missed several windows fires once, not per
  window), and records outcomes under the crew home so the repository never churns. Scheduling
  is deliberately **host-owned**: this helper is for one scheduler process per project, not
  distributed claiming. A multi-process host must elect one scheduler owner or claim scheduled
  work transactionally in its own database/queue before it calls `runner.runRoleCapture`;
  `handoffs` shows the token-and-expiry claim pattern. A run whose scheduler process died becomes
  due after an hour by default (`staleAfterMs`).

## Memory and learning

CrewRun keeps durable learning *proposed → approved → reviewable*. Role memory pointers, skills,
preferences, contracts, and per-role reflections are inspectable project state a human can edit
or revoke. Reflections remain bounded and private to their role, rather than becoming unbounded
shared memory.

| Layer | What it is | Who writes it |
|---|---|---|
| Role memory | Files named in a role's `memory_pointers`, injected into every turn (a doctrine, house rules, domain notes) | Humans; versioned with the repo |
| Skills | `.crew/skills/<id>/SKILL.md` — reusable, scoped workflows (user → workspace → repository), indexed in the prompt and loaded on demand | Humans, or agents via **skill proposals** a human approves |
| Preferences | Short approved statements with repository > workspace > user precedence | Agents propose (`preference-memory`), humans approve |
| Reflections | A bounded per-role journal ("what worked, what to avoid"), injected only for that role | Roles propose through `memory.reflect`; an operator approves the entry |
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
  childEnvPassthrough?, childEnvPrefixes?, childAuthEnv?, stdioServerEntry?, governance?,
  actionPolicy? })`. This starts a server for host tools; it is not a remote MCP client. Pair it
  with `createToolBroker({ allowlists, governance })` and `createRoleGovernance(...)` when role
  contracts must be enforced.
- **Governed external actions.** Use `createActionApprovalPolicy({ targetRoot })` for the small
  local approval queue, or provide the same request/claim semantics through your host database.
  Use `createConnectorRegistry(...)` for the narrow Slack/Gmail actions; the host owns OAuth,
  token storage, and provider invocation.
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
