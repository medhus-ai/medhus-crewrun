import assert from "node:assert/strict";
import test from "node:test";

import { createConversationStore } from "../src/conversations.js";
import { HANDOFF_STATUSES, createHandoffQueue } from "../src/handoffs.js";

const Database = await import("better-sqlite3")
  .then((m) => { new m.default(":memory:").close(); return m.default; })
  .catch(() => null);
const sqlite = Database ? test : test.skip;

function fixture() {
  const db = new Database(":memory:");
  const conversations = createConversationStore({ getDb: () => db, singletonRoles: ["manager"] });
  const queue = createHandoffQueue({ getDb: () => db, table: "manager_handoffs" });
  const cid = conversations.getOrCreateConversation({ targetRoot: "/repo", role: "manager", workItemId: 7 });
  return { db, conversations, queue, cid };
}

sqlite("handoffs attach once, retry without duplicate transcript input, and complete", () => {
  const { conversations, queue, cid } = fixture();
  const first = queue.enqueueHandoff({ targetRoot: "/repo", conversationId: cid, taskKey: "i7", body: "please triage", externalId: "op-1" });
  const again = queue.enqueueHandoff({ targetRoot: "/repo", conversationId: cid, taskKey: "i7", body: "please triage", externalId: "op-1" });
  assert.equal(first.created, true);
  assert.equal(again.created, false, "external ids are idempotent");
  assert.equal(again.handoff.id, first.handoff.id);
  queue.enqueueHandoff({ targetRoot: "/repo", conversationId: cid, taskKey: "i7", body: "and plan it" });

  const batch = queue.claimHandoffBatch({ conversationId: cid });
  assert.deepEqual(batch.map((h) => h.status), [HANDOFF_STATUSES.PROCESSING, HANDOFF_STATUSES.PROCESSING]);
  assert.equal(conversations.listMessages(cid).length, 2, "queued bodies became user messages");
  const token = batch[0].leaseToken;
  assert.ok(token);
  assert.deepEqual(queue.claimHandoffBatch({ conversationId: cid }), [], "leased rows are not claimable");

  assert.equal(queue.retryHandoffBatch({ conversationId: cid, handoffIds: batch.map((h) => h.id), leaseToken: token, error: "runner busy", delayMs: 0 }), 2);
  const retried = queue.claimHandoffBatch({ conversationId: cid });
  assert.equal(retried.length, 2);
  assert.equal(conversations.listMessages(cid).length, 2, "a retry never re-attaches the input");
  assert.equal(retried[0].attemptCount, 2);
  assert.equal(queue.completeHandoffBatch({ conversationId: cid, handoffIds: retried.map((h) => h.id), leaseToken: retried[0].leaseToken }), 2);
  assert.deepEqual(queue.listHandoffs({ conversationId: cid, includeCompleted: false }), []);
  assert.equal(queue.listHandoffs({ targetRoot: "/repo" }).length, 2);
  assert.deepEqual(queue.listPendingHandoffConversations(), []);
});

sqlite("leases fence stale workers and expire so a stranded batch is recoverable", () => {
  const { queue, cid } = fixture();
  queue.enqueueHandoff({ targetRoot: "/repo", conversationId: cid, taskKey: "i7", body: "status?" });
  const t0 = new Date("2026-09-01T10:00:00.000Z");
  const batch = queue.claimHandoffBatch({ conversationId: cid, now: t0, leaseMs: 60_000 });
  const ids = batch.map((h) => h.id);
  assert.equal(queue.renewHandoffBatch({ conversationId: cid, handoffIds: ids, leaseToken: "not-mine" }), 0);
  assert.equal(queue.completeHandoffBatch({ conversationId: cid, handoffIds: ids, leaseToken: "not-mine" }), 0);
  assert.equal(queue.renewHandoffBatch({ conversationId: cid, handoffIds: ids, leaseToken: batch[0].leaseToken, now: t0, leaseMs: 60_000 }), 1);

  const pendingBefore = queue.listPendingHandoffConversations({ now: new Date(t0.getTime() + 30_000) });
  assert.deepEqual(pendingBefore, [], "an active lease hides the work");
  const pendingAfter = queue.listPendingHandoffConversations({ now: new Date(t0.getTime() + 61_000) });
  assert.deepEqual(pendingAfter.map((p) => p.conversationId), [cid], "an expired lease exposes it again");
  const reclaimed = queue.claimHandoffBatch({ conversationId: cid, now: new Date(t0.getTime() + 61_000) });
  assert.equal(reclaimed.length, 1);
  assert.notEqual(reclaimed[0].leaseToken, batch[0].leaseToken);
  assert.equal(queue.completeHandoffBatch({ conversationId: cid, handoffIds: ids, leaseToken: batch[0].leaseToken }), 0, "the old owner cannot complete a reclaimed batch");
  assert.throws(() => queue.claimHandoffBatch({ conversationId: cid, leaseMs: 10 }), /between 1 second and 1 hour/);
  assert.throws(() => queue.enqueueHandoff({ targetRoot: "/repo", conversationId: cid, taskKey: "", body: "x" }), /taskKey/);
  assert.throws(() => createHandoffQueue({ getDb: () => null, table: "bad;name" }), /invalid handoff table/);
});
