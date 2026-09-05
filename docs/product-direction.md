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
2. **Make unattended work recoverable.** Introduce transactional run and action storage,
   atomic claims, a durable outbox, explicit retry states, idempotency keys where providers
   support them, and reconciliation after ambiguous network failures. Add pause/cancel and
   restart recovery. The current file queues are designed for one operator process; a hash
   chain is evidence of modification, not a concurrency or delivery guarantee.
3. **Make the result visible.** Persist artifacts and external receipts in a task/run timeline.
   Show blocked dependencies, required approvals, failed delivery and the exact next action.
   Attach the existing ledger in standalone mode and show cost per accepted deliverable. The
   current standalone console does not automatically supply a budget ledger or outcome store.
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

## Do agents need reflections?

They do not need reflections to work. They need clear instructions, appropriate tools, useful
context and feedback on the outcome. Reflections are useful when recurring work exposes a
specific reusable lesson; generating them after every trivial action adds noise and cost.

Keep reflections optional, scoped to an agent or task type, bounded and operator-approved.
Capture the observed outcome, evidence, the proposed change and when it applies. Avoid storing
long reasoning traces or treating a model's confidence as proof. Add expiry, deduplication and a
way to measure whether a lesson improved later work. When a lesson repeatedly proves useful,
promote it into a reviewed skill or SOP instead of growing the journal indefinitely.

## Skills or SOPs?

Keep **Skills** as the interoperable technical category. Use **SOPs** for the subset that defines
a team's repeatable operating procedure. A skill can also be a capability, reference guide or
tool convention, so renaming every skill to SOP would narrow the meaning incorrectly.

For an operations audience, consider a future **Playbooks** page containing skills and SOPs.
An SOP should name its trigger, inputs, steps, acceptance checks, approval points, owner and
version. Preserve the existing SKILL.md and flat Markdown formats. No Skills-to-SOPs rename is
included in this change.

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
