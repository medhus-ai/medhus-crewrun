# Module reference

[Documentation](README.md) / Module reference

| Module | Purpose |
|---|---|
| `runner` | `createAgentRunner(options)` → `startAgentTurn`, `runAgentCapture`, prompt assembly; also exports `loadAgentMemory` |
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
| `handoffs` | `createHandoffQueue({ getDb, governance? })` — durable inputs for an agent's thread: attach once, claim in leased batches, recover after a crash |
| `schedules` | Cron-scheduled agent turns: `<crew dir>/schedules.json`, `parseCron`, `dueSchedules`, `createScheduler({ run })` |
| `up` | `createUp({ targetRoot, host })` + the `crewrun up` CLI — the crew loop (schedules, heartbeats, hooks, host housekeeping) around one project; the optional host module injects tools, turn recording, routing, and lifecycle |
| `pulse` | Periodic agent check-ins with recorded-spend checks, and application event hooks with debounced enqueue; file-based host helper |
| `skills`, `skill-proposals` | Scoped `SKILL.md` skills; agent-proposed skills that a human approves into a scope |
| `preference-memory`, `reflection-proposals`, `reflections`, `recall` | Approved context and optional improvement proposals; legacy journal readers and episodic recall |
| `execution-policy` | Container sandbox policy |
| `console/*` | Local UI for agents, tasks, results, schedules, approvals, audit, integrations, providers, and usage; accepts host data through the operations API |
| `auth`, `request-context`, `markdown`, `process`, `platform`, `frontmatter`, `agent-output` | Framework-free helpers for a host UI and OS |

Import by subpath: `import { createAgentRunner } from "medhus-crewrun/runner"`.

For supported interfaces and schemas, see the [Host API reference](host-api-v1.md).
