# Permissions and approvals

[Documentation](README.md) / Permissions and approvals

An agent contract defines its job, allowed tools, data scopes, handoffs, and approval requirements.
The bundled host enforces these rules for its tools and integration plugins. Missing contracts fail closed.
This guide describes contract version 1; see the [Host API reference](host-api-v1.md) for interfaces.

## Agent contract

Place a `contract` object in `.crew/agents/<agent>.json`:

```json
{
  "title": "Customer operations",
  "runner": "codex-agent-high",
  "memory_pointers": ["docs/customer-ops.md"],
  "contract": {
    "version": 1,
    "revision": 1,
    "mandate": "Triage customer requests and prepare approved replies.",
    "authority": {
      "tools": [
        { "name": "slack.replyToMention", "impact": "external-write" },
        { "name": "google-workspace.sendMailDraft", "impact": "external-write" }
      ],
      "data": {
        "read": ["support-ticket:*"],
        "write": [
          "connector:slack:support-workspace",
          "connector:google-workspace:support-mailbox"
        ]
      },
      "handoffs": { "send": ["support-manager"], "receive": ["triage"] }
    },
    "approvals": {
      "required_for": ["external-write", "destructive", "financial"]
    },
    "budget": { "max_runs_per_day": 6 }
  }
}
```

`authority.tools` is the agent's allowed capability set. A host must expose a
tool through its broker *and* give the agent authority for it. The broker checks
again at invocation time; hiding a button or omitting a tool from a prompt is
not an authorization mechanism.

`authority.data` and `authority.handoffs` are host-defined names. They make
the intended data boundary and permitted recipients reviewable in the same
file. A host must enforce those names when it resolves data or enqueues a
handoff.

The built-in connector registry uses `connector:<provider>:<connection-id>`
as its data scope. Replace `support-workspace` and `support-mailbox` above
with the exact connection IDs granted to this agent; use a wildcard only when
the agent is intentionally allowed to use every connection for that provider.

The contract is a repository file, so normal Git review is its change history.
The console deliberately writes the same file; it is not a second source of
truth.

## Approval and audit boundary

External writes are never implicitly safe. A connector action such as sending
mail, posting Slack, creating an event, deleting data, or moving money should
be classified as an external write. The host creates an approval record before
performing it, lets an authorized human approve or reject it, then writes an
append-only, hash-chained audit record containing at least:

- timestamp and decision;
- agent and requested action;
- runner/provider/model when available;
- approved authority and connection identifier;
- redacted input summary and outcome;
- actor who approved it.

The **Activity** page shows the actor, agent, runner/model, authority decision, data scopes,
budget, action, and outcome. It excludes raw payloads and credentials. The private **Reviews**
page shows the exact outgoing message for review, and the task timeline retains results and receipts.

Read actions can proceed only when the agent contract permits them. Keep credentials out of
model context and review records; retain exact review payloads only in private operator storage.

## Handoffs and durable learning

Use `task.delegate` for bounded child work. The durable runtime checks both agents’ handoff permissions and authorized data, links parent and child, and keeps the result traceable. Native subagent chatter is not a workflow bus.

Agents may propose user/application-specific Skills and context updates with evidence. A
trusted operator may directly save an explicit user preference; agent-inferred updates require
review. Reflection proposals are off by default, expire after 30 days, and must name a context
or Skill destination. Approval promotes that update instead of appending a journal. Legacy
journals are retained for manual migration and are not injected into prompts.

Runtime runs, delivery claims, receipts and approval transitions share transactional
storage. See [Tasks and recovery](runtime-recovery.md) for guarantees and limits.

## Connectors

Installed plugins provide curated action descriptors, OAuth, verified webhooks,
and subscription lifecycle hooks. The core broker enforces role, connection,
scope and approval checks. Tokens stay encrypted in private host state.
See [integrations](integrations.md).

## Operations console

`crewrun console` lets an operator edit agents and schedules, run tasks, review results and
approvals, connect accounts, and inspect provider readiness, audit, and usage. Hosts can supply
their own snapshots and actions through the [console operations API](host-api-v1.md#console-operations-surface).
