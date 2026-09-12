import Database from "better-sqlite3";
import crypto from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

import { redactIntegrationText, safeMetadata } from "@medhus-ai/crewrun-plugin-sdk";
import { crewHome } from "medhus-crewrun/crew-dirs";
import { workspaceIdentity } from "medhus-crewrun/workspace-manifest";

const json = (value) => JSON.stringify(value ?? {});
const parse = (value, fallback = null) => {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
};
const CONNECTION_ID = /^[a-z][a-z0-9-]{0,63}-[a-z0-9][a-z0-9-]{0,63}$/;
const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const EVENT_ID = /^[A-Za-z0-9_.:@/-]{1,512}$/;

export function integrationStatePath(targetRoot, env = process.env) {
  const id = crypto.createHash("sha256").update(workspaceIdentity(targetRoot)).digest("hex").slice(0, 24);
  return path.join(crewHome(env), "integrations", id, "state.sqlite");
}

// The reference host needs unattended refresh-token access, unlike the interactive
// password-backed runner secret store. Its caller supplies a host-owned master key
// (normally from a service manager secret). Metadata stays plaintext for safe status
// reporting; credentials, PKCE verifiers, and provider channel secrets are encrypted.
export function createIntegrationState({ targetRoot, vaultKey, env = process.env, now = Date.now } = {}) {
  if (!targetRoot) throw new Error("createIntegrationState requires targetRoot");
  const key = encryptionKey(vaultKey);
  const file = integrationStatePath(targetRoot, env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);
  const db = new Database(file);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_app_config (
      plugin_id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS integration_connection_checks (
      connection_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, checked_at INTEGER NOT NULL,
      PRIMARY KEY(connection_id,kind)
    );
    CREATE TABLE IF NOT EXISTS integration_connections (
      id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, status TEXT NOT NULL,
      account TEXT NOT NULL DEFAULT '{}', scopes TEXT NOT NULL DEFAULT '[]',
      capabilities TEXT NOT NULL DEFAULT '[]', revision TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, disconnected_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS integration_credentials (
      connection_id TEXT PRIMARY KEY REFERENCES integration_connections(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS integration_oauth_states (
      state_hash TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, capabilities TEXT NOT NULL,
      return_path TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, consumed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS integration_subscriptions (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
      provider_key TEXT NOT NULL, resource TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
      secret TEXT, expires_at INTEGER, status TEXT NOT NULL DEFAULT 'active', updated_at INTEGER NOT NULL,
      UNIQUE(connection_id, provider_key, resource)
    );
    -- A lease is deliberately keyed by the stable local subscription identity rather than the
    -- provider subscription id: providers may rotate that id during renewal.
    CREATE TABLE IF NOT EXISTS integration_subscription_leases (
      connection_id TEXT NOT NULL, provider_key TEXT NOT NULL, resource TEXT NOT NULL,
      lease_id TEXT NOT NULL, leased_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(connection_id, provider_key, resource)
    );
    -- A replacement lease covers the small window from a successful OAuth exchange through
    -- provider subscription setup and retirement of the old local credential. It is keyed by
    -- provider, rather than account metadata, because this one-owner reference host keeps one
    -- current connection per provider.
    CREATE TABLE IF NOT EXISTS integration_connection_leases (
      plugin_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL,
      leased_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS integration_events (
      id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
      provider_event_id TEXT NOT NULL, type TEXT NOT NULL, resource TEXT NOT NULL DEFAULT '{}',
      summary TEXT NOT NULL DEFAULT '{}', payload_digest TEXT NOT NULL, occurred_at INTEGER,
      received_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'received', error TEXT,
      UNIQUE(connection_id, provider_event_id)
    );
    CREATE TABLE IF NOT EXISTS integration_event_routes (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL, role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(connection_id, event_type, role)
    );
    CREATE INDEX IF NOT EXISTS integration_events_received ON integration_events(received_at DESC);
    CREATE INDEX IF NOT EXISTS integration_subscriptions_due ON integration_subscriptions(status, expires_at);
    CREATE INDEX IF NOT EXISTS integration_subscription_leases_expiry ON integration_subscription_leases(expires_at);
    CREATE INDEX IF NOT EXISTS integration_connection_leases_expiry ON integration_connection_leases(expires_at);
  `);
  const transaction = (fn) => db.transaction(fn).immediate();

  function getAppConfig(pluginId) {
    assertPlugin(pluginId);
    const row = db.prepare("SELECT ciphertext FROM integration_app_config WHERE plugin_id=?").get(pluginId);
    return row ? open(row.ciphertext, key, encryptionContext("app-config", pluginId)) : {};
  }

  function connectionCheck(connectionId, kind, status) {
    assertConnection(connectionId);
    if (status != null) {
      if (!["healthy", "check failed", "setup started", "setup complete", "setup failed"].includes(status)) throw new Error("Invalid account check status.");
      db.prepare("INSERT INTO integration_connection_checks VALUES (?,?,?,?) ON CONFLICT(connection_id,kind) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at")
        .run(connectionId, kind, status, now());
    }
    const row = db.prepare("SELECT status,checked_at FROM integration_connection_checks WHERE connection_id=? AND kind=?").get(connectionId, kind);
    return row ? { status: row.status, checkedAt: row.checked_at } : { status: "not checked", checkedAt: null };
  }

  function saveAppConfig(pluginId, patch) {
    assertPlugin(pluginId);
    return transaction(() => {
      const config = { ...getAppConfig(pluginId), ...patch };
      db.prepare("INSERT INTO integration_app_config VALUES (?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at")
        .run(pluginId, seal(config, key, encryptionContext("app-config", pluginId)), now());
      db.prepare("DELETE FROM integration_oauth_states WHERE plugin_id=?").run(pluginId);
    });
  }

  function issueOAuthState({ pluginId, capabilities = [], returnPath = "/integrations", verifier, ttlMs = 10 * 60_000 } = {}) {
    assertPlugin(pluginId);
    if (!verifier || typeof verifier !== "string") throw new Error("OAuth PKCE verifier is required");
    const state = crypto.randomBytes(32).toString("base64url");
    const createdAt = now();
    const stateHash = hash(state);
    db.prepare("INSERT INTO integration_oauth_states VALUES (?,?,?,?,?,?,?,NULL)").run(
      stateHash, pluginId, json(normalizeTextList(capabilities)), safePath(returnPath), seal(verifier, key, encryptionContext("oauth-state", stateHash)), createdAt + boundedTtl(ttlMs), createdAt
    );
    return state;
  }

  // A callback gets exactly one chance to consume its state. Expired states are never
  // returned to a caller, which prevents callback replay and stale browser tabs from
  // attaching credentials to a later connection.
  function consumeOAuthState(state, expected = {}) {
    const stateHash = hash(String(state || ""));
    const expectedPluginId = String(typeof expected === "string" ? expected : expected?.pluginId || "").trim();
    if (expectedPluginId) assertPlugin(expectedPluginId);
    return transaction(() => {
      // Bind the browser state to the callback route inside the same immediate transaction that
      // marks it consumed. A Slack state sent to a Google callback therefore remains usable at
      // its legitimate callback instead of becoming an attacker-triggered denial of service.
      const row = expectedPluginId
        ? db.prepare("SELECT * FROM integration_oauth_states WHERE state_hash=? AND plugin_id=?").get(stateHash, expectedPluginId)
        : db.prepare("SELECT * FROM integration_oauth_states WHERE state_hash=?").get(stateHash);
      if (!row || row.consumed_at || row.expires_at <= now()) return null;
      const consumed = db.prepare("UPDATE integration_oauth_states SET consumed_at=? WHERE state_hash=? AND plugin_id=? AND consumed_at IS NULL AND expires_at>?")
        .run(now(), stateHash, expectedPluginId || row.plugin_id, now());
      if (consumed.changes !== 1) return null;
      return {
        pluginId: row.plugin_id,
        capabilities: parse(row.capabilities, []),
        returnPath: row.return_path,
        verifier: open(row.verifier, key, encryptionContext("oauth-state", row.state_hash))
      };
    });
  }

  function purgeExpiredOAuthStates() {
    return db.prepare("DELETE FROM integration_oauth_states WHERE expires_at<=? OR (consumed_at IS NOT NULL AND consumed_at<?)")
      .run(now(), now() - 86_400_000).changes;
  }

  function saveConnection({ id, pluginId, status = "connected", account = {}, scopes = [], capabilities = [], credentials = null } = {}) {
    const connectionId = id || `${String(pluginId || "").trim()}-${crypto.randomUUID()}`;
    assertConnection(connectionId);
    assertPlugin(pluginId);
    const at = now();
    const revision = crypto.randomUUID();
    transaction(() => {
      db.prepare(`INSERT INTO integration_connections (id,plugin_id,status,account,scopes,capabilities,revision,created_at,updated_at,disconnected_at)
        VALUES (?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(id) DO UPDATE SET plugin_id=excluded.plugin_id,status=excluded.status,account=excluded.account,
          scopes=excluded.scopes,capabilities=excluded.capabilities,revision=excluded.revision,updated_at=excluded.updated_at,disconnected_at=NULL`)
        .run(connectionId, pluginId, connectionStatus(status), json(publicAccount(account)), json(normalizeTextList(scopes)), json(normalizeTextList(capabilities)), revision, at, at);
      if (credentials !== null) {
        db.prepare("INSERT INTO integration_credentials VALUES (?,?,?) ON CONFLICT(connection_id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at")
          .run(connectionId, seal(credentials, key, encryptionContext("connection-credentials", connectionId)), at);
      }
    });
    return getConnection(connectionId);
  }

  function getConnection(id, { credentials = false } = {}) {
    const row = db.prepare("SELECT * FROM integration_connections WHERE id=?").get(String(id || ""));
    if (!row) return null;
    const value = publicConnection(row);
    if (credentials) {
      const secret = db.prepare("SELECT ciphertext FROM integration_credentials WHERE connection_id=?").get(row.id)?.ciphertext;
      value.credentials = secret ? open(secret, key, encryptionContext("connection-credentials", row.id)) : null;
    }
    return value;
  }

  function listConnections() {
    return db.prepare("SELECT * FROM integration_connections ORDER BY created_at DESC,id DESC").all().map(publicConnection);
  }

  function findConnections({ pluginId = "", accountId = "" } = {}) {
    const rows = pluginId
      ? db.prepare("SELECT * FROM integration_connections WHERE plugin_id=? AND status='connected' ORDER BY created_at DESC,id DESC").all(pluginId)
      : db.prepare("SELECT * FROM integration_connections WHERE status='connected' ORDER BY created_at DESC,id DESC").all();
    const expected = String(accountId || "").trim();
    const expectedEmail = expected.toLowerCase();
    // Provider callbacks commonly identify an account with its provider id (Slack team id),
    // while Gmail Pub/Sub identifies the mailbox by email. Both are safe, explicit account
    // metadata saved at OAuth connection time; labels and arbitrary event fields never match.
    return rows.map(publicConnection).filter((connection) => !expected
      || String(connection.account?.id || "") === expected
      || String(connection.account?.email || "").trim().toLowerCase() === expectedEmail);
  }

  function disconnectConnection(id) {
    const connection = getConnection(id, { credentials: true });
    if (!connection) return null;
    transaction(() => {
      db.prepare("DELETE FROM integration_credentials WHERE connection_id=?").run(connection.id);
      db.prepare("UPDATE integration_connections SET status='disconnected',revision=?,updated_at=?,disconnected_at=? WHERE id=?")
        .run(crypto.randomUUID(), now(), now(), connection.id);
      db.prepare("UPDATE integration_subscriptions SET status='stopped',secret=NULL,updated_at=? WHERE connection_id=?").run(now(), connection.id);
      db.prepare("DELETE FROM integration_subscription_leases WHERE connection_id=?").run(connection.id);
    });
    return connection;
  }

  // Claim a provider-wide replacement lease before persisting a newly authorized connection.
  // SQLite's immediate transaction makes this work across separate reference-host processes,
  // while expiry makes an interrupted callback recoverable without a manual database repair.
  function claimConnectionLease({ pluginId, leaseMs = 5 * 60_000 } = {}) {
    assertPlugin(pluginId);
    const at = now();
    const leaseId = crypto.randomUUID();
    const expiresAt = at + boundedLease(leaseMs);
    return transaction(() => {
      db.prepare("DELETE FROM integration_connection_leases WHERE plugin_id=? AND expires_at<=?").run(pluginId, at);
      const result = db.prepare(`INSERT INTO integration_connection_leases (plugin_id,lease_id,leased_at,expires_at)
        VALUES (?,?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET
        lease_id=excluded.lease_id,leased_at=excluded.leased_at,expires_at=excluded.expires_at
        WHERE integration_connection_leases.expires_at<=excluded.leased_at`)
        .run(pluginId, leaseId, at, expiresAt);
      return result.changes === 1 ? { pluginId, leaseId, expiresAt } : null;
    });
  }

  function releaseConnectionLease({ pluginId, leaseId } = {}) {
    if (!pluginId || !leaseId) return false;
    assertPlugin(pluginId);
    return db.prepare("DELETE FROM integration_connection_leases WHERE plugin_id=? AND lease_id=?")
      .run(String(pluginId), String(leaseId)).changes === 1;
  }

  function upsertSubscription({ id, connectionId, providerKey, resource, metadata = {}, secret = null, expiresAt = null, status = "active" } = {}) {
    assertConnection(connectionId);
    if (!id || !EVENT_ID.test(String(id))) throw new Error("subscription id is invalid");
    if (!providerKey || !EVENT_ID.test(String(providerKey))) throw new Error("subscription provider key is invalid");
    const at = now();
    const resourceJson = json(safeMetadata(safeObject(resource)));
    transaction(() => {
      db.prepare(`INSERT INTO integration_subscriptions (id,connection_id,provider_key,resource,metadata,secret,expires_at,status,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,provider_key,resource) DO UPDATE SET
        id=excluded.id,metadata=excluded.metadata,secret=excluded.secret,expires_at=excluded.expires_at,status=excluded.status,updated_at=excluded.updated_at`)
        .run(String(id), connectionId, String(providerKey), resourceJson, json(safeMetadata(safeObject(metadata))), secret == null ? null : seal(secret, key, encryptionContext("subscription-secret", `${connectionId}:${id}`)), numberOrNull(expiresAt), subscriptionStatus(status), at);
      // A successful subscribe/renewal has replaced this local record. It is no longer due, so
      // remove a prior claim in the same transaction before another host can inspect it.
      db.prepare("DELETE FROM integration_subscription_leases WHERE connection_id=? AND provider_key=? AND resource=?")
        .run(connectionId, String(providerKey), resourceJson);
    });
    return getSubscription(connectionId, providerKey, resource);
  }

  function getSubscription(connectionId, providerKey, resource) {
    const row = db.prepare("SELECT * FROM integration_subscriptions WHERE connection_id=? AND provider_key=? AND resource=?")
      .get(connectionId, providerKey, json(safeObject(resource)));
    return row ? publicSubscription(row) : null;
  }

  // This is intentionally the only subscription-secret lookup. It is available to a
  // provider verifier inside the host process (for example Microsoft Graph's
  // `clientState` comparison), but the public subscription projection never includes it.
  function subscriptionSecretById(id) {
    const row = db.prepare("SELECT id,connection_id,secret FROM integration_subscriptions WHERE id=?").get(String(id || ""));
    return row?.secret ? open(row.secret, key, encryptionContext("subscription-secret", `${row.connection_id}:${row.id}`)) : null;
  }

  function getSubscriptionSecret({ provider = "", subscriptionId = "", connectionId = "" } = {}) {
    const row = db.prepare(`SELECT subscription.id, subscription.secret, subscription.connection_id, connection.plugin_id
      FROM integration_subscriptions AS subscription
      JOIN integration_connections AS connection ON connection.id=subscription.connection_id
      WHERE subscription.id=?`).get(String(subscriptionId || ""));
    if (!row || (connectionId && row.connection_id !== String(connectionId)) || (provider && row.plugin_id !== String(provider))) return null;
    return row.secret ? open(row.secret, key, encryptionContext("subscription-secret", `${row.connection_id}:${row.id}`)) : null;
  }

  function listSubscriptions({ connectionId = "" } = {}) {
    const rows = connectionId
      ? db.prepare("SELECT * FROM integration_subscriptions WHERE connection_id=? ORDER BY updated_at DESC,id").all(String(connectionId))
      : db.prepare("SELECT * FROM integration_subscriptions ORDER BY updated_at DESC,id").all();
    return rows.map(publicSubscription);
  }

  function subscriptionsDue(withinMs = 15 * 60_000) {
    return db.prepare("SELECT * FROM integration_subscriptions WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at,id")
      .all(now() + Math.max(0, Number(withinMs) || 0)).map(privateSubscription);
  }

  // Claim before calling a provider. This makes renewal safe across overlapping host ticks and
  // multiple reference-host processes sharing the encrypted SQLite state. The short lease is
  // intentionally only a work claim; a successful renewal clears it atomically with the new
  // subscription record, while a crash becomes retryable after expiry.
  function claimSubscriptionsDue({ withinMs = 15 * 60_000, leaseMs = 5 * 60_000 } = {}) {
    const claimedAt = now();
    const dueAt = claimedAt + Math.max(0, Number(withinMs) || 0);
    const leaseUntil = claimedAt + boundedLease(leaseMs);
    return transaction(() => {
      db.prepare("DELETE FROM integration_subscription_leases WHERE expires_at<=?").run(claimedAt);
      const due = db.prepare("SELECT * FROM integration_subscriptions WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at,id")
        .all(dueAt);
      const claim = db.prepare(`INSERT INTO integration_subscription_leases (connection_id,provider_key,resource,lease_id,leased_at,expires_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(connection_id,provider_key,resource) DO UPDATE SET
        lease_id=excluded.lease_id,leased_at=excluded.leased_at,expires_at=excluded.expires_at
        WHERE integration_subscription_leases.expires_at<=excluded.leased_at`);
      return due.flatMap((row) => {
        const leaseId = crypto.randomUUID();
        const result = claim.run(row.connection_id, row.provider_key, row.resource, leaseId, claimedAt, leaseUntil);
        return result.changes === 1 ? [{ leaseId, subscription: privateSubscription(row) }] : [];
      });
    });
  }

  function releaseSubscriptionLease({ connectionId, providerKey, resource, leaseId } = {}) {
    if (!connectionId || !providerKey || !leaseId) return false;
    return db.prepare("DELETE FROM integration_subscription_leases WHERE connection_id=? AND provider_key=? AND resource=? AND lease_id=?")
      .run(String(connectionId), String(providerKey), json(safeMetadata(safeObject(resource))), String(leaseId)).changes === 1;
  }

  function privateSubscription(row) {
    return {
      ...publicSubscription(row),
      secret: row.secret ? open(row.secret, key, encryptionContext("subscription-secret", `${row.connection_id}:${row.id}`)) : null
    };
  }

  function ingestEvent({ connectionId, providerEventId, type, resource = {}, summary = {}, rawPayload = "", occurredAt = null } = {}) {
    assertConnection(connectionId);
    if (!providerEventId || !EVENT_ID.test(String(providerEventId))) throw new Error("provider event id is invalid");
    if (!type || !EVENT_ID.test(String(type))) throw new Error("event type is invalid");
    const digest = hash(typeof rawPayload === "string" ? rawPayload : json(rawPayload));
    const inserted = db.prepare(`INSERT OR IGNORE INTO integration_events
      (connection_id,provider_event_id,type,resource,summary,payload_digest,occurred_at,received_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(connectionId, String(providerEventId), String(type), json(safeMetadata(safeObject(resource))), json(safeMetadata(safeObject(summary))), digest, numberOrNull(occurredAt), now());
    const row = db.prepare("SELECT * FROM integration_events WHERE connection_id=? AND provider_event_id=?").get(connectionId, String(providerEventId));
    return { created: inserted.changes === 1, event: publicEvent(row) };
  }

  function listEvents({ limit = 100, status = "" } = {}) {
    const size = Math.max(1, Math.min(500, Number(limit) || 100));
    const wanted = ["received", "routed", "ignored", "failed"].includes(String(status)) ? String(status) : "";
    const statement = wanted
      ? db.prepare("SELECT * FROM integration_events WHERE status=? ORDER BY received_at DESC,id DESC LIMIT ?")
      : db.prepare("SELECT * FROM integration_events ORDER BY received_at DESC,id DESC LIMIT ?");
    return (wanted ? statement.all(wanted, size) : statement.all(size)).map(publicEvent);
  }

  function markEvent(id, { status, error = "" } = {}) {
    const safeStatus = ["received", "routed", "ignored", "failed"].includes(status) ? status : "failed";
    db.prepare("UPDATE integration_events SET status=?,error=? WHERE id=?").run(safeStatus, redactIntegrationText(error, 1_000), Number(id));
    return db.prepare("SELECT * FROM integration_events WHERE id=?").get(Number(id));
  }

  function upsertRoute({ id = crypto.randomUUID(), connectionId, eventType, role, enabled = false } = {}) {
    assertConnection(connectionId);
    if (!eventType || !EVENT_ID.test(String(eventType))) throw new Error("event type is invalid");
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(String(role || ""))) throw new Error("role is invalid");
    const at = now();
    db.prepare(`INSERT INTO integration_event_routes (id,connection_id,event_type,role,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(connection_id,event_type,role) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`)
      .run(String(id), connectionId, String(eventType), String(role), enabled ? 1 : 0, at, at);
    return listRoutes({ connectionId, eventType, role })[0] || null;
  }

  function listRoutes({ connectionId = "", eventType = "", role = "" } = {}) {
    let query = "SELECT * FROM integration_event_routes WHERE 1=1";
    const values = [];
    if (connectionId) { query += " AND connection_id=?"; values.push(connectionId); }
    if (eventType) { query += " AND event_type=?"; values.push(eventType); }
    if (role) { query += " AND role=?"; values.push(role); }
    query += " ORDER BY created_at,id";
    return db.prepare(query).all(...values).map((row) => ({ id: row.id, connectionId: row.connection_id, eventType: row.event_type, role: row.role, enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  function close() { db.close(); }
  return {
    db, file, getAppConfig, saveAppConfig, accountCheck: (id, status) => connectionCheck(id, "account", status), eventSetup: (id, status) => connectionCheck(id, "events", status), issueOAuthState, consumeOAuthState, purgeExpiredOAuthStates,
    saveConnection, getConnection, listConnections, findConnections, disconnectConnection,
    claimConnectionLease, releaseConnectionLease,
    upsertSubscription, getSubscription, subscriptionSecretById, getSubscriptionSecret, listSubscriptions, subscriptionsDue, claimSubscriptionsDue, releaseSubscriptionLease,
    ingestEvent, listEvents, markEvent, upsertRoute, listRoutes, close
  };
}

function publicConnection(row) {
  return {
    id: row.id, plugin: row.plugin_id, status: row.status, account: publicAccount(parse(row.account, {})),
    scopes: parse(row.scopes, []), capabilities: parse(row.capabilities, []), revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at, disconnectedAt: row.disconnected_at || null
  };
}

function publicSubscription(row) {
  return { id: row.id, connectionId: row.connection_id, providerKey: row.provider_key, resource: parse(row.resource, {}), metadata: parse(row.metadata, {}), expiresAt: row.expires_at, status: row.status, updatedAt: row.updated_at };
}

function publicEvent(row) {
  return { id: row.id, connectionId: row.connection_id, providerEventId: row.provider_event_id, type: row.type, resource: parse(row.resource, {}), summary: parse(row.summary, {}), occurredAt: row.occurred_at, receivedAt: row.received_at, status: row.status, error: row.error || "" };
}

function encryptionKey(value) {
  const input = String(value || "").trim();
  if (input.length < 16) throw new Error("CREWRUN_INTEGRATIONS_KEY must be set to a strong host secret");
  try {
    const decoded = Buffer.from(input, "base64url");
    if (decoded.length === 32) return decoded;
  } catch { /* hash the opaque secret below */ }
  return crypto.createHash("sha256").update(input).digest();
}

function seal(value, key, context) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(requiredEncryptionContext(context), "utf8"));
  const plaintext = Buffer.from(typeof value === "string" ? value : json(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return json({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
}

function open(blob, key, context) {
  const value = parse(blob, {});
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from(requiredEncryptionContext(context), "utf8"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
    return parse(plaintext, plaintext);
  } catch {
    throw new Error("could not decrypt integration credential state");
  }
}

function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("base64url"); }
function encryptionContext(kind, identity) { return `crewrun.integration-state/v1:${kind}:${String(identity || "")}`; }
function requiredEncryptionContext(value) {
  const context = String(value || "");
  if (!context.startsWith("crewrun.integration-state/v1:") || context.length > 1_024) throw new Error("integration encryption context is invalid");
  return context;
}
function assertPlugin(value) { if (!PLUGIN_ID.test(String(value || ""))) throw new Error("integration plugin id is invalid"); }
function assertConnection(value) { if (!CONNECTION_ID.test(String(value || ""))) throw new Error("integration connection id is invalid"); }
function safePath(value) { return /^\/(?!\/)/.test(String(value || "")) ? String(value) : "/connectors"; }
function normalizeTextList(value) { return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean))]; }
function safeObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function publicAccount(value) {
  const source = safeObject(value);
  const id = accountText(source.id, 256);
  const label = accountText(source.label, 256);
  const email = accountText(source.email, 320);
  return { ...(id ? { id } : {}), ...(label ? { label } : {}), ...(email ? { email } : {}) };
}
function accountText(value, maximum) {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, maximum) : "";
  return /^(?!.*(?:token|secret|password|bearer))[A-Za-z0-9@._:/+()' -]+$/i.test(text) ? text : "";
}
function numberOrNull(value) { const number = Number(value); return Number.isFinite(number) ? Math.trunc(number) : null; }
function boundedTtl(value) { return Math.max(60_000, Math.min(3_600_000, Number(value) || 600_000)); }
function boundedLease(value) { return Math.max(60_000, Math.min(15 * 60_000, Number(value) || 5 * 60_000)); }
function connectionStatus(value) { return ["connected", "needs_reconnect", "revoked", "disconnected"].includes(value) ? value : "connected"; }
function subscriptionStatus(value) { return ["active", "stopped", "failed"].includes(value) ? value : "active"; }
