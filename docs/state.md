---
type: implementation-state
audience: founder + engineer + ai-agent
updated: 2026-08-31
status: active
---

# crewcore State

## Direction

Extracted from GitCrew on 2026-08-31 so the company-org automation can share the agent
runtime without depending on GitCrew. The kernel holds only host-neutral code; product
identity is injected (see README → Host contract). GitCrew is the first consumer and pins a
tag; the org automation is the second.

## Boundaries (what stays out)

- Workflow state / SQLite store, dispatcher, plan pipeline, verification contract — GitCrew.
- Forges (GitHub, Azure DevOps), PR sync, merge policy — GitCrew.
- Cockpit shell, pages, styles, control API — GitCrew (the generic pieces `auth`,
  `request-context`, `markdown`, `process` are here).
- Persona roles and company control-file tooling — org automation.

## Candidates for a later move

- Conversations/messages store (currently GitCrew `cockpit/src/store.js`) once a second host
  needs durable chats.
- A markdown work-item source (tasks as files) — useful to both hosts.

## Last Check

- (1) 2026-08-31 — Initial extraction: 27 modules, 21 test files; GitCrew consumes it via
  thin binding modules and its full suite stays green.
