# Personal and organization workspaces

CrewRun's bundled one-owner host runs a workspace without custom organization code:

```sh
crewrun init ./my-crew --preset personal --timezone America/Phoenix
crewrun up ./my-crew --console
```

The `organization` preset starts with a coordinator, not a compulsory company hierarchy. Add roles through forms or the side helper. `init` refuses existing files; it never replaces a repository. v6 reads only canonical `.crew/agents/*.json`; [migrate old formats](v6-migration.md) before startup.

## What lives where

`.crew/workspace.json` is a version-1 manifest: stable `id`, display `name`, IANA `timezone`, Markdown `context` entrypoints, draft/output folder policy, execution-chain limits, and explicit lifecycle/integration rules. Agent contracts, memory pointers, skills, and scheduled definitions remain ordinary reviewed workspace files. Knowledge folder names are not hard-coded.

Tasks, attempts, owner questions, results, reviews, chats, event receipts, and credentials are private host state outside Git. A manifest identity selects fresh runtime and integration state independently of the directory name. Reusing an identity intentionally reuses that workspace's state; do not copy identities between unrelated workspaces. Legacy projects retain their path-based state. Back up private state and the host encryption key together; Git is not a runtime-state backup.

The bundled CLI uses the reference host automatically. Programmatic `createUp` requires that host’s durable runtime and operations. There is no standalone or custom-host fallback. With no public callback origin, the bundled host starts no ingress listener. It creates a private 0600 `host.key` when no service-supplied encryption key exists. Self-host OAuth app registration, secrets, HTTPS routing, and Funnel activation remain operator actions; see [reference-host setup](reference-host.md).

## Accountable work

Agents can search and read authorized documents through the existing workspace
tools: [QMD search and Docling extraction](workspace-knowledge.md). File authority
is checked before indexing and again before retrieval; no global cross-agent
knowledge index is exposed.

The existing run is the logical task, with retained execution attempts. Optional fields are `title`, `priority` (`low|normal|high|urgent`), `outcome`, `criteria`, and `parent_id`; `agent` is the owner. `progress`, structured `blockers`, saved artifacts, and owner answers survive restarts. No parallel Markdown inbox exists.

Internal MCP tools: `task.list`, `task.get`, `task.create`, `task.update`, `task.delegate`, `task.askOwner`, and `task.saveArtifact`. Task lists return ten authorized records and `nextOffset`. Agents update their own work; explicit `task:<agent>` read/write data scopes grant coordination. Agents never call human acceptance or approval operations.

Delegation checks both handoff contracts at creation and execution; the recipient receives no inherited tool/data authority. The parent waits for owner acceptance of its child result. Assignment text and returned artifacts are untrusted task data, not permission. Share only necessary context; file tools still enforce the recipient's scopes. `task.askOwner` records a question with up to five suggestions and a free-text answer. Finish the turn after asking; one answer queues one continuation of the same task, including when it arrives during the finishing turn.

Result acceptance and external-action approval are separate. Request changes includes feedback and queues another attempt of the same task. Rejected sends remain unsent; uncertain sends require reconciliation rather than automatic replacement. Existing artifacts and delivery states are supplied on continuations.

Lifecycle events (`approval.approved`, `approval.rejected`, `schedule.failed`, `run.finished`, `run.accept`, `run.request_changes`, `question.answered`, `workspace.applied`) are committed with their state changes. Manifest `rules` entries have `{id,event,agent,enabled}`; matching agent hooks and authority are also required. Routing commits a cursor and deduplicated queue entry together. Defaults are maximum depth 4, 20 executions per task chain, and 5 attempts per task; daily role run limits also apply.

Manifest `integrationRules` entries have `{connectionId,eventType,role,enabled}`. For initialized workspaces these files are the authoritative definitions, not a second editable database queue. Integration forms validate the provider capability, role hook, and connection scope before enabling a rule. The host checks connection and routing authority again before executing a queued provider event. Connecting a provider does not enable routes.

## Reviewed setup and knowledge

`workspace.read` and `workspace.search` enforce `workspace:<relative-path>` read scopes. A trailing `/*` grants descendants of a directory. Paths are relative; traversal, `.git`, and symlinks are denied. Search is literal, bounded, Markdown-only, and filters by role authority.

`workspace.writeDraft` requires write authority and a path beneath a configured draft/output folder. It cannot write `.crew/`. Durable Markdown changes use `workspace.proposePatch` and require appropriate read/write authority. Agent and skill configuration uses setup proposals. The helper can inspect safe setup/connection metadata, get a preset, and propose a bundle—not apply or approve it. It never receives credentials.

Reviews → Workspace shows before/after content, supports editing into a new superseding proposal, and applies only owner-approved content. Base hashes reject stale files. Approved intent is durable before atomic per-file replacement; recovery recognizes already-applied files and stops on conflicts instead of overwriting operator edits. This is recoverable multi-file application, not a filesystem-wide atomic transaction. New routines and routes proposed by the helper start disabled.

Manual forms and helper proposals share configuration validation. Existing owner forms are explicit owner changes, not agent bypasses. Knowledge remains ordinary Markdown; the runtime does not reinterpret old document text as current approval.

## Enforced limits and current boundaries

- Governed workspace turns support Claude-compatible engines and Codex SDK/CLI 0.152.0 on Linux. Native shell, web, image reading, apps, and subagent tools are disabled. Codex additionally has a deny-all native filesystem permission profile and no permission escalation: its native patch tool may remain advertised, but cannot read or write files. Both engines run in an empty directory and retain subscription authentication. Generic CLI and unverified Codex versions/platforms fail closed. v6 has no legacy execution mode.
- Governed Codex uses a per-turn authenticated loopback MCP listener over the same host handlers as Claude. It does not reconstruct a runtime or copy integration credentials to a stdio child. The listener closes when the turn ends; a connection failure does not grant native fallback access. Codex's isolated code-mode JavaScript orchestrator, when required by a model, receives the restricted tool registry, not Node filesystem or shell access. MCP discovery can list only the host's permitted tools; no provider resources are registered.
- Codex private session homes are separated by workspace identity, role, role specification, and runner profile. Ambient hooks, skills, apps, and user configuration are not loaded. The pinned SDK version must be reverified before upgrading. These boundaries constrain model-selected actions, not a malicious owner or compromised vendor binary.
- Workspace memory pointers are filtered by role read authority. Only repository-scoped, role-applicable skills are loaded; ambient user/workspace skills and global preference injection are not carried into governed turns.
- Each role retains one console thread. A configuration/authority change resets the underlying model session and limits re-injected history to the new policy boundary; the owner can still view the complete retained transcript.
- Attempt, chain, and depth limits are enforced for queued work. Daily agent limits count both queued attempts and interactive chat turns. Claude's per-run USD budget option is passed through; Codex refuses that unsupported hard limit. Hard cumulative token/monthly-dollar budgets fail closed because this host has no monetary reservation engine; do not describe estimates as billing guarantees.
- Event and action receipts are durable and deduplicated locally. Providers do not offer universal exactly-once external delivery; uncertain outcomes still need human reconciliation.
- One owner per workspace. No shared OAuth login broker, multi-human RBAC, workflow builder, automatic Git push, or automatic provider/Funnel provisioning.

## Optional privileged shell agent

In **Agents → an agent → Allow shell**, the owner can confirm and enable the red switch.
Only the selected agent has a red **Shell access** badge in the agent directory.
Ordinary agents have no governed/legacy badge: authority enforcement is mandatory,
not an optional mode. The shell agent still needs its reviewed authority contract.
The manifest stores one `shellAgent` slug (default `null`) and a monotonic `shellRevision`.
The switch disappears on other agents; they see a link to the selected agent and must use
the existing authorized `task.delegate` handoff. Both handoff contracts still apply; no
handoff permissions are automatically added. Shared defaults, agent JSON, and helper setup
proposals cannot grant or revoke shell access.

This is an explicit privileged exception: native Bash can act with the host service user's
OS permissions, including outside workspace draft folders and web allowlists. It does not
grant root, and native auto-review is a fallible reviewer—not a sandbox or a guarantee that
an agent cannot modify host state. Run CrewRun under a dedicated account or in a suitably
isolated machine if those resources must remain inaccessible. The shell subprocess does not
inherit CrewRun integration keys or unrelated provider environment variables, but the service
user's on-disk resources remain part of this privileged trust boundary.

Currently supported: direct Claude with native `permissionMode: "auto"`, using the pinned
Agent SDK, an eligible model, and an account with auto mode available. There is no `Bash`
allow rule, `acceptEdits`, or permission-bypass fallback. Codex remains tool-only: its present
SDK/exec adapter needs an interactive App Server adapter before native auto-review denials
and owner overrides can be bridged reliably. Kimi, GLM, OpenRouter, and generic CLI shell
access are also unsupported. See [Claude's native permission modes](https://code.claude.com/docs/en/permission-modes)
and [Codex auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review).

Flagged commands are private `shell.native` records in the existing runtime action outbox,
shown in **Reviews → Actions**. Provider workers cannot claim these records. Approval permits
one exact command, timeout, working directory, agent policy revision, and task/chat context.
For task work it queues one continuation of the same task; for chat work, ask the same agent
chat to retry the reviewed command. Native hard restrictions still apply. Rejection never
queues a retry; interrupted approved commands become uncertain and require reconciliation.
Native requests/completions appear in the task timeline and Activity, alongside run/model identity.

Only one shell turn may hold the cross-process runtime lease. Disabling access requests
cancellation of its active turn and blocks further calls; finish stopping that turn before
assigning another agent. This cannot undo completed actions or guarantee termination of
processes deliberately detached by a command. New grants advance the revision so old
approvals cannot revive. All existing workspaces remain shell-disabled unless their owner opts in.

## Migration and verification

Preserve an archive branch before rebuilding a workspace. Use a separate worktree and a new identity for a fresh start; do not import old queues by copying database files. Preserve substantive documents and their approval/draft status, update links and memory pointers, and keep old operational history only in the archive.

Rehearse with isolated private state, mocked runners/providers, all routines off, and no public listener. Verify tasks, questions, reviews, delegation, restart recovery, and console rendering. Stop the old daemon/cockpit/event consumers before enabling the replacement. Roll back by stopping the new host first, then restarting the old deployment against its original checkout and private state—never run both consumers together.

Run `npm test` for offline coverage. Existing model, provider, and Funnel live tests are opt-in; see [development](development.md). A skipped live test is not evidence of a working connection or a production-ready ingress.

To exercise real governed turns in disposable workspaces, run `CREW_LIVE_E2E=1 CREW_LIVE_WORKSPACE=1 CREW_LIVE_CODEX_WORKSPACE=1 node --test test/live-workspace-e2e.test.js`. Each flag selects its vendor authentication. Tests verify the authorized draft and audited tool call without connecting providers or activating public ingress. `test/codex-boundary.test.js` also drives the actual pinned Codex dispatcher against a local fake Responses endpoint to force unauthorized actions deterministically.

GitCrew/custom-host worktree compatibility is retired in v6. Use the bundled workspace host and governed task tools. Codex controls are described in the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
