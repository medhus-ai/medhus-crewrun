import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIntegrationState } from "../packages/crewrun-reference-host/src/state.js";

const VAULT_KEY = "test-only-integration-vault-key-that-is-long-enough";

async function temporaryState(t, { now = Date.now } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-reference-host-state-"));
  const env = { CREW_HOME: path.join(root, "crew-home") };
  const state = createIntegrationState({ targetRoot: root, vaultKey: VAULT_KEY, env, now });
  let closed = false;
  const close = () => {
    if (!closed) {
      state.close();
      closed = true;
    }
  };
  t.after(async () => {
    close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, env, state, close };
}

test("integration state encrypts credentials and exposes only whitelisted connection metadata", async (t) => {
  const { state } = await temporaryState(t);
  const accessToken = "access-token-never-written-in-cleartext";
  const refreshToken = "refresh-token-never-written-in-cleartext";
  const connection = state.saveConnection({
    id: "slack-safe",
    pluginId: "slack",
    account: {
      id: "T_TEST",
      label: "Test workspace",
      email: "owner@example.test",
      accessToken,
      nested: { secret: "must-never-be-public" }
    },
    scopes: ["chat:write"],
    capabilities: ["messages"],
    credentials: { accessToken, refreshToken, providerOnly: { secret: "nested-provider-secret" } }
  });

  assert.deepEqual(connection.account, {
    id: "T_TEST",
    label: "Test workspace",
    email: "owner@example.test"
  });
  assert.equal("credentials" in connection, false);
  const publicJson = JSON.stringify(state.listConnections());
  assert.equal(publicJson.includes(accessToken), false);
  assert.equal(publicJson.includes(refreshToken), false);
  assert.equal(publicJson.includes("nested-provider-secret"), false);

  assert.deepEqual(state.getConnection("slack-safe", { credentials: true }).credentials, {
    accessToken,
    refreshToken,
    providerOnly: { secret: "nested-provider-secret" }
  });
  const onDisk = await readFile(state.file, "utf8");
  assert.equal(onDisk.includes(accessToken), false);
  assert.equal(onDisk.includes(refreshToken), false);
  assert.equal(onDisk.includes("nested-provider-secret"), false);
});

test("OAuth state is encrypted, bound to its callback provider, expires, and can be consumed exactly once", async (t) => {
  let clock = Date.parse("2026-09-01T12:00:00.000Z");
  const { state } = await temporaryState(t, { now: () => clock });
  const verifier = "pkce-verifier-that-must-not-be-in-the-database";
  const stateValue = state.issueOAuthState({
    pluginId: "slack",
    capabilities: ["messages", "mentions"],
    returnPath: "/connectors",
    verifier
  });

  const beforeConsume = await readFile(state.file, "utf8");
  assert.equal(beforeConsume.includes(verifier), false, "the PKCE verifier is encrypted at rest");
  assert.equal(beforeConsume.includes(stateValue), false, "the browser state value is stored as a hash");
  assert.equal(
    state.consumeOAuthState(stateValue, { pluginId: "google-workspace" }),
    null,
    "a callback for another provider cannot consume this state"
  );
  assert.deepEqual(state.consumeOAuthState(stateValue), {
    pluginId: "slack",
    capabilities: ["messages", "mentions"],
    returnPath: "/connectors",
    verifier
  });
  assert.equal(state.consumeOAuthState(stateValue), null, "a replay cannot attach another connection");

  const expired = state.issueOAuthState({ pluginId: "slack", verifier: "another-pkce-verifier", ttlMs: 60_000 });
  clock += 60_001;
  assert.equal(state.consumeOAuthState(expired), null, "expired browser state cannot be reused");
});

test("encrypted records are bound to their table identity", async (t) => {
  const { state } = await temporaryState(t);
  state.saveConnection({ id: "slack-first", pluginId: "slack", credentials: { accessToken: "first-private-token" } });
  state.saveConnection({ id: "slack-second", pluginId: "slack", credentials: { accessToken: "second-private-token" } });
  const first = state.db.prepare("SELECT ciphertext FROM integration_credentials WHERE connection_id=?").get("slack-first");
  state.db.prepare("UPDATE integration_credentials SET ciphertext=? WHERE connection_id=?").run(first.ciphertext, "slack-second");
  assert.throws(
    () => state.getConnection("slack-second", { credentials: true }),
    /could not decrypt integration credential state/,
    "a ciphertext copied to another connection cannot become that connection's credential"
  );
});

test("subscription renewal claims are atomic across reference-host state handles", async (t) => {
  let clock = Date.parse("2026-09-08T12:00:00.000Z");
  const { root, env, state } = await temporaryState(t, { now: () => clock });
  const second = createIntegrationState({ targetRoot: root, vaultKey: VAULT_KEY, env, now: () => clock });
  t.after(() => second.close());
  state.saveConnection({ id: "slack-main", pluginId: "slack", credentials: { accessToken: "private-token" } });
  state.upsertSubscription({
    id: "renewal-1", connectionId: "slack-main", providerKey: "slack.events",
    resource: { channel: "C1" }, expiresAt: clock + 1_000, status: "active"
  });

  const firstClaim = state.claimSubscriptionsDue({ withinMs: 5_000 });
  assert.equal(firstClaim.length, 1);
  assert.equal(second.claimSubscriptionsDue({ withinMs: 5_000 }).length, 0, "a second host cannot renew the same provider subscription concurrently");
  assert.equal(state.releaseSubscriptionLease({ ...firstClaim[0].subscription, leaseId: firstClaim[0].leaseId }), true);
  assert.equal(second.claimSubscriptionsDue({ withinMs: 5_000 }).length, 1, "a released or expired work claim becomes recoverable");
  clock += 16 * 60_000;
});

test("provider connection-replacement leases are atomic across reference-host state handles", async (t) => {
  const { root, env, state } = await temporaryState(t);
  const second = createIntegrationState({ targetRoot: root, vaultKey: VAULT_KEY, env });
  t.after(() => second.close());

  const firstLease = state.claimConnectionLease({ pluginId: "slack" });
  assert.ok(firstLease?.leaseId);
  assert.equal(
    second.claimConnectionLease({ pluginId: "slack" }),
    null,
    "a second reference-host process cannot replace the same provider connection concurrently"
  );
  assert.equal(state.releaseConnectionLease(firstLease), true);
  assert.ok(second.claimConnectionLease({ pluginId: "slack" })?.leaseId, "a released lease is recoverable by another host");
});

test("event receipts are durable, metadata-only, and deduplicated across a state reopen", async (t) => {
  const { root, env, state, close } = await temporaryState(t);
  state.saveConnection({ id: "github-safe", pluginId: "github", account: { id: "42", label: "Example repository" } });
  const rawPayload = "private-webhook-body-that-must-never-be-persisted";
  const first = state.ingestEvent({
    connectionId: "github-safe",
    providerEventId: "delivery-123",
    type: "github.pullRequestOpened",
    resource: { repository: "owner/repo", url: "https://github.example.test/owner/repo" },
    summary: { title: "Open the pull request" },
    rawPayload,
    occurredAt: Date.parse("2026-09-01T12:00:00.000Z")
  });
  assert.equal(first.created, true);
  assert.equal(state.ingestEvent({
    connectionId: "github-safe",
    providerEventId: "delivery-123",
    type: "github.pullRequestOpened",
    resource: { repository: "owner/repo" },
    summary: { title: "duplicate" },
    rawPayload: "a different body cannot create a second delivery"
  }).created, false);
  assert.equal(state.listEvents().length, 1);
  assert.equal(JSON.stringify(state.listEvents()).includes(rawPayload), false);

  close();
  const reopened = createIntegrationState({ targetRoot: root, vaultKey: VAULT_KEY, env });
  t.after(() => reopened.close());
  assert.equal(reopened.ingestEvent({
    connectionId: "github-safe",
    providerEventId: "delivery-123",
    type: "github.pullRequestOpened",
    rawPayload
  }).created, false, "the uniqueness receipt survives a process restart");
  assert.equal(reopened.listEvents().length, 1);
  assert.equal((await readFile(reopened.file, "utf8")).includes(rawPayload), false);
});

test("event inbox errors are redacted before a console snapshot can display them", async (t) => {
  const { state } = await temporaryState(t);
  state.saveConnection({ id: "slack-main", pluginId: "slack" });
  const receipt = state.ingestEvent({
    connectionId: "slack-main", providerEventId: "event-error-1", type: "slack.appMention", rawPayload: "not persisted"
  });
  state.markEvent(receipt.event.id, { status: "failed", error: "Provider rejected Authorization: Bearer abcdefghijklmnopqrstuvwxyz" });
  const event = state.listEvents()[0];
  assert.match(event.error, /\[redacted\]/);
  assert.doesNotMatch(event.error, /abcdefghijklmnopqrstuvwxyz/);
});
