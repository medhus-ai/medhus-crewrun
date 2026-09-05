# Security and storage

[Documentation](README.md) / Security and storage

Crewrun keeps project configuration separate from private operator state. The console binds to
loopback by default. Agent permissions are checked when tools are exposed and again when invoked.

## Storage locations

`CREW_HOME` defaults to `~/.crew`. Project paths use `.crew` unless an embedding application
configures another directory.

| Data | Default location | Protection |
|---|---|---|
| Agent specs, contracts, schedules, repository Skills and context | `<project>/.crew/` and explicitly referenced files | Project filesystem permissions and Git review |
| Runner profiles | `~/.crew/ai-runners.json` | Operator configuration; keep credentials in the vault or environment |
| Stored model API keys | `~/.crew/secrets.json` | Password-sealed scrypt + AES-256-GCM vault |
| Standalone credentials, tasks, actions, receipts, and usage | `~/.crew/runtime/<project-hash>/state.sqlite` | Private operator directory; not encrypted |

Private standalone directories and files use owner-only permissions on Unix. Windows relies on
the operator account's filesystem permissions. Keep the SQLite database on a local disk;
shared network filesystems and distributed multi-machine workers are not supported.

Old standalone connection files import once and remain as a backup. Imported pending actions
need reconciliation because their earlier delivery may be unknown. Disconnecting an account
removes its local credentials and preserves delivery history.

## Permissions and isolation

Grant only the tools and data scopes an agent needs. Slack/Gmail writes require approval;
review changes to an agent's contract like other project configuration.
[Permissions and approvals](governed-operations-v1.md) describes the enforcement boundary.

Execute-mode turns can use dedicated Git worktrees or Docker containers. A worktree separates
edits but is not a security sandbox. Container execution drops capabilities, restricts mounts,
and supports network controls. Subscription credentials are not mounted into containers;
use API authentication. See the [execution policy](host-api-v1.md#execution-policy).

MCP child processes receive declared context. Configured child authentication values use a
private file rather than the child environment. A web allowlist controls the exposed web tools;
it does not constrain arbitrary native shell commands.

## Installation

SQLite is a required native dependency. If a prebuilt binary is unavailable, installation needs
Python and a C++ compiler. Node 20 with Visual Studio 2026 needs npm 11.6.3 or a compatible newer
npm; the bundled npm 10 cannot detect that compiler. Windows CI uses npm 11.6.3 and Python 3.12.
[node-gyp build requirements](https://github.com/nodejs/node-gyp#installation).
