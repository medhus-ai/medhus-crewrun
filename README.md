# crewrun

**The self-hosted, vendor-neutral, git-governed runtime for AI crews you're accountable for.**

Run a crew of AI agents on the agent runtimes you already use — with agent configuration,
authority, schedules, and shared learning kept as reviewable project state. Vendor-native
schedules and coworker connectors are convenience on their infrastructure; crewrun is control
on yours, and the two complement each other.

crewrun is a small Node library for building your own multi-agent agent system on top of the
vendors' *agent* runtimes — the Claude Agent SDK, the Codex SDK, or any CLI — instead of raw
model APIs. Define agents as small JSON specs plus optional Markdown, route each agent to a
provider and model, give it a versioned authority contract, expose tools under reviewed permissions over
MCP, sandbox edits in a git worktree or a container, and keep a ledger of what every run cost.

- **Local sign-ins, not credential delegation.** An operator can run native Claude and Codex
  turns with their own local `claude` / `codex` sign-in. This does not turn a subscription into
  an API key or let a hosted product accept, relay, or share another user's subscription.
  Anthropic, OpenAI, OpenRouter, GLM, Kimi, and local-server API routes work too; choose per agent.
- **One key, any model.** OpenRouter's whole catalog is a provider; local Ollama / LM Studio /
  llama.cpp servers are another.
- **Agents are files.** A agent is one JSON spec — `.crew/agents/<role>.json` holds its runner,
  memory pointers, contract, hooks, heartbeat, and schedules, with `_defaults.json` supplying a
  shared floor — plus optional Markdown prose injected via its own pointers. No framework classes.
- **Authority is enforceable.** A host joins an agent contract and per-agent allowlist in the broker;
  it checks again at invocation, and high-impact actions can require host approval and append a
  redacted audit record.
- **MCP is a host-tool bridge.** `createMcpBridge` serves the tools your host defines to Claude
  in-process and Codex over stdio. It is not a client for discovering, configuring, or proxying
  arbitrary remote MCP servers.
- **Edits are isolated.** Execute-mode turns run in a dedicated git worktree on a fresh branch,
  or inside a locked-down Docker container. Propose mode is read-only.
- **Usage can be accounted for.** Attach the budget ledger to record token counts, reported cost, duration, and result per run,
  aggregated per month, project, engine, and runner — with cost estimates for subscription runs.

crewrun was extracted from production hosts in two very different domains and carries no
opinion about *what* your agents do.

## Start with the CLI

From this checkout (Node 20 or newer):

```bash
npm install
node bin/crewrun.js up . --console
```

Open **http://127.0.0.1:4400**, choose **Agents → Add agent**, describe its job, and select
an installed runner. Create an immediate task under **Tasks**, or add recurring work under **Scheduled**. The loop runs while the command
stays open. You can open an empty project; no hand-written configuration or host module is required.

For the published package:

```bash
npm install -g medhus-crewrun
crewrun up ./my-project --console       # run agents and open the local operations UI
crewrun console ./my-project            # manage settings and approvals without scheduled turns
crewrun agents check ./my-project       # check agent settings
crewrun proposals list ./my-project     # review proposed learning
```

The commands above use your installed version; changes on GitHub main reach npm only after a
release. A signed-in supported vendor runtime or a configured API runner is needed to run turns.

## Recoverable tasks and visible results

Standalone mode now includes a transactional SQLite run store, durable delivery outbox and the
existing usage ledger. **Tasks** shows saved artifacts, external receipts, required approvals,
blocked dependencies, retry times, and the next action. Use **Accept deliverable** after reviewing
the result; **Usage** shows recorded cost per accepted deliverable, keeping estimates visible.

Pause or cancel tasks from their detail page. Queued work survives a restart. Interrupted model
turns require review and an explicit retry; resume restarts a paused turn from its saved task,
not from an exact model checkpoint. An external send already in flight can still complete.
Ambiguous sends require reconciliation before any resend. [Recovery and storage details](docs/runtime-recovery.md).

## Slack and Gmail, with or without a host

Open **Integrations** in either console command. Standalone Crewrun verifies and stores your
connection locally, refreshes Gmail access tokens, and gives permitted agents the same narrow
Slack/Gmail tools available to embedded hosts. A custom `--host` module is optional.

- **Slack:** install your Slack app with `chat:write`, invite it to the destination channel,
  and enter its OAuth token. Add `app_mentions:read` for the reply-to-mention action.
- **Gmail:** enable the Gmail API in your Google project, obtain a client ID, client secret,
  and refresh token with `gmail.compose`, then enter them in Integrations. Inbox search and
  reads need both the explicit checkbox and `gmail.readonly` (or a supported broader grant).
- **Agent permissions:** in the agent's contract controls, add `slack.postMessage | external-write`
  or `gmail.sendDraft | external-write`. Add `connector:slack:slack` or `connector:gmail:gmail`
  under data the agent may change. For Gmail reads, grant `gmail.searchMetadata | read` and/or
  `gmail.getMessage | read`, plus `connector:gmail:gmail` under data it may read.
- **Review and deliver:** outgoing requests appear in Approvals with the message or draft
  contents. Approval durably queues the reviewed request; the worker rechecks authority before delivery. A changed draft,
  account, or contract needs a new review. Receipts and unresolved deliveries appear in the task timeline.

Gmail currently sends an **existing draft**; draft creation and incoming Slack mention/event
subscriptions are not part of the standalone adapter. Use the [Slack host example](examples/slack/README.md)
for event-driven intake. Provider consent and credentials are still required; no separate hosted
application is required for standalone outbound actions.

Standalone credentials and pending review payloads live in a project-specific file under
`~/.crew/connections/` (`CREW_HOME` overrides this), outside the repository, with mode 0600 on
POSIX. This file uses OS permissions, not the encrypted API-key vault. Disconnect removes the
local credentials and pending payloads; revoke the token at the provider to revoke its grant.
Run one operator process per project. The file queues are not distributed transaction stores.

See the official [Slack token guide](https://docs.slack.dev/authentication/tokens/),
[Google OAuth setup](https://developers.google.com/identity/protocols/oauth2/native-app), and
[Gmail draft sending scope requirements](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send).

## Use the library

```bash
npm install medhus-crewrun
# From a checkout of this repository:
node examples/brief.mjs
```

The example needs a signed-in `claude` CLI or `ANTHROPIC_API_KEY`; set `OPENROUTER_API_KEY`
and `CREW_EXAMPLE_RUNNER=openrouter-auto` to run it on OpenRouter instead. What it does, in
order ([examples/brief.mjs](examples/brief.mjs)):

```js
import { createMcpBridge } from "medhus-crewrun/mcp";
import { createAgentRunner } from "medhus-crewrun/runner";
import { createAgentGovernance } from "medhus-crewrun/agent-contract";
import { loadAgentSpec } from "medhus-crewrun/agent-spec";
import { createToolBroker } from "medhus-crewrun/tool-broker";

const governance = createAgentGovernance({
  targetRoot: project,
  requireContracts: true,
  getContract: (role) => loadAgentSpec(project, role)?.contract
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

const runner = createAgentRunner({ tools });
const result = await runner.runAgentCapture({ root: project, role: "ceo", prompt: "Write today's brief." });
```

A project is any directory with a `.crew/` folder. Each agent is a spec at
`agents/<agent>.json`:

```json
{
  "title": "Analyst",
  "runner": "claude-agent-sonnet-high",
  "memory_pointers": [".crew/agents/analyst.md", "docs/analyst-notes.md"],
  "reflections": false,
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

**Web access** is off unless an agent opts in with `"web": true` or `{ "allow": [...], "search":
true, "max_chars": 40000 }`. The runtime then hands the agent the best web tools the engine has:
Claude's own `WebSearch`/`WebFetch` (the allowlist is enforced with a PreToolUse hook), Codex's
built-in web search (open access only — Codex cannot scope hosts), and for every other engine, or
for allowlisted Codex agents, the kernel's built-in `web.fetch` (read-only GET, redirect hops
re-checked, private/loopback addresses refused, HTML→text, capped) and `web.search` (DuckDuckGo,
no key). `*.example.com` covers subdomains; `"search": false` drops search. Agents without `web`
never see any web tool, so the model cannot be talked into browsing.

`agents/_defaults.json` supplies values every agent inherits (its `memory_pointers` prepend as the
shared floor). Contract defaults are a floor too: an agent may add authority, but cannot relax a
default approval requirement or budget cap. Pointers may name any file in the repository —
including the agent's own optional `.md` prose, which is read only when listed. The `instructions`
field is a convenient alternative, editable directly from the Agents page. Reflections are off
by default. When enabled, `memory.reflect` proposes a specific update to context or a Skill;
approval promotes it to that destination. Legacy journals remain on disk and are not injected. Legacy projects keep working: `.md` frontmatter,
`memory/ai-runners.json`, and a global `schedules.json` all still resolve. Concrete runner
profiles are machine-level, in `~/.crew/ai-runners.json`, so keys and vendor choices never enter
a repository.

## Upgrading from Roles

Agents is the product name and the new file/API surface. Existing `.crew/roles` files,
`crewrun roles check`, `/roles` bookmarks, `role` fields, and the `createRoleRunner` and
other role-named library exports remain supported. New projects use `.crew/agents`; existing
files are edited in place. If both folders declare the same agent, its agent file wins, so
its tasks are not scheduled twice. Shared defaults also fall back to the legacy folder.

## What is inside

| Module | Purpose |
|---|---|
| `runner` | `createAgentRunner(host)` → `startAgentTurn`, `runAgentCapture`, prompt assembly, `loadAgentMemory` |
| `engines/*` | `cli` (any vendor CLI), `claude-agent`, `codex-agent`, `container` (Docker sandbox) |
| `mcp`, `mcp-stdio` | `createMcpBridge(registry)` — host-tool MCP server bridge: in-process for Claude, stdio for Codex |
| `tool-broker`, `agent-contract` | Agent allowlist + versioned authority enforcement, handoff checks, and redacted tamper-evident action audit |
| `action-approvals` | Host-local, single-use approval queue for high-impact actions; stores summaries and digests, never action payloads or credentials |
| `runtime-store`, `runtime-scheduler` | Transactional standalone tasks, atomic claims, delivery outbox, recovery, artifacts and trigger cursors |
| `connectors`, `standalone` | Slack/Gmail permissions and actions; standalone connection setup, token refresh, exact action review and provider calls; optional host overrides |
| `crew-tools`, `web` | Built-in tools available on each bridge: proposal-gated learning tools + `skill.read`, and per-agent gated `web.fetch` / `web.search` (all subject to a strict agent contract when one is enforced) |
| `agent-capabilities` | Subagent policy per agent kind; Claude subagent definitions |
| `agents`, `templates` | Agent catalog installer; template reader |
| `runner-config`, `model-catalog` | Runner profiles (global + per-project agent mapping), live model discovery |
| `secret-store` | Encrypted per-operator API-key store (scrypt + AES-256-GCM, 0600 file) |
| `budget` | `createBudgetLedger({ getDb })` — per-run rows, monthly report, subscription cost estimates |
| `conversations` | `createConversationStore({ getDb })` — durable chat threads and messages per project/agent |
| `work-items` | `createWorkItemSource({ dir })` — tasks as markdown files (frontmatter or bold bullets) |
| `handoffs` | `createHandoffQueue({ getDb, governance? })` — durable inputs for an agent's thread: attach once, claim in leased batches, recover after a crash ("wake the manager") |
| `schedules` | Cron-scheduled agent turns: `<crew dir>/schedules.json`, `parseCron`, `dueSchedules`, `createScheduler({ run })` |
| `up` | `createUp({ targetRoot, host })` + the `crewrun up` CLI — the crew loop (schedules, heartbeats, hooks, host housekeeping) around one project; the optional host module injects tools, turn recording, routing, and lifecycle |
| `pulse` | Agent heartbeats (`heartbeat: 30m` frontmatter, 1s–1y, budget-capped, non-overlapping) and event hooks (`hooks: […]` → debounced enqueue), host-routed |
| `skills`, `skill-proposals` | Scoped `SKILL.md` skills; agent-proposed skills that a human approves into a scope |
| `preference-memory`, `reflection-proposals`, `reflections`, `recall` | Approved context and optional improvement proposals; legacy journal readers and episodic recall |
| `execution-policy` | Container sandbox policy |
| `console/*` | Local operations UI for agents, schedules, approvals, audit, connectors, providers, and usage; host data arrives through the stable operations API |
| `auth`, `request-context`, `markdown`, `process`, `platform`, `frontmatter`, `agent-output` | Framework-free helpers for a host UI and OS |

Import by subpath: `import { createAgentRunner } from "medhus-crewrun/runner"`.

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

v0.6 makes an agent contract a first-class part of the agent spec. Contract v1 records its
revision, mandate, allowed tools and data scopes, permitted handoff peers, approval requirements,
and optional limits. A host enforces it with `createAgentGovernance` plus its tool broker; setting
`requireContracts: true` makes uncontracted legacy agents fail closed. With the bundled approval
policy wired into governance, high-impact actions remain visible only to request approval, then
must be claimed and used once by the host immediately before the provider call.

The audit record is append-only and hashes inputs/outputs instead of storing them. It records the
agent, action, model/runner when supplied, authority revision, data scopes, budget, approval, and
outcome. Cross-agent work belongs in the durable handoff queue; authorize both sides with
`governance.authorizeHandoff` rather than using free-form agent chat. The complete schema and
host wiring are in [Governed operations v1](docs/governed-operations-v1.md) and the stable
[Host API and schema contract v1](docs/host-api-v1.md).

## The crew loop: schedules, heartbeats, hooks, handoffs

Run everything with one command — or compose the same loop from the library:

```bash
npx crewrun up <targetRoot> --console            # the loop + the local operator UI (127.0.0.1:4400)
npx crewrun console <targetRoot>                 # UI alone: agents, schedules, approvals, connectors, providers, usage
npx crewrun up <targetRoot>                      # schedules + heartbeats on the kernel runner (built-in tools attached)
npx crewrun up <targetRoot> --host ./host.mjs    # your tools, turn recording, hook routing, lifecycle
npx crewrun agents check <targetRoot>             # validate role heartbeat/hook settings
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

**Heartbeats and hooks** are declared in the agent spec — absent means off:

```json
{ "heartbeat": { "interval": "30m", "budget_usd_per_day": 2 }, "hooks": ["task.assigned"] }
```

(`"heartbeat": "30m"` shorthand works; intervals 1s … 1y as s|m|h|d|w|mo|y.) A heartbeat is a periodic autonomous turn: missed windows fire once, a pulse never overlaps
itself, and run state lives in the crew home. Standalone hooks enqueue durable tasks with a
debounced externalId; embedded hosts may supply their own enqueue implementation (`pulse` module).

Four ways work reaches an agent without a person typing in a chat — hooks and heartbeats above, plus:

- **Handoffs** — `createHandoffQueue({ getDb, governance })` can enforce governed handoffs;
  `enqueueHandoff({ targetRoot, conversationId, taskKey, body, externalId, fromRole })` queues an input
  for an agent's singleton thread (a task's manager conversation). A worker claims a bounded
  batch under a lease; queued bodies are attached to the transcript exactly once, retries never
  duplicate them, an expired lease makes a crashed worker's batch reclaimable, and an
  `externalId` makes a retried caller idempotent. For an agent-originated handoff, the **host** sets
  `fromRole` from the authenticated turn context (never from model-provided input); the queue
  resolves the receiver from the conversation and checks both contracts. Omitting `fromRole`
  preserves the existing trusted host/webhook ingress path, which is not an agent-to-agent handoff.
- **Scheduled tasks** — agent specs hold `{ id, role, cron, prompt, enabled }` entries under
  `"scheduled"` (numeric five-field cron in local time; `*`, lists, ranges, and steps are
  supported); the older agent key `"schedules"` and
  `<crew dir>/schedules.json` remain readable. `createScheduler({ targetRoot, run })` ticks,
  fires each due task once (a task that missed several windows fires once, not per
  window), and records outcomes under the crew home so the repository never churns. Scheduling
  in the exported `createScheduler` helper is for one host scheduler process per project.
  Standalone `up` uses the transactional `runtime-scheduler` instead. A multi-process host must elect one scheduler owner or claim scheduled
  work transactionally in its own database/queue before it calls `runner.runAgentCapture`;
  `handoffs` shows the token-and-expiry claim pattern. A run whose scheduler process died becomes
  due after an hour by default (`staleAfterMs`).

## Memory and learning

Crewrun saves what a model cannot infer reliably: user/application facts, preferences, and
repeatable procedures specific to that user's work. **Skills** is the name throughout the product;
no generic Skills are installed by default. Keep a general procedure only when evidence shows a
reliability benefit. Prefer updating an existing entry over adding another one.

| Layer | Purpose | Persistence |
|---|---|---|
| Agent context | User/application facts, house rules and project details | Reviewed files in `memory_pointers` |
| Skills | Specific procedures with a trigger, inputs and acceptance checks | Flat `.crew/skills/<id>.md` or `<id>/SKILL.md`; loaded when relevant |
| Preferences | Short working preferences, with repository > workspace > user precedence | Agent suggestions require review; trusted operators can save explicit user instructions with `saveUserPreference` |
| Reflections | Optional evidence-backed proposals to update context or a Skill | Off by default, deduplicated while pending, expire after 30 days; approval promotes the update, without appending a journal |
| Recall | Relevant previous asks and outcomes | Derived from the conversation store |

Do not generate reflections after every action or save generic advice the model already knows.
Enable proposals with `"reflections": true` only when useful. Each proposal names `target`
(`preference` or `skill`), a stable `key`, the proposed `text`, and `evidence`; Skill updates also
need a `description`. Existing reflection files remain available for manual migration and are
never automatically injected. Agent-inferred changes still require review.

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
- **Runner hooks.** `createAgentRunner({ tools, displayRoleName, universalMemory, memoryTitles,
  extraMemory, capabilityProfile, capabilityInstructions, protocol, turnInstructions,
  proposeModeInstruction, createWorktree, container, noise })` — all optional. Memory files a
  host wants in every prompt (a doctrine, house rules) are the host's files, named in
  `universalMemory`; the runtime injects none by itself.
- **Tool registry.** `createMcpBridge({ serverName, toolsForRole, describe, inputSchema, call,
  validate?, alwaysLoad?, instructions?, toolInstructions?, enabled?, serializeContext?,
  childEnvPassthrough?, childEnvPrefixes?, childAuthEnv?, stdioServerEntry?, governance?,
  actionPolicy? })`. This starts a server for host tools; it is not a remote MCP client. Pair it
  with `createToolBroker({ allowlists, governance })` and `createAgentGovernance(...)` when agent
  contracts must be enforced.
- **Governed external actions.** Use `createActionApprovalPolicy({ targetRoot })` for the small
  local approval queue, or provide the same request/claim semantics through your host database.
  Use `createStandaloneRuntime({ targetRoot })` for the built-in Slack/Gmail adapter, or
  `createConnectorRegistry(...)` with your own OAuth, token storage, and provider invocation.
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
