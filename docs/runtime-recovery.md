# Tasks and recovery

[Documentation](README.md) / Tasks and recovery

`crewrun up <project> --console` runs the durable worker, schedule/heartbeat trigger loop and
console. `crewrun console <project>` runs manual tasks and pending deliveries without triggering
scheduled work. Multiple processes for the same project share the same database and claims.
Host-supplied `runTurn` implementations retain their existing lifecycle and storage choices.

## Operator flow

1. Create a task in **Tasks**, naming the agent, requested result and optional dependency.
   A dependency must be accepted before its dependent task is claimed.
2. Review outgoing Slack/Gmail payloads in **Approvals**. Approval and outbox eligibility commit
   together. Provider delivery happens later, outside the transaction, after authority checks.
3. Open the task to see artifacts, attempt history, external receipts, errors and the next action.
   Downloaded results are served as plain-text attachments. Accept the deliverable only after
   checking it; task completion alone does not count as acceptance.
4. For an uncertain delivery, use **Check provider for receipt** when the connection has history
   access, or record the receipt and evidence manually. An empty search is not proof of failure.
   Verified non-delivery creates a fresh approval request; it never silently resends.

## Storage and recovery rules

`runtime-store` uses `better-sqlite3` with WAL, full synchronous commits, foreign keys and a busy
timeout. State lives at `CREW_HOME/runtime/<project-hash>/state.sqlite` (default `~/.crew`), with
an owner-only directory and database file on Unix. Windows uses the operator account's filesystem
permissions. Credentials and exact review payloads are private operator state, outside the repo;
the database is not encrypted. SQLite's native module is a required runtime dependency.
See [Security and storage](security.md) for installation requirements and credential handling.

Runs, attempts, actions, trigger cursors, artifacts, receipts and events commit transactionally.
Claims have unique lease tokens and deadlines. Workers renew their leases; stale workers cannot
overwrite current state. Trigger cursor changes and enqueueing commit together, coalescing missed
schedule windows. Hooks enqueue using the host event's stable external ID. Existing exported
file-based `createScheduler`, `createPulse`, and action-approval APIs remain single-operator host
helpers; hash-chain auditing is evidence of modification, not delivery or concurrency control.

| State | Recovery / next action |
|---|---|
| Queued task or approved action | Another worker may atomically claim it after restart |
| Running task with expired lease | Mark interrupted; review saved artifacts/actions, then explicitly retry |
| Paused task | Stop future claims and signal active capture; resume restarts the saved task |
| Cancelled task | Stop future claims, cancel unsent queued actions, preserve in-flight receipts |
| Rate-limited action | Persist retry time, respect Retry-After, exponential backoff; stop after five attempts |
| Send timeout, unreadable response, server error or expired delivery lease | Mark uncertain; reconcile before resending |
| Changed account, draft or authority | Fail delivery; submit a newly reviewed request |
| Expired approval | Fail after 24 hours; require a new review |

Pause/resume is task-level recovery, not a checkpoint of model internals. Engine subprocess
termination is best effort. An already-started external send can finish after pause/cancel, so
its receipt stays visible. Leases fence Crewrun's brokered actions; they do not undo arbitrary
native shell/file operations performed by a vendor runtime. Use the execution policy when those
operations need isolation. Keep the database on a local disk shared by the operator processes;
this implementation does not provide a distributed multi-machine queue.

Old standalone credential and pending-action files import once. Original files remain as an
operator backup. Pending legacy sends enter the uncertain state because an earlier process may
have delivered them without recording completion. Their old approval IDs are hidden from the
active queue, and imported payloads require reconciliation and a replacement request.

## Provider delivery semantics

- Slack requests carry one stable UUID `client_msg_id` per durable action across safe retries.
  This provides correlation and uses Slack's duplicate-message handling where supported; Crewrun
  does not treat it as an unlimited exactly-once guarantee. Positive reconciliation matches that
  ID in channel/thread history. Appropriate optional history scopes are required, and a limited
  history page with no match leaves the action uncertain. [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/),
  [rate limits](https://docs.slack.dev/apis/web-api/rate-limits/).
- Gmail sends the exact reviewed raw MIME, rechecks the draft digest, and persists the returned
  message/thread IDs. The draft-send API exposes no caller idempotency key. If an existing reviewed
  Message-ID is available and inbox reads were explicitly enabled, the operator can search Sent
  mail for a candidate receipt in the timeline. The operator confirms it before marking delivery,
  because Message-IDs can be reused. Otherwise reconciliation is manual. No Message-ID is silently
  inserted into the reviewed draft. [Gmail drafts.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send),
  [mail search](https://developers.google.com/workspace/gmail/api/guides/filtering).

A successful provider receipt records that the service accepted the action. In particular, a
Gmail send response is not proof that a recipient received or read the email; delivery can later
fail inside the provider. Operator acceptance remains the outcome signal. Gmail 403 rate-limit
errors and HTTP 429 rejections receive scheduled retries; ambiguous send errors do not.
[Gmail error handling](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

## Results, usage and embedding

`createStandaloneRuntime` exposes `store`, `operations`, `tick`, `start`, `stop`, `close` and
`runTurn`. The console operations include `enqueueTask`, `controlTask`, `decideApproval`,
`checkDelivery` and `reconcileAction`. `createRuntimeStore` is also available independently.
Close stores when an embedding application is finished with them.

The capture helper accepts an AbortSignal and returns runner/engine/provider information,
usage and engine session ID alongside `ok`, `text` and `reason`. Completion, text artifacts and
one ledger row commit together. Agents granted `task.saveArtifact | internal-write` can save
intermediate text results through the standalone bridge before a turn finishes. Saved artifacts
survive an interrupted turn; unsaved model output may be lost.

Usage divides the current month's recorded spend (including estimates and failed attempts) by
deliverables explicitly accepted that month. It is a period metric, not an attribution of every
historical cost to each deliverable. Missing usage is flagged, and subscription estimates are not
invoices. Acceptance is blocked until the model turn completes and all requested deliveries have
succeeded. Budget reservations and hard provider spending limits remain future work.

For code examples, see [Library integration](library.md). Test coverage and live-test setup are
described in [Development](development.md).
