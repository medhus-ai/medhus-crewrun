import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { createConversationStore, ensureConversationSchema } from "../src/conversations.js";

function memoryStore(options = {}) {
  const db = new Database(":memory:");
  return { db, store: createConversationStore({ getDb: () => db, singletonRoles: ["manager"], ...options }) };
}

test("conversations and messages round-trip with usage and legacy author mapping", () => {
  const { db, store } = memoryStore();
  const id = store.createConversation({ targetRoot: "/repo", role: "ceo", title: "Brief" });
  store.appendMessage({ conversationId: id, author: "user", content: "hi" });
  db.prepare("INSERT INTO messages (conversation_id, author, content, created_at) VALUES (?, 'human', 'legacy', '2020-01-01T00:00:00.000Z')").run(id);
  store.appendMessage({ conversationId: id, author: "ceo", content: "hello", usage: { inputTokens: 3 } });
  const messages = store.listMessages(id);
  assert.deepEqual(messages.map((m) => m.author), ["user", "user", "ceo"]);
  assert.deepEqual(messages[2].usage, { inputTokens: 3 });
  assert.equal(store.countConversations(), 1);
  assert.equal(store.getConversation(id).title, "Brief");
  store.setConversationTitle(id, "  Daily brief  ");
  store.setConversationEngineSession(id, "sess-1");
  store.setConversationWorktree(id, "/tmp/wt", "crew/x");
  store.setConversationIssue(id, 12);
  const row = store.getConversation(id);
  assert.equal(row.title, "Daily brief");
  assert.equal(row.engine_session_id, "sess-1");
  assert.equal(row.worktree_branch, "crew/x");
  assert.equal(row.issue_id, 12);
  assert.ok(Date.parse(row.updated_at) >= Date.parse(row.created_at));
});

test("singleton roles and purpose-scoped threads get exactly one conversation per reference", () => {
  const { store } = memoryStore();
  const a = store.getOrCreateConversation({ targetRoot: "/repo", role: "manager", workItemId: 7 });
  const b = store.getOrCreateConversation({ targetRoot: "/repo", role: "manager", workItemId: 7, title: "later" });
  assert.equal(a, b);
  assert.notEqual(a, store.getOrCreateConversation({ targetRoot: "/repo", role: "manager", workItemId: 8 }));
  assert.notEqual(a, store.getOrCreateConversation({ targetRoot: "/other", role: "manager", workItemId: 7 }));

  const setup = store.getOrCreateConversation({ targetRoot: "/repo", role: "planner", workItemId: 7, purpose: "setup" });
  assert.equal(setup, store.getOrCreateConversation({ targetRoot: "/repo", role: "planner", workItemId: 7, purpose: " setup " }));
  const plain = store.getOrCreateConversation({ targetRoot: "/repo", role: "planner", workItemId: 7 });
  assert.notEqual(plain, setup, "a purpose thread never doubles as the plain thread");
  assert.equal(plain, store.getOrCreateConversation({ targetRoot: "/repo", role: "planner", workItemId: 7 }));
  assert.notEqual(
    store.getOrCreateConversation({ targetRoot: "/repo", role: "ceo" }),
    store.getOrCreateConversation({ targetRoot: "/repo", role: "ceo" }),
    "unreferenced chats are always new"
  );
  assert.deepEqual(store.listConversations({ targetRoot: "/repo", role: "planner", workItemId: 7, purpose: "setup" }).map((r) => r.id), [setup]);
});

test("schema upgrades a legacy table in place and unique indexes are optional", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, target_root TEXT NOT NULL, role TEXT NOT NULL, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.exec("INSERT INTO conversations (target_root, role, created_at, updated_at) VALUES ('/r', 'manager', 'x', 'x'), ('/r', 'manager', 'x', 'x')");
  db.exec("UPDATE conversations SET title = 'dup'");
  ensureConversationSchema(db, { singletonRoles: ["manager"], uniqueIndexes: false });
  const cols = db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name);
  for (const col of ["issue_id", "work_item_id", "purpose", "engine_session_id", "worktree_dir"]) assert.ok(cols.includes(col), col);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
  assert.ok(!indexes.includes("idx_conv_singleton_work_item"));
  ensureConversationSchema(db, { singletonRoles: ["manager"] });
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_conv_singleton_work_item'").get());
});
