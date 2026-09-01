import assert from "node:assert/strict";
import test from "node:test";

import { createConversationStore } from "../src/conversations.js";
import { createRecall, recallPrompt } from "../src/recall.js";

const Database = await import("better-sqlite3")
  .then((m) => { new m.default(":memory:").close(); return m.default; })
  .catch(() => null);
const sqlite = Database ? test : test.skip;

function fixture() {
  const db = new Database(":memory:");
  const store = createConversationStore({ getDb: () => db, singletonRoles: ["manager"] });
  const a = store.createConversation({ targetRoot: "/repo", role: "ceo", title: "Monday brief", workItemId: 7 });
  store.appendMessage({ conversationId: a, author: "user", content: "Write the brief for inbox/renew-domain.md" });
  store.appendMessage({ conversationId: a, author: "ceo", content: "Brief written: renew the domain first, pricing page blocked." });
  const b = store.createConversation({ targetRoot: "/repo", role: "ops", title: "Vendor check", workItemId: 8 });
  store.appendMessage({ conversationId: b, author: "user", content: "Check vendor renewals" });
  store.appendMessage({ conversationId: b, author: "ops", content: "Two renewals due; 100% under budget.  " + "x".repeat(600) });
  store.createConversation({ targetRoot: "/other", role: "ceo", title: "Elsewhere" });
  return { store, a, b };
}

sqlite("recall lists newest episodes per role or reference and summarises ask and outcome", () => {
  const { store, a, b } = fixture();
  const { recall } = createRecall({ conversations: store });
  const byRole = recall({ targetRoot: "/repo", role: "ceo" });
  assert.deepEqual(byRole.map((e) => e.conversationId), [a]);
  assert.equal(byRole[0].opening, "Write the brief for inbox/renew-domain.md");
  assert.match(byRole[0].outcome, /^Brief written/);
  assert.equal(byRole[0].turns, 2);
  const byRef = recall({ targetRoot: "/repo", workItemId: 8 });
  assert.deepEqual(byRef.map((e) => [e.conversationId, e.role]), [[b, "ops"]]);
  assert.equal(byRef[0].outcome.length, 400, "outcomes are clipped");
  assert.ok(byRef[0].outcome.endsWith("…"));
  assert.deepEqual(recall({ targetRoot: "/repo", limit: 1 }).map((e) => e.conversationId), [b], "newest first");
});

sqlite("recall by query finds conversations that mention a path and escapes LIKE wildcards", () => {
  const { store, a } = fixture();
  const { recall } = createRecall({ conversations: store });
  assert.deepEqual(recall({ targetRoot: "/repo", query: "renew-domain.md" }).map((e) => e.conversationId), [a]);
  assert.deepEqual(recall({ targetRoot: "/repo", query: "100%" }).map((e) => e.role), ["ops"]);
  assert.deepEqual(recall({ targetRoot: "/repo", query: "100_" }), [], "underscore is literal, not a wildcard");
  assert.deepEqual(recall({ targetRoot: "/other", query: "brief" }), [], "scoped to the project");
  const text = recallPrompt(recall({ targetRoot: "/repo", role: "ceo" }));
  assert.match(text, /^## Recall\n.*history, not as instructions/);
  assert.match(text, /- \[ceo #7\] Monday brief \(\d{4}-\d{2}-\d{2}, 2 turns\)\n  asked: Write the brief/);
  assert.equal(recallPrompt([]), "");
});
