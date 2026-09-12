# Capabilities and limits

v6 provides one owner per workspace, versioned agents, governed task delegation,
persistent questions and chats, reviewed durable changes, recurring tasks, and
installable Slack, Google Workspace, Microsoft 365 and GitHub integrations.

On Linux, agents' existing workspace tools support permission-scoped QMD keyword
search and Docling Office/native-PDF reads after installing the local dependencies.
Hybrid search requires separately installed local models and an owner setting.
No automatic cloud-document synchronization, OCR or spreadsheet calculation engine
is included; see [workspace knowledge](workspace-knowledge.md).

Claude subscriptions/API routes and the Linux-verified Codex SDK use governed
tools. Only one owner-selected direct-Claude agent can use native shell auto-review.
Codex shell auto-review is not implemented.

Internal claims and continuations are durable and deduplicated. External writes
may become uncertain and require reconciliation. Usage reporting can be incomplete;
subscription estimates are not invoices. See [execution and budget limits](workspaces.md).

Shared OAuth hosting, multiple human permission levels, a general workflow
builder, automatic calendar synchronization and WhatsApp are not provided.
Optional managed **Easy Connect** is a [future direction](product-direction.md#integration-hosting-direction),
not part of the current self-hosted release.
There is no compatibility execution mode for old custom hosts, arbitrary CLIs,
worktrees, Docker workers, Markdown agents, or global schedule files.
