---
type: design-contract
audience: host authors and operators
contract_version: 1
status: stable
---

# Governed operations v1

CrewRun v0.6 treats an agent as a reviewable operating contract, rather than a
prompt with a name. The runtime remains host-neutral: a host owns its business
objects, identity provider, OAuth callbacks, database, and external side
effects.

## Agent contract

Place a `contract` object in `.crew/agents/<role>.json`:

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
        { "name": "gmail.sendDraft", "impact": "external-write" }
      ],
      "data": {
        "read": ["support-ticket:*"],
        "write": [
          "connector:slack:support-workspace",
          "connector:gmail:support-mailbox"
        ]
      },
      "handoffs": { "send": ["support-manager"], "receive": ["triage"] }
    },
    "approvals": {
      "required_for": ["external-write", "destructive", "financial"]
    },
    "budget": { "max_usd_per_month": 40 }
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

The local operations console can render this as a safe Audit page: actor, agent,
runner/model, authority decision and revision, data scopes, budget, action, and
outcome. It deliberately does not render raw requests, responses, errors,
credentials, or hashes.

Read actions can be auto-approved only when the agent contract explicitly
permits them. Never place OAuth access tokens, raw API keys, or user data in an
approval summary or an audit record.

## Handoffs and durable learning

Use the handoff queue for work that crosses an agent boundary. It gives a host an
idempotency key, lease, retry state, and a durable record of the delivery. Do
not use untracked agent-to-agent chat as the workflow bus.

Pass `governance` to `createHandoffQueue` and have the host set `fromRole` from
the authenticated executing agent when it enqueues agent-originated work. The
queue resolves the target agent from the conversation and checks both contract
sides. `fromRole` is not model input; omitting it is reserved for trusted
host-originated ingress such as a signed webhook.

Agents may propose skills, preferences, and per-agent reflections, but an
operator approves each before it becomes durable context. Agent memory pointers,
contracts, and schedules remain reviewed project configuration. Reflections are
a bounded per-agent journal; hosts should expose the proposal and approval trail
as reviewable state and should not use it as a source of unbounded global memory.

## Connectors

The core includes action descriptors for Slack and Gmail. Standalone Crewrun also includes a
local adapter with operator credential setup, Gmail refresh, review payloads and provider calls
(see [the README](../README.md#slack-and-gmail-with-or-without-a-host)). A custom host can
replace that adapter with its own account system. In that case the host:

1. starts OAuth with the smallest requested scopes;
2. binds the resulting connection to a user or workspace;
3. encrypts tokens and refreshes them server-side;
4. maps the connection to narrowly named actions;
5. invokes the action only after authority and approval checks.

For the first release, enable Slack replies/posts and Gmail send-draft flows.
Gmail read access is intentionally opt-in because it requires broader, more
sensitive permissions. Financial connectors are out of scope for this contract
until a host has the appropriate consent, privacy, and compliance controls.

## Operations console

`crewrun console` is a local control surface, not a chat client. It presents
agents as operational cards and supports normal edits for agent identity, runner,
memory pointers, scheduled tasks, connector status, approvals, provider readiness,
audit, and usage. It never displays raw secret values or accepts OAuth tokens from a
model. Hosts can add their own connector/usage snapshots through the stable
host API.
