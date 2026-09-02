---
type: api-contract
contract_version: 1
applies_to: medhus-crewrun 0.1.x
status: stable
---

# Host API and schema contract v1

This is the supported embedding boundary for a host application. `targetRoot` means the
absolute path to one project; `role` means a lowercase slug (`[a-z][a-z0-9-]{0,79}`).

## Compatibility

- A compatible v1 release keeps the named functions, required inputs, and named return fields
  below. It may add optional fields.
- A breaking host-surface or file-schema change requires a new contract version and migration
  notes. The npm package is still pre-1.0, so hosts should pin and test a package version.
- Exports not named here are useful implementation utilities, but are not part of this stable
  host contract yet.

## Turn runner

`createRoleRunner(options)` from `medhus-crewrun/runner` is the primary runtime boundary. Its
`tools` option is a bridge returned by `createMcpBridge`; all other hooks are optional host
presentation, prompt, memory, capability, worktree, and container customizations.
It returns `startRoleTurn`, `runRoleCapture`, `generateConversationTitle`, `runnerIdForRole`, and
the prompt/memory helper methods documented by that module.

```js
const turn = runner.startRoleTurn({
  targetRoot,                         // string, required
  role,                               // role slug, required
  messages: [{ author, content }],    // required array of strings
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
`resumed`, `capabilities`, and `provider`. Invalid roles or runner configuration throw before a
turn starts.

`onClose` receives `{ code, stderr?, usage?, engineSessionId?, tools? }`. When reported,
`usage` is `{ inputTokens, outputTokens, costUsd }`, with unavailable values represented by
`null`. `onLine`, `onPartialText`, and `onStatus` receive a string; `onError` receives an error.

For a headless one-shot, `runRoleCapture({ root, role, prompt, ... })` resolves to
`{ ok: true, text }` or `{ ok: false, reason, text }`; it does not reject for a runner timeout
or non-zero runner exit.

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
`toolInstructions(role, toolContext, toolNames)`, and `serializeContext(toolContext)`.

The returned bridge has `serverName`, `label`, `toolLineMarker`, `enabled`, `toolHandlers`,
`createClaudeMcp`, `claudeToolInstructions`, `codexMcpConfig`, `serializeContext`, and the
original `registry`. `createToolBroker` returns `toolsForRole`, `canCallTool`, and `callTool`.

Use `createToolBroker({ allowlists, fallbackTools?, extraTools?, sharedTools? })` from
`medhus-crewrun/tool-broker` when the host needs enforcement as well as filtering. Its
`callTool({ role, toolName, input, context, registry, roleOptions })` checks the role allowlist
again before it invokes `registry[toolName](input, { role, context })`.

For Claude, the bridge is an in-process MCP server. For Codex, `codexMcpConfig` starts the
host's `stdioServerEntry` as a child MCP server. That entry reconstructs plain-data context with
`mcpRoleFromEnv()` and `readMcpContextData()`, then calls
`serveStdio({ bridge, role, toolContext })` from `medhus-crewrun/mcp-stdio`. Only declared,
serializable context crosses the process boundary; `childAuthEnv` keys are written to a 0600
file and must be loaded explicitly with `loadMcpAuthEnv(keys)`.

## Project files

All paths below use the configured crew directory (`.crew` by default).

### Role file

`<targetRoot>/.crew/roles/<role>.md` is Markdown. The runtime interprets only a
`memory_pointers:` list of `.md` paths inside the crew directory; listed files are injected into
the role prompt. Other frontmatter is host-owned. In particular, `file_scope` and `triggers`
have no kernel behavior unless the host implements them.

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

`auth: "subscription"` makes the native Claude or Codex runner remove ambient API-key
credentials so the operator's existing local vendor sign-in is used. For direct native-provider
profiles, `auth: "api-key"` requires the stored or ambient provider key. An omitted `auth`
leaves the vendor runtime's normal credential resolution in place.

This support is for an operator using their own local credentials. Anthropic requires products
and services built for other users to use API keys or a supported cloud provider; they may not
offer Claude.ai login or route Free, Pro, or Max credentials on users' behalf. See
[Anthropic's authentication policy](https://code.claude.com/docs/en/legal-and-compliance).
