# Host API reference

[Documentation](README.md) / Host API reference

This is the supported embedding boundary for a host application. `targetRoot` means the
absolute path to one project; `agent` and the compatible `role` fields identify an agent by its
lowercase slug (`[a-z][a-z0-9-]{0,79}`). Start with [Library integration](library.md) for examples.

## Compatibility

- A compatible v1 release keeps the named functions, required inputs, and named return fields
  below. It may add optional fields.
- A breaking host-surface or file-schema change requires a new contract version and migration
  notes. The npm package is still pre-1.0, so hosts should pin and test a package version.
- Exports not named here are useful implementation utilities, but are not part of this stable
  host contract yet. The named governance, approval, connector, console-operations,
  runner, scheduler, and MCP surfaces below are the supported boundary.

## Turn runner

`createAgentRunner(options)` from `medhus-crewrun/runner` is the primary runtime boundary. Its
`tools` option is a bridge returned by `createMcpBridge`; all other hooks are optional host
presentation, prompt, memory, capability, worktree, and container customizations.
It returns `startAgentTurn`, `runAgentCapture`, `generateConversationTitle`, and the existing
role-named prompt/memory helpers. `createRoleRunner`, `startRoleTurn`, and `runRoleCapture`
remain available for compatibility and use a `role` input instead of `agent`.

```js
const turn = runner.startAgentTurn({
  targetRoot,                         // string, required
  agent,                              // agent slug, required
  messages: [{ author, content }],    // array of objects with string fields
  resumeSessionId,                    // optional vendor session id
  worktree: { dir, branch },          // optional prior execute worktree
  readOnlyWorktree: { dir, branch },  // optional review worktree
  context: "",                        // optional host prompt context
  toolContext: {},                    // optional host data for allowed tools
  modeOverride: "propose",             // optional: "propose" | "execute"
  onLine, onPartialText, onStatus, onClose, onError
});
```

It returns a handle with `kill(signal?)`, plus `runnerId`, `engineId`, `mode`, `isolation`
(`"read-only"`, `"worktree"`, or `"container"`), `branch`, `workdir`, `worktreeCreated`,
`resumed`, `capabilities`, and `provider`. Invalid agents or runner configuration throw before a
turn starts.

`onClose` receives `{ code, stderr?, usage?, engineSessionId?, tools? }`. When reported,
`usage` is `{ inputTokens, outputTokens, costUsd }`, with unavailable values represented by
`null`. `onLine`, `onPartialText`, and `onStatus` receive a string; `onError` receives an error.

For a headless one-shot, `runAgentCapture({ root, agent, prompt, signal, ... })` resolves to
`{ ok: true, text }` or `{ ok: false, reason, text }`; it does not reject for a runner timeout
or non-zero runner exit. It accepts an optional AbortSignal and also returns `usage`, `runnerId`,
`engineId`, `provider`, and `engineSessionId` when available.

## Host tool bridge

`createMcpBridge(registry)` from `medhus-crewrun/mcp` exposes **host-defined tools** to an
agent. It is a server bridge, not an external MCP client: it does not discover, configure, or
proxy arbitrary remote MCP servers.

The registry requires:

```js
{
  serverName: "company",
  toolsForRole(role, roleOptions) { return ["inbox.list"]; },
  describe(toolName) { return "List inbox items."; },
  inputSchema(toolName, z) { return { status: z.string().optional() }; },
  async call({ role, toolName, input, context, roleOptions }) { return { items: [] }; }
}
```

`inputSchema` returns a Zod raw shape (or `{}`), and `call` may return any JSON-serializable
value. The bridge returns normal MCP text and structured-content results; an error becomes an
MCP error result instead of escaping the tool call.

Optional registry hooks are `label`, `toolLineMarker`, `instructions`, `enabled(toolContext)`,
`validate(toolName, input)` returning `{ ok, input? | error? }`, `alwaysLoad(toolName)`,
`toolInstructions(role, toolContext, toolNames)`, and `serializeContext(toolContext)`. A governed
registry may also supply `governance` from `createAgentGovernance` and
`actionPolicy(toolName, { role, ...toolContext })`, which returns the tool's real
`{ impact, data }` classification before it is exposed.

The returned bridge has `serverName`, `label`, `toolLineMarker`, `enabled`, `toolHandlers`,
`createClaudeMcp`, `claudeToolInstructions`, `codexMcpConfig`, `serializeContext`, and the
original `registry`. `createToolBroker` returns `toolsForRole`, `canCallTool`, and `callTool`.

Use `createToolBroker({ allowlists, fallbackTools?, extraTools?, sharedTools?, governance? })`
from `medhus-crewrun/tool-broker` when the host needs enforcement as well as filtering. Its
`callTool({ role, toolName, input, context, registry, roleOptions, approval?, data?, impact? })`
checks the agent allowlist and, when configured, its contract again before it invokes
`registry[toolName](input, { role, context })`. The bridge applies the same contract filter to
Crewrun's built-in tools, so a model cannot recover a denied capability through MCP registration.

For Claude, the bridge is an in-process MCP server. For Codex, `codexMcpConfig` starts the
host's `stdioServerEntry` as a child MCP server. That entry reconstructs plain-data context with
`mcpRoleFromEnv()` and `readMcpContextData()`, then calls
`serveStdio({ bridge, role, toolContext })` from `medhus-crewrun/mcp-stdio`. Only declared,
serializable context crosses the process boundary; `childAuthEnv` keys are written to a 0600
file and must be loaded explicitly with `loadMcpAuthEnv(keys)`.

The bridge deliberately has no remote-server discovery, remote MCP configuration, OAuth token
forwarding, or generic proxy capability. If a host wants to use a remote service, it implements a
narrow host action and exposes that action through this registry.

## Governed agent contract

The primary agent file may contain a `contract` object. Contract v1 is a JSON-safe, reviewable
policy, not an agent prompt or a source of credentials:

```json
{
  "version": 1,
  "revision": 3,
  "mandate": "Triage support requests and prepare approved replies.",
  "authority": {
    "tools": [{ "name": "slack.replyToMention", "impact": "external-write" }],
    "data": { "read": ["support-ticket:*"], "write": ["connector:slack:support"] },
    "handoffs": { "send": ["support-manager"], "receive": ["triage"] }
  },
  "approvals": { "required_for": ["external-write"] },
  "budget": { "max_usd_per_run": 2, "max_usd_per_month": 40 }
}
```

`authority.tools` entries accept `name`, `impact` (`read`, `internal-write`,
`external-write`, `destructive`, or `financial`), optional `approval_required`, and optional
per-tool `data` scopes. Agent-wide `authority.data` has `read` and `write` scope lists;
`authority.handoffs` has `send` and `receive` agent lists. `budget` may set
`max_usd_per_run`, `max_usd_per_month`, `max_tokens_per_run`, and `max_runs_per_day`.
`external-write`, `destructive`, and `financial` require approval by default; `approvals` can
only add requirements. Contract defaults from `agents/_defaults.json` are a shared floor: tools
and scopes merge additively, while approval requirements and budgets only become stricter.

Use the v1 facade to evaluate authority at every boundary:

```js
import { createAgentGovernance } from "medhus-crewrun/agent-contract";
import { loadAgentSpec } from "medhus-crewrun/agent-spec";

const governance = createAgentGovernance({
  targetRoot,
  requireContracts: true,
  getContract: (role) => loadAgentSpec(targetRoot, role)?.contract
});
```

It exposes `contractFor(role)`, `summaryForRole(role)`, `authorizeAction({ role, toolName,
impact, data, approval })`, `authorizeHandoff({ role: actorRole, peerRole, direction })`, and
`recordAction(record)`. For a send, `peerRole` is the recipient; for a receive, it is the sender
(`recipientRole` / `senderRole` aliases are also accepted). `authorizeAction` returns a stable
decision with `allowed`, `decision` (`allowed`, `approval-required`, `denied`, or legacy),
authority version/revision/fingerprint, effective impact, and safe data scopes. With
`requireContracts: true`, an agent without a contract is denied. The broker invokes it for tools;
a host must use `authorizeHandoff` at each durable-handoff boundary, or pass governance to the
queue below for its enqueue-side check. These methods retain the `role` property name even
when constructed through the `createAgentGovernance` alias.

### Durable governed handoffs

`createHandoffQueue({ getDb, governance })` can perform the enqueue-side check itself. For
agent-originated work, the host supplies `fromRole` from its authenticated execution context; it
must not accept that value from model input. The queue resolves the recipient from the target
conversation, verifies both the sender's `send` authority and the recipient's `receive`
authority, and stores the sender agent with the durable handoff:

```js
queue.enqueueHandoff({
  targetRoot,
  conversationId,
  taskKey,
  body,
  externalId,
  fromRole: executingRole
});
```

Omit `fromRole` only for trusted host-originated ingress such as a signed webhook. That preserves
the existing API and does not represent an agent-to-agent handoff. An agent-originated
retry cannot reuse an idempotency key belonging to another agent or conversation.

When created with `targetRoot`, the facade creates a local append-only, hash-chained audit log.
Audit records contain the agent, tool/action, runner/model when supplied, authorization summary,
data scopes, budget, approval, outcome, and hashes of input/output. They do not retain raw tool
payloads, outputs, OAuth tokens, or API keys. Multiple writers need host-level serialization.

## High-impact action approvals

`createActionApprovalPolicy({ targetRoot })` from `medhus-crewrun/action-approvals` is the
file-based policy for a single host process. Standalone execution uses a transactional outbox
instead; see [Tasks and recovery](runtime-recovery.md). To use the file-based host policy:

```js
import { createActionApprovalPolicy } from "medhus-crewrun/action-approvals";

const approvalPolicy = createActionApprovalPolicy({ targetRoot });
const governance = createAgentGovernance({
  targetRoot,
  requireContracts: true,
  getContract: (role) => loadAgentSpec(targetRoot, role)?.contract,
  requestApproval: approvalPolicy.requestApproval
});
```

The first matching high-impact call creates a `pending` record and does **not** perform the
provider action. An operator approves or rejects it through the console or
`approvalPolicy.approve` / `.reject`. On a later retry of the exact same agent, action,
connection, input, and contract revision, the policy claims the approved record once and lets the
broker invoke the provider. A record cannot be replayed for different input or reused after the
claim. This helper does not deliver or retry actions; the host owns that lifecycle.

The queue persists only a safe summary, agent, action, connection id, authorization summary, and
input digest. It never persists raw action input, OAuth tokens, or API keys. A multi-process or
production host should provide equivalent transactional request/approve/claim behavior in its own
database or queue rather than share this JSON file.

## Connector boundary

`createConnectorRegistry(...)` from `medhus-crewrun/connectors` produces a bridge-compatible,
narrow registry for the initial providers:

- Slack: `slack.postMessage` and `slack.replyToMention` only; no generic Slack API tool.
- Gmail: `gmail.sendDraft` only by default. `gmail.searchMetadata` and `gmail.getMessage` appear
  only with `gmailRead: true` and require the host to make the broader read consent explicit.

Every Slack/Gmail write is classified as `external-write` and requires a host approval. The host
passes safe connection metadata (`id`, provider, status, account label/id, granted scopes), grants
actions and connection ids per agent, and provides the only `invoke(...)` callback that can call a
provider. It must not put access tokens, refresh tokens, client secrets, or raw provider request
objects in agent context, connection metadata, approval summaries, or audit records.

`connectorAuthorizationUrl({ provider, clientId, redirectUri, state, scopes?, codeChallenge? })`
returns authorization URL metadata only. The host owns the OAuth callback, CSRF state validation,
PKCE/code exchange, encrypted token storage and refresh, consent display, revocation, and binding
of a connection to a user or workspace when using this low-level helper. Standalone Crewrun
also ships `createStandaloneRuntime({ targetRoot })`: its `operations` surface accepts local
operator credentials, refreshes Gmail tokens, reviews exact messages and invokes the providers.
It does not implement a browser OAuth consent callback. See [Slack and Gmail](integrations.md)
for setup and [Security and storage](security.md) for credential handling.

## Console operations surface

`createConsole({ targetRoot, operations })` accepts a stable, product-neutral operations object.
The `crewrun up --host ./host.mjs --console` and `crewrun console --host ./host.mjs` commands use
`host.operations` when present (otherwise the host object itself). The console keeps ordinary
agent and schedule editing local even when no operations object is provided. With no operations
object, the console uses the standalone runtime for tasks, delivery processing, the usage ledger,
Slack/Gmail connections, and approvals.

```js
export function createHost() {
  return {
    operations: {
      async getSnapshot({ targetRoot }) {
        return {
          usage: { totals: { runs: 12, costUsd: 1.25 } },
          providers: [{ id: "claude", label: "Claude", status: "ready", detail: "local sign-in available" }],
          connectors: [{ id: "slack-support", provider: "slack", status: "connected", account: { label: "Support" } }],
          approvals: [{ id: "approval-1", action: "slack.replyToMention", role: "support", status: "pending", impact: "external-write" }],
          audit: [{
            at: "2026-09-03T13:45:00.000Z", actor: "operator", role: "support",
            runner: "codex-agent", model: "gpt-5.6", action: "tool", tool_name: "slack.replyToMention",
            outcome: "completed",
            authorization: { decision: "allowed", contract_version: 1, contract_revision: 2,
              authority: { tool_name: "slack.replyToMention", impact: "external-write" } },
            data: { read: ["support-ticket:42"], write: ["connector:slack:slack-support"] },
            budget: { max_usd_per_run: 2, max_usd_per_month: 40 }
          }],
          contracts: { support: { status: "governed", mandate: "Triage support" } }
        };
      },
      async connect({ targetRoot, connectorId }) { /* begin host OAuth; return { redirect } */ },
      async disconnect({ targetRoot, connectorId }) { /* revoke/disconnect host connection */ },
      async decideApproval({ targetRoot, id, action }) { /* approve or reject host record */ }
    }
  };
}
```

`getSnapshot` (or `snapshot`) may be synchronous or async. `usage` may be a host ledger snapshot;
`providers` expose only safe status/detail; `connectors` expose safe connection state and
capabilities; `approvals` expose safe review fields; `audit` exposes only actor, agent,
runner/model, authority decision/revision, data scopes, budget, action, and outcome; and
`contracts` may add host summaries keyed by agent. Keep credentials and raw audit payloads out
of snapshots. Exact message review fields and task results belong in the private approval and
task views. `connect` / `disconnect` may
return `{ redirect }`, `{ url }`, or a URL string; the console permits only `http(s)` or local
paths as redirects. `decideApproval` receives only the record id and `approve` / `reject` action.

## Crew loop host module

`createUp({ targetRoot, host })` from `medhus-crewrun/up` accepts either the plain host object or
the result of `createHost({ targetRoot, log })`. Every callback is optional:

| Callback | Stable responsibility |
|---|---|
| `runTurn(role, prompt, meta)` | Run an ordinary turn; return `{ ok, text?, reason? }`. The standalone runtime is the fallback. |
| `runSchedule(schedule)` | Fully own a scheduled delivery; otherwise the loop calls `runTurn`. |
| `enqueue({ role, body, externalId })` | Receive debounced hook work. Standalone mode enqueues tasks; a custom `runTurn` host must supply this hook to receive events. |
| `routeEvent(event, payload, settings)` / `renderEvent(...)` | Select subscribed agents and render their hook prompt. |
| `spentToday(role)` | Return a USD number for heartbeat budget caps. |
| `tick({ emit })`, `start({ emit })`, `stop()` | Host housekeeping and lifecycle. |
| `operations` | The console surface described above. |

Without `host.runTurn` or `host.runSchedule`, `createUp` uses the standalone transactional
scheduler. Processes sharing the same local database share trigger cursors and atomic claims.
Supplying either callback selects the file-based schedule/heartbeat helpers; use one owner per
project or provide host coordination. See [Scheduling ownership](#scheduling-ownership).

## Project files

All paths below use the configured crew directory (`.crew` by default).

### Agent file

`<targetRoot>/.crew/agents/<role>.json` is the primary agent specification. It may contain
`title`, `instructions`, `runner`, `memory_pointers`, `reflections`, `hooks`, `heartbeat`, `web`, `scheduled`, and
the governed `contract` above. `<targetRoot>/.crew/agents/_defaults.json` supplies a shared
defaults floor; agent memory pointers append to that floor, while contract approvals and budgets
cannot be weakened. The older `schedules` agent key remains readable for compatibility; new
task edits write `scheduled`.

An optional `<role>.md` is ordinary prompt prose and is read only when a `memory_pointers` entry
names it. Legacy `.md` frontmatter remains readable for compatibility, but new hosts should write
the JSON agent spec. Host-specific fields are preserved as JSON; they have no kernel behavior
unless the host implements them.

### Runner mappings and profiles

Project mappings live in `<targetRoot>/.crew/memory/ai-runners.json`:

```json
{
  "version": 1,
  "default_role_runners": { "planner": "claude-local" }
}
```

Concrete profiles live in the operator file from `globalRunnerConfigPath()` (normally
`~/.crew/ai-runners.json`):

```json
{
  "version": 1,
  "runners": [
    {
      "id": "claude-local",
      "engine": "claude-agent",
      "kind": "agent-sdk",
      "provider": "anthropic",
      "model": "sonnet",
      "mode": "propose",
      "auth": "subscription"
    }
  ]
}
```

`id` matches `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`. `engine` is `cli`, `claude-agent`, or
`codex-agent`; `mode` is `propose` or `execute`; and `auth`, when present, is `subscription` or
`api-key` (`auto` is represented by omitting it). Recognized optional fields are
`display_name`, `provider`, `model`, `reasoning_effort`, `base_url`, `secret_ref`,
`allow_shell`, `source_profile`, and `healthcheck`. A `cli` runner also requires `command` and
may set `args`; `{prompt}` and `{prompt_file}` are substituted in its arguments. `base_url`
must start with `http://` or `https://` and selects routed API-key authentication rather than a
vendor subscription.

### Execution policy

`setExecutionPolicy(targetRoot, input)` persists
`<targetRoot>/.crew/memory/execution.json` and returns its canonical form:

```json
{
  "runtime": "worktree",
  "image": "node:20-bookworm",
  "network": "bridge",
  "cpus": 2,
  "memoryMb": 4096,
  "pidsLimit": 256
}
```

`runtime` is `worktree` or `container`; container `network` is `none` or `bridge`. The setter
also accepts `memory_mb` and `pids_limit`, but always returns and writes camel-case names.

### Scheduling ownership

`createScheduler({ targetRoot, run })` from `medhus-crewrun/schedules` is a single-host helper.
It does not provide a distributed lease or cross-process claim: run at most one scheduler owner
per `targetRoot`. A multi-process host must elect that owner or transactionally claim a scheduled
delivery in its own database/queue before it invokes `run(schedule)`. The `handoffs` module's
token-and-expiry batch claim is the intended reusable pattern for durable multi-process work.

## Authentication boundary

`auth: "subscription"` is supported only by native Claude and Codex profiles. It removes the
relevant ambient API-key environment variable so the installed local runtime can use the
operator's existing sign-in. It does not expose, copy, store, exchange, or forward a subscription
credential, and it is not an API-key substitute. For a direct provider profile,
`auth: "api-key"` requires the stored or ambient provider key. An omitted `auth` leaves the
vendor runtime's normal credential resolution in place; a routed `base_url` profile uses its
own API-key route rather than subscription authentication.

Use subscription mode only for the operator running Crewrun locally. A host acting for other
users must use its own API-key or supported cloud-provider integration, and should review the
current [Anthropic policy](https://code.claude.com/docs/en/legal-and-compliance) and
[OpenAI guidance for using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) before deployment.


## Agent terminology compatibility

The canonical UI and CLI call these Agents (`/agents`, `crewrun agents check`). New projects
use `.crew/agents`; `.crew/roles` remains readable and existing files are edited in place.
Agent specs win on duplicate names and shared defaults fall back to the legacy folder.
The `agent-spec`, `agent-contract`, `agent-capabilities`, and `agents` subpaths expose the new
terminology. `createAgentRunner` adds `runAgentCapture({ agent, ... })` and
`startAgentTurn({ agent, ... })`. Legacy role-named exports and persisted `role` fields remain
valid; host tool registries continue receiving the same `role` property.

Agent specs may include `instructions`, a plain string injected in each new turn. The console
edits this field directly. Reflections remain optional and inherit `false` from shared defaults.

## Standalone runtime

`createStandaloneRuntime` exposes `store`, `operations`, `tick`, `start`, `stop`, `close`, and
`runTurn(agent, prompt, meta)`. Its `runtime-store` and `runtime-scheduler` modules use SQLite;
the native dependency is required. File-based host helpers retain their separate contracts.
See [Tasks and recovery](runtime-recovery.md) for claims, delivery states, operations methods,
and deployment limits, and [Library integration](library.md) for lifecycle examples.

## Skills and context proposals

Reflections are off by default. `reflections: true` (or an existing options object) enables
optional proposals; the old `limit` field remains readable for compatibility but no journal is
automatically injected. `memory.reflect` requires `target`, `key`, `text`, and `evidence`, plus
`description` for Skills. Approval promotes an update into a preference or Skill. Pending
proposals expire after 30 days. Existing journals and legacy pending proposals remain available
for manual review; the console asks for a destination before approving a legacy proposal.
`skill.propose` requires evidence of user/application relevance or improved reliability.
Trusted operators may use `saveUserPreference` for an explicit user instruction; agents only
receive the proposal API. See [Skills and context](learning.md) for formats and review workflows.
