# Security and storage

The private owner console is loopback-only. Publish only the documented callback
ingress through an explicitly configured HTTPS proxy or Funnel.

| Data | Location | Protection |
|---|---|---|
| Knowledge and agent configuration | Workspace Markdown and `.crew/` | Scoped tools; durable changes require reviewed patches |
| Tasks, chats, exact approvals, usage | Private runtime SQLite under `CREW_HOME/runtime/` | Owner-only Unix permissions; not encrypted |
| Integration tokens and OAuth state | Private integration SQLite | Authenticated encryption with a separate host key |
| Model API keys | Host environment or password-sealed key store `CREW_HOME/secrets.json` | AES-256-GCM with a scrypt-derived key; unlocked from Settings after each restart; outside workspace and agent chat |
| Codex login copy (subscription profiles) | `CREW_HOME/provider-runtime/codex…/auth.json` | Copied from your Codex login with owner-only permissions (0600); not encrypted; read only by the local Codex runtime |
| Runner profiles, including local model servers | `CREW_HOME/ai-runners.json` | Operator-owned SDK configuration; no secrets |

`CREW_HOME` defaults to `~/.crew`. Workspace identity, not its directory name,
selects new operational state. Old queues and credential files are not imported.
Keep SQLite on local disk; distributed multi-machine workers are not supported.

Claude runs with no native tools except the explicitly selected shell agent.
Codex uses its pinned, Linux-verified boundary and a turn-scoped authenticated MCP
listener. API keys stay in host closures, not model child processes; vendor subscription
logins are read by the vendor runtime itself (see [Providers](providers.md#authentication-modes)).
Local model servers are reached only at the address the owner connects in Settings.
Scoped paths reject traversal and symlinks. Missing contracts fail closed. Tool bridges
and brokers cannot run tools with an allowlist alone: a host authority policy is
required, and existing handlers recheck authority on every call. Workspace governance
cannot be disabled. The helper has a bounded setup-only contract.

The sole shell agent is a privileged exception with the service user's OS
permissions. Native Claude auto-review can make mistakes; it is not filesystem
isolation. Flagged commands require exact owner approval. Revocation stops future
claims and signals an active turn, but cannot undo completed system actions.

Custom CLI engines, worktree/Docker execution policies, and serialized MCP
credential-child transport are removed. [Workspace limits](workspaces.md).

## Installation

SQLite is a required native dependency. When a prebuilt binary is unavailable,
installation needs Python and a C++ compiler. See
[node-gyp requirements](https://github.com/nodejs/node-gyp#installation).
