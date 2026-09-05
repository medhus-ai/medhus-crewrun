# Delivering value with Crewrun

Assessment: 2026-09-05. This is a proposed product direction, not a claim of benchmarked superiority.

Crewrun's strongest opportunity is a small operations crew that completes recurring work across
the tools a team already uses, under permissions the team can inspect. Start with one customer
and one measurable job. A larger agent catalog alone does not establish value.

## What competitors already cover

| Product | Relevant documented capability | What Crewrun must demonstrate |
|---|---|---|
| CrewAI | Agent crews plus event-driven flows, state and persistence | Faster setup for a particular recurring job and better accepted outputs. [CrewAI Flows](https://docs.crewai.com/en/concepts/flows) |
| LangGraph | Persistent state, checkpoints and interrupts for review/resume | Reliable recovery and simpler operation for the target customer. [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) |
| n8n | Gmail operations and human review of agent tool calls | A useful adaptive workflow with less maintenance than the equivalent automation. [Gmail operations](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.gmail/message-operations/) |

This is a relevant comparison set, not an exhaustive survey of every agent product. These
capabilities make generic scheduling, connectors, memory and approvals insufficient as a unique
selling point. My recommendation is to combine portable agent definitions, vendor runtime choice,
reviewed authority and visible delivery into one unusually dependable experience for a specific job.

## First customer and first job

Pilot with small service teams managing several client projects. The first job: prepare the daily
client-operations brief, identify overdue commitments, draft the appropriate follow-up, obtain
approval and record what was actually delivered. Start with one agent; add a reviewer only if it
improves measured quality enough to justify the extra latency and cost.

The user should see: input evidence → proposed work → exact review → delivery receipt → outcome.
Every item needs an owner, an acceptance rule, a due time and a visible blocked state. “The agent
ran successfully” is not the same as “the customer received the correct update.”

## Build in this order

1. **Make the first completed job easy.** Add a guided provider check, an OAuth consent flow,
   three maintained templates, a sample-data trial and an immediate run with a visible result.
   Target a first accepted output within ten minutes; measure this with new users. The current
   standalone adapter removes custom-host code but still requires operator-supplied credentials.
2. **Make unattended work recoverable — implemented in standalone mode.** SQLite transactions,
   atomic leases, a durable outbox, retry deadlines, restart recovery, and pause/cancel controls
   now back runs and outgoing actions. Ambiguous sends require reconciliation; interrupted
   model turns require review and an explicit retry. See [runtime recovery](runtime-recovery.md)
   for provider limits and the distinction between restart recovery and model checkpoints.
3. **Make the result visible — implemented in standalone mode.** Tasks now persist artifacts,
   external receipts and a timeline with approvals, blocked dependencies, unresolved deliveries
   and the next action. The existing budget ledger is attached automatically. Operators accept
   deliverables explicitly; Usage displays recorded monthly cost per accepted deliverable and
   flags missing usage. Provider subscription estimates remain estimates.
4. **Measure quality before adding autonomy.** Build a replay suite from representative,
   permissioned customer tasks. Check factual grounding, required fields, recipient accuracy,
   task completion and human correction effort. Enforce budget reservations and cancellation
   at runtime; displaying a cap in a contract is not enough to prevent spending.
5. **Improve from evidence.** Record feedback, propose a narrow lesson or workflow update,
   evaluate it against held-out tasks, and promote it only after review. Offer previews and
   rollback for all durable context changes.

A practical six-week pilot: two weeks on onboarding and the first workflow, two on delivery and
recovery, and two on evaluation with five design partners. This is a sequencing proposal, not an
estimate that every reliability feature can be completed in six weeks.

## Skills and reflections

Use **Skills** throughout the product. Save user/application-specific procedures that need to be
repeatable; do not install generic instructions by default. A general Skill is justified only by
evidence of improved reliability. Preserve both SKILL.md and flat Markdown interoperability.

User/application facts and preferences belong in saved context. Explicit user instructions can
be saved by a trusted operator; agent-inferred updates need review. Reflections are optional,
off by default, and useful only as short proposals to improve a named preference or Skill.
Pending duplicates are reused, proposals expire after 30 days, and approval promotes the update
to its destination. Do not append journals after each action. Legacy journals remain available
for manual migration and are no longer automatically loaded into prompts.

## Prove the advantage

Use the same 50–100 representative tasks, input data, tool permissions and model budget for
Crewrun, a manual baseline and the strongest relevant competing workflow. Record:

- Accepted deliverables per attempted task, with independent human review.
- Human minutes spent supervising and correcting each accepted deliverable.
- Total cost and elapsed time per accepted deliverable, including retries and review agents.
- Duplicate or incorrect external actions, recovery success after forced crashes, and missed deadlines.
- Setup time, four-week repeat use and whether customers choose to pay after the pilot.

Set targets before the pilot, then publish the task definitions, scoring rules and failures with
the results. Claim an advantage only for the workflows and conditions the measurements support.
