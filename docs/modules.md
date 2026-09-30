# Module reference

| Module | Responsibility |
|---|---|
| `workspace-manifest`, `workspace-setup`, `workspace-tools` | Identity, guided setup, scoped work, reviewed changes |
| `agent-spec`, `agent-contract`, `agent-capabilities` | JSON agents, authority, generic delegation boundary |
| `runner`, `runner-config`, `engines/*` | Governed Claude/Codex SDK turns, subscriptions and compatible API routes |
| `shell-access`, `engines/claude-shell` | Sole owner-selected shell agent, native auto-review and exact approvals |
| `runtime-store`, `runtime-worker`, `runtime-scheduler`, `runtime-lifecycle` | Durable work, leases, trigger claims, bounded follow-through |
| `connectors`, `mcp`, `mcp-server`, `mcp-local` | Plugin action authority and scoped host-tool transport |
| `console/*`, `console-chat` | Owner console, persistent chats and setup helper |
| `skills`, `skill-proposals`, `preference-memory`, `reflection-proposals` | Reviewed learning |
| `schedules` | Recurrence parsing and agent-owned scheduled definitions |
| `budget`, `conversations`, `recall` | Usage, conversations and scoped recall |

The role-named implementation modules underpin the agent-facing exports; they are
not a legacy execution mode. Provider implementations live only in the installable
workspace plugin packages. See [library use](library.md).
