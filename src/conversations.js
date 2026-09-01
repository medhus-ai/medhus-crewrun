import path from "node:path";

// Durable chat threads shared by every crew host: one conversation per (project, role, optional
// reference), messages with vendor-reported usage. The host owns the SQLite handle; the store
// owns the schema. Column names: issue_id is an external reference, work_item_id an internal one.

const CONVERSATION_COLUMNS = "id, target_root, role, title, issue_id, work_item_id, purpose, engine_session_id, worktree_dir, worktree_branch, created_at, updated_at";

export function ensureConversationSchema(db, { singletonRoles = [], uniqueIndexes = true } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_root TEXT NOT NULL,
      role TEXT NOT NULL,
      title TEXT,
      purpose TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_target_role ON conversations (target_root, role);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages (conversation_id);
  `);
  const conversationCols = new Set(db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name));
  const messageCols = new Set(db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name));
  if (!conversationCols.has("issue_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN issue_id INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_conv_issue ON conversations (target_root, issue_id)");
  }
  if (!messageCols.has("usage_json")) db.exec("ALTER TABLE messages ADD COLUMN usage_json TEXT");
  if (!conversationCols.has("engine_session_id")) db.exec("ALTER TABLE conversations ADD COLUMN engine_session_id TEXT");
  if (!conversationCols.has("worktree_dir")) {
    db.exec("ALTER TABLE conversations ADD COLUMN worktree_dir TEXT");
    db.exec("ALTER TABLE conversations ADD COLUMN worktree_branch TEXT");
  }
  if (!conversationCols.has("work_item_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN work_item_id INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS idx_conv_work_item ON conversations (target_root, work_item_id)");
  }
  if (!conversationCols.has("purpose")) {
    db.exec("ALTER TABLE conversations ADD COLUMN purpose TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_conv_purpose ON conversations (target_root, purpose)");
  }
  // Partial unique indexes make singleton get-or-create race-safe across processes. A host with
  // legacy duplicates runs its own collapse migration first and passes uniqueIndexes: false.
  if (uniqueIndexes) {
    const roles = singletonRoles.map((role) => `'${String(role).replace(/'/g, "''")}'`).join(", ");
    if (roles) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_singleton_work_item ON conversations (target_root, role, work_item_id)
          WHERE role IN (${roles}) AND work_item_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_singleton_issue ON conversations (target_root, role, issue_id)
          WHERE role IN (${roles}) AND work_item_id IS NULL AND issue_id IS NOT NULL;
      `);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_purpose_work_item ON conversations (target_root, role, work_item_id, purpose)
        WHERE work_item_id IS NOT NULL AND purpose IS NOT NULL AND TRIM(purpose) <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_purpose_issue ON conversations (target_root, role, issue_id, purpose)
        WHERE work_item_id IS NULL AND issue_id IS NOT NULL AND purpose IS NOT NULL AND TRIM(purpose) <> '';
    `);
  }
}

// `singletonRoles` get exactly one conversation per project + reference (a task's manager
// thread); purpose-scoped conversations are singletons per (role, reference, purpose).
export function createConversationStore({ getDb, singletonRoles = [], uniqueIndexes = true } = {}) {
  if (typeof getDb !== "function") throw new Error("createConversationStore requires a getDb() handle");
  const singleton = new Set(singletonRoles);
  let ready = null;

  function db() {
    const handle = getDb();
    if (ready !== handle) {
      ensureConversationSchema(handle, { singletonRoles, uniqueIndexes });
      ready = handle;
    }
    return handle;
  }

  function createConversation({ targetRoot, role, title, issueId, workItemId, purpose }) {
    const now = new Date().toISOString();
    const info = db().prepare(
      "INSERT INTO conversations (target_root, role, title, issue_id, work_item_id, purpose, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(normalizeRoot(targetRoot), role, title || null, reference(issueId), reference(workItemId), normalizePurpose(purpose) || null, now, now);
    return Number(info.lastInsertRowid);
  }

  function getOrCreateConversation({ targetRoot, role, title, issueId, workItemId, purpose }) {
    const root = normalizeRoot(targetRoot);
    const workItem = reference(workItemId);
    const issue = workItem == null ? reference(issueId) : null;
    const scoped = normalizePurpose(purpose) || null;
    if (workItem == null && issue == null) return createConversation({ targetRoot: root, role, title, purpose: scoped });
    if (singleton.has(String(role || "")) && !scoped) {
      return getOrCreateSingleton({ root, role, title, issue, workItem, purpose: null, byRole: true });
    }
    if (scoped) return getOrCreateSingleton({ root, role, title, issue, workItem, purpose: scoped, byRole: false });
    const existing = listConversations({ targetRoot: root, role, issueId, workItemId, limit: 50 }).find((row) => !row.purpose);
    return existing ? Number(existing.id) : createConversation({ targetRoot: root, role, title, issueId, workItemId });
  }

  // INSERT OR IGNORE plus a re-select returns the row that won a concurrent creation attempt.
  function getOrCreateSingleton({ root, role, title, issue, workItem, purpose }) {
    const conds = ["target_root = ?", "role = ?"];
    const args = [root, role];
    if (workItem != null) { conds.push("work_item_id = ?"); args.push(workItem); }
    else { conds.push("work_item_id IS NULL", "issue_id = ?"); args.push(issue); }
    if (purpose) { conds.push("purpose = ?"); args.push(purpose); }
    else conds.push("(purpose IS NULL OR TRIM(purpose) = '')");
    const select = `SELECT id FROM conversations WHERE ${conds.join(" AND ")} ORDER BY id ASC LIMIT 1`;
    const existing = db().prepare(select).get(...args);
    if (existing) return Number(existing.id);
    const now = new Date().toISOString();
    db().prepare(
      "INSERT OR IGNORE INTO conversations (target_root, role, title, issue_id, work_item_id, purpose, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(root, role, title || null, issue, workItem, purpose, now, now);
    const winner = db().prepare(select).get(...args);
    if (!winner) throw new Error(`could not create ${role} conversation`);
    return Number(winner.id);
  }

  function listConversations({ targetRoot, role, issueId, workItemId, purpose, limit } = {}) {
    const conds = ["target_root = ?"];
    const args = [normalizeRoot(targetRoot)];
    if (role) { conds.push("role = ?"); args.push(role); }
    if (issueId != null) { conds.push("issue_id = ?"); args.push(Number(issueId)); }
    if (workItemId != null) { conds.push("work_item_id = ?"); args.push(Number(workItemId)); }
    if (purpose != null) { conds.push("purpose = ?"); args.push(normalizePurpose(purpose)); }
    const n = Number(limit);
    const limitSql = Number.isInteger(n) && n > 0 ? " LIMIT ?" : "";
    if (limitSql) args.push(Math.min(n, 200));
    return db().prepare(
      `SELECT id, target_root, role, title, issue_id, work_item_id, purpose, engine_session_id, worktree_branch, created_at, updated_at FROM conversations WHERE ${conds.join(" AND ")} ORDER BY updated_at DESC, id DESC${limitSql}`
    ).all(...args);
  }

  function countConversations() {
    return Number(db().prepare("SELECT COUNT(*) AS n FROM conversations").get().n);
  }

  function getConversation(id) {
    return db().prepare(`SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = ?`).get(Number(id)) || null;
  }

  function setConversationTitle(id, title) {
    const value = String(title || "").trim();
    if (!value) return;
    db().prepare("UPDATE conversations SET title = ? WHERE id = ?").run(value.slice(0, 120), Number(id));
  }

  function setConversationIssue(id, issueId) {
    db().prepare("UPDATE conversations SET issue_id = ? WHERE id = ?").run(reference(issueId), Number(id));
  }

  function setConversationEngineSession(id, engineSessionId) {
    db().prepare("UPDATE conversations SET engine_session_id = ? WHERE id = ?")
      .run(engineSessionId == null ? null : String(engineSessionId), Number(id));
  }

  function setConversationWorktree(id, dir, branch) {
    db().prepare("UPDATE conversations SET worktree_dir = ?, worktree_branch = ? WHERE id = ?")
      .run(dir == null ? null : String(dir), branch == null ? null : String(branch), Number(id));
  }

  function appendMessage({ conversationId, author, content, usage }) {
    const id = Number(conversationId);
    // Ordering the chat list by an ISO timestamp is otherwise ambiguous when a
    // new conversation and its first turn land in the same millisecond.
    const current = db().prepare("SELECT updated_at FROM conversations WHERE id = ?").get(id);
    const currentMs = Date.parse(current?.updated_at || "");
    const now = new Date(Math.max(Date.now(), Number.isFinite(currentMs) ? currentMs + 1 : 0)).toISOString();
    const info = db().prepare(
      "INSERT INTO messages (conversation_id, author, content, usage_json, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, author, content, usage ? JSON.stringify(usage) : null, now);
    db().prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, id);
    return Number(info.lastInsertRowid);
  }

  // Full-text-ish lookup for recall: messages whose content mentions `query` (a path, an id, a
  // phrase), newest first, joined with their conversation so callers can group by thread.
  function searchMessages({ targetRoot, query, role, workItemId, issueId, limit = 20 } = {}) {
    const conds = ["c.target_root = ?"];
    const args = [normalizeRoot(targetRoot)];
    const text = String(query || "").trim();
    if (text) { conds.push("m.content LIKE ? ESCAPE '\\'"); args.push(`%${text.replace(/[\\%_]/g, "\\$&")}%`); }
    if (role) { conds.push("c.role = ?"); args.push(role); }
    if (workItemId != null) { conds.push("c.work_item_id = ?"); args.push(Number(workItemId)); }
    if (issueId != null) { conds.push("c.issue_id = ?"); args.push(Number(issueId)); }
    const n = Number(limit);
    args.push(Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 20);
    return db().prepare(
      `SELECT m.id, m.conversation_id, m.author, m.content, m.created_at, c.role, c.title, c.work_item_id, c.issue_id, c.purpose
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE ${conds.join(" AND ")} ORDER BY m.id DESC LIMIT ?`
    ).all(...args).map((row) => ({ ...row, author: row.author === "human" ? "user" : row.author }));
  }

  function listMessages(conversationId) {
    return db().prepare(
      "SELECT id, conversation_id, author, content, usage_json, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC"
    ).all(Number(conversationId)).map((row) => ({
      ...row,
      // Legacy rows recorded the user's turn as author "human"; surface it as "user".
      author: row.author === "human" ? "user" : row.author,
      usage: row.usage_json ? safeParse(row.usage_json) : null
    }));
  }

  return {
    createConversation,
    getOrCreateConversation,
    listConversations,
    countConversations,
    getConversation,
    setConversationTitle,
    setConversationIssue,
    setConversationEngineSession,
    setConversationWorktree,
    appendMessage,
    listMessages,
    searchMessages
  };
}

export function normalizeConversationPurpose(value) {
  return String(value || "").trim().slice(0, 80);
}

const normalizePurpose = normalizeConversationPurpose;

function reference(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeRoot(targetRoot) {
  const value = String(targetRoot || "").trim();
  return value ? path.resolve(value) : "";
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}
