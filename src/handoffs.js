import { randomUUID } from "node:crypto";
import path from "node:path";

// A durable queue of inputs for a role's singleton conversation — "wake the manager". Inputs are
// enqueued from anywhere (a webhook, an API call, another role), attached to the transcript
// exactly once, and claimed in bounded batches under a lease so two processes never run the same
// turn and a crashed worker's batch becomes reclaimable when its lease expires. Requires the
// conversation store's tables (messages are attached to them).

export const HANDOFF_STATUSES = Object.freeze({
  QUEUED: "queued",
  ATTACHED: "attached",
  PROCESSING: "processing",
  COMPLETED: "completed"
});

export const HANDOFF_LEASE_MS = 5 * 60 * 1000;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 60 * 60 * 1000;
const DEFAULT_BATCH_LIMIT = 20;

export function ensureHandoffSchema(db, { table = "handoffs" } = {}) {
  const t = tableName(table);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${t} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_root TEXT NOT NULL,
      conversation_id INTEGER NOT NULL,
      task_key TEXT NOT NULL,
      external_id TEXT,
      from_role TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      message_id INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
    );
  `);
  const cols = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  if (!cols.has("lease_token")) db.exec(`ALTER TABLE ${t} ADD COLUMN lease_token TEXT`);
  if (!cols.has("lease_expires_at")) db.exec(`ALTER TABLE ${t} ADD COLUMN lease_expires_at TEXT`);
  if (!cols.has("from_role")) db.exec(`ALTER TABLE ${t} ADD COLUMN from_role TEXT`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_${t}_pending ON ${t} (conversation_id, status, next_attempt_at, id);
    CREATE INDEX IF NOT EXISTS idx_${t}_root ON ${t} (target_root, status, next_attempt_at, id);
    CREATE INDEX IF NOT EXISTS idx_${t}_claim ON ${t} (conversation_id, status, lease_expires_at, next_attempt_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${t}_external ON ${t} (target_root, task_key, external_id)
      WHERE external_id IS NOT NULL AND external_id <> '';
  `);
}

export function createHandoffQueue({ getDb, table = "handoffs", batchLimit = DEFAULT_BATCH_LIMIT, leaseMs = HANDOFF_LEASE_MS, governance = null } = {}) {
  if (typeof getDb !== "function") throw new Error("createHandoffQueue requires a getDb() handle");
  const t = tableName(table);
  const S = HANDOFF_STATUSES;
  let ready = null;

  function db() {
    const handle = getDb();
    if (ready !== handle) {
      ensureHandoffSchema(handle, { table: t });
      ready = handle;
    }
    return handle;
  }

  // `externalId` (a request or operation id) makes a retried caller get the original handoff
  // instead of creating a second turn.
  function enqueueHandoff({ targetRoot, conversationId, taskKey, body, externalId = "", fromRole = "" } = {}) {
    const root = normalizeRoot(targetRoot);
    const cid = Number(conversationId);
    const key = String(taskKey || "").trim();
    const text = String(body || "").trim();
    const external = String(externalId || "").trim() || null;
    const sender = normalizeRole(fromRole);
    if (!root) throw new Error("targetRoot is required for a handoff");
    if (!Number.isInteger(cid) || cid <= 0) throw new Error("conversationId is required for a handoff");
    if (!key) throw new Error("taskKey is required for a handoff");
    if (!text) throw new Error("body is required for a handoff");
    const handle = db();
    const owner = handle.prepare("SELECT target_root, role FROM conversations WHERE id = ?").get(cid);
    if (!owner) throw new Error(`conversation ${cid} does not exist`);
    if (owner.target_root !== root) throw new Error(`conversation ${cid} belongs to ${owner.target_root}, not ${root}`);
    const authorization = authorizeHandoff({ sender, receiver: owner.role, targetRoot: root, conversationId: cid, taskKey: key, externalId: external });
    const now = new Date().toISOString();
    if (external) {
      const result = handle.transaction(() => {
        const info = handle.prepare(`
          INSERT OR IGNORE INTO ${t} (target_root, conversation_id, task_key, external_id, from_role, body, status, attempt_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(root, cid, key, external, sender || null, text, S.QUEUED, now, now);
        const row = handle.prepare(`SELECT * FROM ${t} WHERE target_root = ? AND task_key = ? AND external_id = ? LIMIT 1`).get(root, key, external);
        return { handoff: normalize(row), created: Number(info.changes || 0) === 1 };
      })();
      // The original idempotency contract is intentionally unchanged for host/webhook ingress.
      // A role-originated retry, however, must not use a key that resolves to another role's
      // conversation: returning that row would expose its queued body to the caller and make the
      // audit trail ambiguous. `fromRole` is supplied by the trusted host execution context.
      if (!result.created && sender && (result.handoff?.conversationId !== cid || result.handoff?.fromRole !== sender)) {
        throw new Error("externalId already belongs to a different role handoff");
      }
      if (result.created) recordHandoff(authorization, { sender, receiver: owner.role, targetRoot: root, conversationId: cid, taskKey: key, externalId: external });
      return result;
    }
    const info = handle.prepare(`
      INSERT INTO ${t} (target_root, conversation_id, task_key, external_id, from_role, body, status, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, ?)
    `).run(root, cid, key, sender || null, text, S.QUEUED, now, now);
    const result = { handoff: getHandoff(Number(info.lastInsertRowid)), created: true };
    recordHandoff(authorization, { sender, receiver: owner.role, targetRoot: root, conversationId: cid, taskKey: key, externalId: null });
    return result;
  }

  function authorizeHandoff({ sender, receiver, targetRoot, conversationId, taskKey, externalId }) {
    if (!sender || !governance?.authorizeHandoff) return null;
    const send = governance.authorizeHandoff({ role: sender, peerRole: receiver, direction: "send" });
    const receive = governance.authorizeHandoff({ role: receiver, peerRole: sender, direction: "receive" });
    const input = { targetRoot, conversationId, taskKey, externalId, peerRole: receiver };
    if (!send?.allowed || !receive?.allowed) {
      recordHandoff({ send, receive }, { sender, receiver, ...input, outcome: "denied" });
      const reason = !send?.allowed ? send?.reason : receive?.reason;
      throw new Error(`handoff ${sender} → ${receiver} is not authorized${reason ? `: ${reason}` : ""}`);
    }
    return { send, receive };
  }

  function recordHandoff(decisions, { sender, receiver, targetRoot, conversationId, taskKey, externalId, outcome = "authorized" }) {
    if (!decisions || typeof governance?.recordAction !== "function") return;
    // Keep the queue body in its durable handoff record; the separate governance audit gets
    // only route metadata so an audit viewer can prove authority without exposing work content.
    const input = { targetRoot, conversationId, taskKey, externalId, peerRole: receiver };
    governance.recordAction({
      role: sender,
      actor: sender,
      action: "handoff-send",
      toolName: "handoff.send",
      outcome,
      decision: decisions.send,
      input
    });
    governance.recordAction({
      role: receiver,
      actor: sender,
      action: "handoff-receive",
      toolName: "handoff.receive",
      outcome,
      decision: decisions.receive,
      input: { ...input, peerRole: sender }
    });
  }

  function getHandoff(id) {
    return normalize(db().prepare(`SELECT * FROM ${t} WHERE id = ?`).get(Number(id)) || null);
  }

  function listHandoffs({ targetRoot, conversationId, statuses = null, includeCompleted = true } = {}) {
    const conds = [];
    const args = [];
    if (targetRoot != null) { conds.push("target_root = ?"); args.push(normalizeRoot(targetRoot)); }
    if (conversationId != null) { conds.push("conversation_id = ?"); args.push(Number(conversationId)); }
    const selected = Array.isArray(statuses) ? statuses.map((v) => String(v || "").trim()).filter(Boolean) : [];
    if (selected.length) { conds.push(`status IN (${selected.map(() => "?").join(", ")})`); args.push(...selected); }
    else if (!includeCompleted) { conds.push("status <> ?"); args.push(S.COMPLETED); }
    const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
    return db().prepare(`SELECT * FROM ${t}${where} ORDER BY id ASC`).all(...args).map(normalize);
  }

  // Atomically attach queued inputs to the transcript and claim a bounded batch for one run.
  // Attached/processing rows are reused after a restart, so retrying never duplicates a message.
  function claimHandoffBatch({ conversationId, now = new Date(), limit = batchLimit, leaseMs: lease = leaseMs } = {}) {
    const cid = Number(conversationId);
    if (!Number.isInteger(cid) || cid <= 0) throw new Error("conversationId is required to claim handoffs");
    const nowIso = timestamp(now);
    const max = Math.max(1, Math.min(batchLimit, Math.floor(Number(limit)) || batchLimit));
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.parse(nowIso) + normalizeLeaseMs(lease)).toISOString();
    const handle = db();
    const claim = handle.transaction(() => {
      const rows = handle.prepare(`
        SELECT * FROM ${t}
         WHERE conversation_id = ?
           AND ((status IN (?, ?) AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
             OR (status = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
         ORDER BY id ASC LIMIT ?
      `).all(cid, S.QUEUED, S.ATTACHED, nowIso, S.PROCESSING, nowIso, max);
      if (!rows.length) return [];
      let touched = false;
      for (const row of rows) {
        if (row.status !== S.QUEUED) continue;
        const message = handle.prepare("INSERT INTO messages (conversation_id, author, content, usage_json, created_at) VALUES (?, 'user', ?, NULL, ?)").run(cid, row.body, nowIso);
        handle.prepare(`UPDATE ${t} SET status = ?, message_id = ?, updated_at = ?, next_attempt_at = NULL WHERE id = ? AND status = ?`)
          .run(S.ATTACHED, Number(message.lastInsertRowid), nowIso, row.id, S.QUEUED);
        touched = true;
      }
      if (touched) handle.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(nowIso, cid);
      const ids = rows.map((row) => Number(row.id));
      const updated = handle.prepare(`
        UPDATE ${t}
           SET status = ?, attempt_count = attempt_count + 1, next_attempt_at = NULL, last_error = NULL,
               lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE conversation_id = ? AND id IN (${ids.map(() => "?").join(", ")})
           AND (status IN (?, ?) OR (status = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
      `).run(S.PROCESSING, leaseToken, leaseExpiresAt, nowIso, cid, ...ids, S.QUEUED, S.ATTACHED, S.PROCESSING, nowIso);
      // The immediate transaction holds the write lock from selection onward; any mismatch means
      // ownership is not exclusive, so roll back rather than start a turn.
      if (Number(updated.changes || 0) !== ids.length) throw new Error("handoff claim changed before it could be leased");
      const claimed = handle.prepare(`SELECT * FROM ${t} WHERE conversation_id = ? AND lease_token = ? AND id IN (${ids.map(() => "?").join(", ")})`).all(cid, leaseToken, ...ids);
      const byId = new Map(claimed.map((row) => [Number(row.id), normalize(row)]));
      return ids.map((id) => byId.get(id)).filter(Boolean);
    });
    return claim.immediate();
  }

  function completeHandoffBatch({ conversationId, handoffIds, leaseToken } = {}) {
    return updateBatch({ conversationId, handoffIds, leaseToken, status: S.COMPLETED, completedAt: new Date().toISOString() });
  }

  function retryHandoffBatch({ conversationId, handoffIds, leaseToken, error = "", delayMs = 30000, now = new Date() } = {}) {
    const startedAt = timestamp(now);
    const retryAt = new Date(Date.parse(startedAt) + Math.max(0, Number(delayMs) || 0)).toISOString();
    return updateBatch({ conversationId, handoffIds, leaseToken, status: S.ATTACHED, nextAttemptAt: retryAt, lastError: String(error || "").slice(0, 2000) });
  }

  // A worker renews the exact claim it owns before the lease expires; a stale worker gets 0 and
  // must not complete, retry, or post a response for a batch another process reclaimed.
  function renewHandoffBatch({ conversationId, handoffIds, leaseToken, now = new Date(), leaseMs: lease = leaseMs } = {}) {
    const cid = Number(conversationId);
    const ids = normalizeIds(handoffIds);
    const token = normalizeToken(leaseToken);
    if (!Number.isInteger(cid) || cid <= 0 || !ids.length || !token) return 0;
    const nowIso = timestamp(now);
    const expiresAt = new Date(Date.parse(nowIso) + normalizeLeaseMs(lease)).toISOString();
    const info = db().prepare(`
      UPDATE ${t} SET lease_expires_at = ?, updated_at = ?
       WHERE conversation_id = ? AND status = ? AND lease_token = ? AND id IN (${ids.map(() => "?").join(", ")})
    `).run(expiresAt, nowIso, cid, S.PROCESSING, token, ...ids);
    return Number(info.changes || 0);
  }

  // Process-start recovery: conversations with claimable work. Processing rows appear only once
  // their lease expired; their messages are already attached, so a reclaim never duplicates input.
  function listPendingHandoffConversations({ now = new Date(), limit = 100 } = {}) {
    const nowIso = timestamp(now);
    const max = Math.max(1, Math.min(500, Math.floor(Number(limit)) || 100));
    return db().prepare(`
      SELECT target_root, conversation_id, task_key, MIN(id) AS first_id FROM ${t}
       WHERE ((status IN (?, ?) AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))
       GROUP BY target_root, conversation_id, task_key ORDER BY first_id ASC LIMIT ?
    `).all(S.QUEUED, S.ATTACHED, nowIso, S.PROCESSING, nowIso, max)
      .map((row) => ({ targetRoot: row.target_root, conversationId: Number(row.conversation_id), taskKey: row.task_key, firstId: Number(row.first_id) }));
  }

  function updateBatch({ conversationId, handoffIds, leaseToken, status, nextAttemptAt = null, lastError = null, completedAt = null }) {
    const cid = Number(conversationId);
    const ids = normalizeIds(handoffIds);
    const token = normalizeToken(leaseToken);
    if (!Number.isInteger(cid) || cid <= 0 || !ids.length || !token) return 0;
    const info = db().prepare(`
      UPDATE ${t}
         SET status = ?, next_attempt_at = ?, last_error = ?, completed_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE conversation_id = ? AND status = ? AND lease_token = ? AND id IN (${ids.map(() => "?").join(", ")})
    `).run(String(status || S.ATTACHED), nextAttemptAt, lastError, completedAt, new Date().toISOString(), cid, S.PROCESSING, token, ...ids);
    return Number(info.changes || 0);
  }

  return { enqueueHandoff, getHandoff, listHandoffs, claimHandoffBatch, completeHandoffBatch, retryHandoffBatch, renewHandoffBatch, listPendingHandoffConversations, table: t };
}

function tableName(value) {
  const name = String(value || "").trim();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error(`invalid handoff table name: ${value}`);
  return name;
}

function normalize(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    targetRoot: row.target_root,
    conversationId: Number(row.conversation_id),
    taskKey: row.task_key,
    externalId: row.external_id || null,
    fromRole: row.from_role || null,
    body: row.body || "",
    status: row.status,
    messageId: row.message_id == null ? null : Number(row.message_id),
    attemptCount: Number(row.attempt_count || 0),
    nextAttemptAt: row.next_attempt_at || null,
    lastError: row.last_error || "",
    leaseToken: row.lease_token || null,
    leaseExpiresAt: row.lease_expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null
  };
}

function timestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function normalizeLeaseMs(value) {
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < MIN_LEASE_MS || ms > MAX_LEASE_MS) throw new Error("handoff lease must be between 1 second and 1 hour");
  return ms;
}

function normalizeIds(values) {
  return [...new Set((values || []).map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))];
}

function normalizeToken(value) {
  const token = String(value || "").trim();
  return token && token.length <= 200 ? token : "";
}

function normalizeRoot(value) {
  const text = String(value || "").trim();
  return text ? path.resolve(text) : "";
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (role && !/^[a-z][a-z0-9-]{0,79}$/.test(role)) throw new Error("fromRole must be a lowercase role slug");
  return role;
}
