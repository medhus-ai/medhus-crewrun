import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { collectModels, renderPartial } from "../src/console/pages.js";
import { upsertSchedule } from "../src/schedules.js";
import { createUp } from "../src/up.js";
import { defineIntegrationPlugin } from "../packages/crewrun-plugin-sdk/index.js";
import { createHost } from "../packages/crewrun-reference-host/index.js";
import { createIntegrationHost } from "../packages/crewrun-reference-host/src/host.js";

const PUBLIC_BASE_URL = "https://arsazmar0smars3.taila9c41d.ts.net";
const VAULT_KEY = "test-only-integration-vault-key-that-is-long-enough";

async function project(t, spec = roleSpec()) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-reference-host-runtime-"));
  const root = path.join(parent, "repo");
  const env = {
    CREW_HOME: path.join(parent, "crew-home"),
    CREWRUN_PUBLIC_BASE_URL: PUBLIC_BASE_URL,
    CREWRUN_INTEGRATIONS_KEY: VAULT_KEY
  };
  await mkdir(path.join(root, ".crew", "agents"), { recursive: true });
  await saveRole(root, spec);
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  return { root, env };
}

function roleSpec({ hooks = [], read = [], write = ["connector:fake:fake-main"], revision = 1, runner = "" } = {}) {
  return {
    title: "Operations",
    ...(runner ? { runner } : {}),
    hooks,
    contract: {
      version: 1,
      revision,
      mandate: "Operate the reviewed integration workflow.",
      authority: {
        tools: [{ name: "fake.send", impact: "external-write" }],
        data: { read, write }
      }
    }
  };
}

async function saveRole(root, spec) {
  await writeFile(path.join(root, ".crew", "agents", "ops.json"), JSON.stringify(spec, null, 2) + "\n", "utf8");
}

function createFakePlugin(calls = []) {
  return defineIntegrationPlugin({
    id: "fake",
    label: "Fake integration",
    description: "A test-only governed integration.",
    capabilities: [{ id: "messages", label: "Messages", description: "Read events and send a reviewed message.", direction: "both", scopes: ["fake.write"] }],
    actions: [{
      id: "fake.send",
      capability: "messages",
      label: "Send fake message",
      description: "A reviewed outbound fake message.",
      risk: "external-write",
      approval: "required",
      scopes: ["fake.write"],
      inputSchema: (z) => ({ text: z.string().min(1).max(240) }),
      validate: (input) => {
        const text = String(input?.text || "").trim();
        return text ? { ok: true, input: { text } } : { ok: false, error: "text is required" };
      }
    }],
    events: [{
      id: "fake.messageReceived",
      capability: "messages",
      label: "Fake message received",
      delivery: "webhook",
      retention: "metadata",
      scopes: ["fake.events"]
    }],
    adapter: {
      async invoke({ action, input, connection }) {
        calls.push({ action, input, connectionId: connection.id });
        return { result: { delivered: true } };
      },
      async verifyWebhook({ rawBody, connectionId }) {
        const suffix = String(rawBody || "delivery").replace(/[^A-Za-z0-9_.:@/-]/g, "-");
        return {
          ok: true,
          events: [{
            connectionId,
            providerEventId: `fake-${suffix || "delivery"}`,
            type: "fake.messageReceived",
            resource: { id: "thread-1", label: "Fake thread" },
            summary: { subject: "A fake event arrived" },
            occurredAt: "2026-09-08T12:00:00.000Z"
          }]
        };
      }
    }
  });
}

function createFakeHost({ root, env, calls = [], pluginConfig = {} }) {
  const host = createIntegrationHost({
    targetRoot: root,
    plugins: [createFakePlugin(calls)],
    publicBaseUrl: PUBLIC_BASE_URL,
    vaultKey: VAULT_KEY,
    env,
    pluginConfig
  });
  host.state.saveConnection({
    id: "fake-main",
    pluginId: "fake",
    account: { id: "fake-account", label: "Fake account" },
    scopes: ["fake.write"],
    capabilities: ["messages"],
    credentials: { accessToken: "fake-access-token-never-public" }
  });
  return host;
}

function webhook(host, body) {
  const request = Readable.from([Buffer.from(body)]);
  request.method = "POST";
  request.url = "/integrations/webhooks/fake/fake-main";
  request.headers = { "content-type": "application/json" };
  return new Promise((resolve, reject) => {
    const response = {
      headersSent: false,
      statusCode: 0,
      writeHead(status) { this.statusCode = status; this.headersSent = true; },
      end(responseBody = "") { resolve({ status: this.statusCode, body: String(responseBody) }); }
    };
    void host.ingress.handle(request, response).catch(reject);
  });
}

function oauthCallback(host, pluginId, stateValue, code) {
  const request = Readable.from([]);
  request.method = "GET";
  request.url = `/integrations/oauth/${encodeURIComponent(pluginId)}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(stateValue)}`;
  request.headers = {};
  return new Promise((resolve, reject) => {
    const response = {
      headersSent: false,
      statusCode: 0,
      writeHead(status) { this.statusCode = status; this.headersSent = true; },
      end(responseBody = "") { resolve({ status: this.statusCode, body: String(responseBody) }); }
    };
    void host.ingress.handle(request, response).catch(reject);
  });
}

async function settleIngress() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function queuedApproval(host) {
  return host.runtime.tools.registry.call({
    role: "ops",
    toolName: "fake.send",
    input: { text: "Reviewed outbound update" },
    context: {}
  });
}

test("reference createHost inventories the four built-in providers without leaking host secrets", async (t) => {
  const { root, env } = await project(t);
  Object.assign(env, {
    CREWRUN_SLACK_CLIENT_ID: "slack-client-id",
    CREWRUN_SLACK_CLIENT_SECRET: "slack-client-secret-never-public",
    CREWRUN_GOOGLE_CLIENT_ID: "google-client-id",
    CREWRUN_GOOGLE_CLIENT_SECRET: "google-client-secret-never-public",
    CREWRUN_MICROSOFT_CLIENT_ID: "microsoft-client-id",
    CREWRUN_MICROSOFT_CLIENT_SECRET: "microsoft-client-secret-never-public",
    CREWRUN_GITHUB_APP_ID: "12345",
    CREWRUN_GITHUB_WEBHOOK_SECRET: "github-webhook-secret-never-public",
    CREWRUN_GITHUB_PRIVATE_KEY: "github-private-key-never-public"
  });
  const host = createHost({ targetRoot: root, env });
  t.after(() => host.stop());

  const snapshot = await host.operations.getSnapshot();
  assert.deepEqual(snapshot.connectors.map((connector) => connector.id), ["slack", "google-workspace", "microsoft365", "github"]);
  assert.deepEqual(snapshot.connectors.map((connector) => connector.label), ["Slack", "Google Workspace", "Microsoft 365", "GitHub"]);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [
    "slack-client-secret-never-public",
    "google-client-secret-never-public",
    "microsoft-client-secret-never-public",
    "github-webhook-secret-never-public",
    "github-private-key-never-public"
  ]) assert.equal(serialized.includes(secret), false, `snapshot leaked ${secret}`);
});

test("the hosted console does not offer Slack or Google consent before their OAuth secret is configured", async (t) => {
  const { root, env } = await project(t);
  const host = createHost({
    targetRoot: root,
    env: {
      ...env,
      CREWRUN_SLACK_CLIENT_ID: "slack-client-id",
      CREWRUN_GOOGLE_CLIENT_ID: "google-client-id"
    }
  });
  t.after(() => host.stop());
  const connectors = (await host.operations.getSnapshot()).connectors;
  for (const id of ["slack", "google-workspace"]) {
    const connector = connectors.find((entry) => entry.id === id);
    assert.equal(connector.configured, false);
    assert.match(connector.setupMessage, /Set up this provider app/i);
  }
});

test("hosted consent requires an explicit capability choice", async (t) => {
  const { root, env } = await project(t);
  const host = createFakeHost({ root, env });
  t.after(() => host.stop());

  await assert.rejects(
    host.operations.connect({ connectorId: "fake" }),
    /Choose at least one Fake integration capability/i
  );
});

test("one-owner reconnects serialize concurrent callbacks and retain exactly one active connection", async (t) => {
  const { root, env } = await project(t);
  const revoked = [];
  const plugin = defineIntegrationPlugin({
    id: "reconnect",
    label: "Reconnect test",
    oauth: { authorizationEndpoint: "https://provider.example.test/authorize", pkce: "required" },
    capabilities: [{ id: "messages", label: "Messages", direction: "read", scopes: ["messages.read"] }],
    actions: [], events: [],
    adapter: {
      async exchangeCode({ code }) {
        // Yield once so the two browser callbacks overlap before their persistence phase.
        await new Promise((resolve) => setImmediate(resolve));
        return {
          account: { id: `account-${code}`, label: `Account ${code}` },
          credentials: { accessToken: `private-${code}` }, scopes: ["messages.read"]
        };
      },
      async revoke({ connection }) { revoked.push(connection.id); return { revoked: true }; }
    }
  });
  const host = createIntegrationHost({ targetRoot: root, plugins: [plugin], publicBaseUrl: PUBLIC_BASE_URL, vaultKey: VAULT_KEY, env });
  t.after(() => host.stop());
  host.state.saveConnection({
    id: "reconnect-previous", pluginId: "reconnect", account: { id: "previous", label: "Previous" },
    capabilities: ["messages"], credentials: { accessToken: "private-previous" }
  });
  host.state.saveConnection({
    id: "reconnect-needs-reconnect", pluginId: "reconnect", status: "needs_reconnect", account: { id: "stale", label: "Stale" },
    capabilities: ["messages"], credentials: { accessToken: "private-stale" }
  });
  host.state.saveConnection({
    id: "reconnect-revoked", pluginId: "reconnect", status: "revoked", account: { id: "revoked", label: "Revoked" },
    capabilities: ["messages"], credentials: { accessToken: "private-revoked" }
  });
  const firstState = host.state.issueOAuthState({ pluginId: "reconnect", capabilities: ["messages"], verifier: "first-pkce-verifier" });
  const secondState = host.state.issueOAuthState({ pluginId: "reconnect", capabilities: ["messages"], verifier: "second-pkce-verifier" });

  const replies = await Promise.all([
    oauthCallback(host, "reconnect", firstState, "first"),
    oauthCallback(host, "reconnect", secondState, "second")
  ]);
  assert.deepEqual(replies.map((reply) => reply.status), [200, 200]);
  const active = host.state.listConnections().filter((connection) => connection.plugin === "reconnect" && connection.status === "connected");
  assert.equal(active.length, 1, "only the last serialized callback remains a usable connection");
  const retired = host.state.listConnections().filter((connection) => connection.plugin === "reconnect" && connection.id !== active[0].id);
  assert.ok(retired.every((connection) => connection.status === "disconnected"), "all prior non-disconnected records are retired after a successful replacement");
  assert.ok(revoked.length >= 4, "prior local connections are remotely revoked before their encrypted credentials are cleared");
});

test("a durable provider lease prevents two reference-host processes from replacing each other", async (t) => {
  const { root, env } = await project(t);
  const revoked = [];
  let signalFirstSubscription;
  const firstSubscriptionStarted = new Promise((resolve) => { signalFirstSubscription = resolve; });
  let releaseFirstSubscription;
  const holdFirstSubscription = new Promise((resolve) => { releaseFirstSubscription = resolve; });
  let exchanges = 0;
  let subscriptions = 0;
  const plugin = defineIntegrationPlugin({
    id: "cross-host-reconnect",
    label: "Cross-host reconnect test",
    oauth: { authorizationEndpoint: "https://provider.example.test/authorize", pkce: "required" },
    capabilities: [{ id: "messages", label: "Messages", direction: "read", scopes: ["messages.read"] }],
    actions: [], events: [],
    adapter: {
      async exchangeCode({ code }) {
        await new Promise((resolve) => setImmediate(resolve));
        exchanges += 1;
        if (exchanges === 1) { signalFirstSubscription(); await holdFirstSubscription; }
        return {
          account: { id: `account-${code}`, label: `Account ${code}` },
          credentials: { accessToken: `private-${code}` }, scopes: ["messages.read"]
        };
      },
      async subscribe() {
        subscriptions += 1;
        if (subscriptions === 1) {
          signalFirstSubscription();
          await holdFirstSubscription;
        }
        return [];
      },
      async revoke({ connection }) { revoked.push(connection.id); return { revoked: true }; }
    }
  });
  const one = createIntegrationHost({ targetRoot: root, plugins: [plugin], publicBaseUrl: PUBLIC_BASE_URL, vaultKey: VAULT_KEY, env });
  const two = createIntegrationHost({ targetRoot: root, plugins: [plugin], publicBaseUrl: PUBLIC_BASE_URL, vaultKey: VAULT_KEY, env });
  t.after(async () => { await one.stop(); await two.stop(); });
  one.state.saveConnection({
    id: "cross-host-prior", pluginId: "cross-host-reconnect", account: { id: "prior", label: "Prior" },
    capabilities: ["messages"], credentials: { accessToken: "private-prior" }
  });
  const firstState = one.state.issueOAuthState({ pluginId: "cross-host-reconnect", capabilities: ["messages"], verifier: "first-cross-host-pkce-verifier" });
  const secondState = one.state.issueOAuthState({ pluginId: "cross-host-reconnect", capabilities: ["messages"], verifier: "second-cross-host-pkce-verifier" });

  const firstReply = oauthCallback(one, "cross-host-reconnect", firstState, "first");
  await firstSubscriptionStarted;
  const secondReply = await oauthCallback(two, "cross-host-reconnect", secondState, "second");
  releaseFirstSubscription();
  const replies = [await firstReply, secondReply];
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
  assert.equal(exchanges, 1, "the losing host never exchanges its OAuth code or receives a remote grant");
  const active = one.state.listConnections().filter((connection) => connection.plugin === "cross-host-reconnect" && connection.status === "connected");
  assert.equal(active.length, 1, "only the lease holder can persist and replace the current provider connection");
  assert.equal(revoked.filter((id) => id === "cross-host-prior").length, 1, "the prior credential is retired exactly once");
});

test("reference host stop closes its durable runtime database exactly once", async (t) => {
  const { root, env } = await project(t);
  const host = createFakeHost({ root, env });
  await host.stop();
  assert.equal(host.runtime.store.db.open, false);
  await host.stop();
});

test("reference hosts use durable cross-process schedule claims", async (t) => {
  const { root, env } = await project(t);
  upsertSchedule({ targetRoot: root, schedule: { id: "once-a-minute", role: "ops", cron: "* * * * *", prompt: "Run once" } });
  const one = createFakeHost({ root, env });
  const two = createFakeHost({ root, env });
  t.after(async () => { await one.stop(); await two.stop(); });
  const clock = () => new Date("2026-09-08T12:00:05.000Z");
  await writeFile(path.join(root, ".crew/workspace.json"), JSON.stringify({ version: 1, id: "scheduler-test-workspace", timezone: "UTC" }));
  const first = createUp({ targetRoot: root, host: one, env, now: clock });
  const second = createUp({ targetRoot: root, host: two, env, now: clock });

  assert.equal(first.scheduler.tick().length, 1);
  assert.equal(second.scheduler.tick().length, 0, "a second reference-host process cannot enqueue the same schedule");
  assert.equal(one.runtime.snapshot().runs.length, 1);
});

test("reference host keeps CrewRun lifecycle hooks valid alongside plugin events", async (t) => {
  const { root, env } = await project(t, roleSpec({
    hooks: ["approval.approved", "approval.rejected", "schedule.failed"]
  }));
  const host = createFakeHost({ root, env });
  t.after(() => host.stop());

  assert.ok(host.knownEvents.includes("fake.messageReceived"));
  for (const event of ["approval.approved", "approval.rejected", "schedule.failed"]) {
    assert.ok(host.knownEvents.includes(event));
  }
  const models = collectModels(root, { knownEvents: host.knownEvents, operations: await host.operations.getSnapshot() });
  assert.deepEqual(models.validation.problems, []);
});

test("inbound events need an enabled rule, matching role hook, and connection data authority before enqueue", async (t) => {
  const { root, env } = await project(t, roleSpec({ hooks: [], read: [] }));
  const host = createFakeHost({ root, env });
  t.after(() => host.stop());

  await assert.rejects(
    host.operations.saveEventRoute({ connectionId: "fake-main", eventType: "fake.messageReceived", role: "missing", enabled: true }),
    /existing role/i
  );
  await assert.rejects(
    host.operations.saveEventRoute({ connectionId: "fake-main", eventType: "fake.unknown", role: "ops", enabled: true }),
    /not declared/i
  );

  assert.equal((await webhook(host, "no-rule")).status, 200);
  await settleIngress();
  assert.equal(host.runtime.snapshot().runs.length, 0, "an event with no route stays out of the runtime queue");
  assert.equal(host.state.listEvents()[0].status, "ignored");

  host.state.upsertRoute({ connectionId: "fake-main", eventType: "fake.messageReceived", role: "ops", enabled: false });
  await webhook(host, "disabled-rule");
  await settleIngress();
  assert.equal(host.runtime.snapshot().runs.length, 0, "a disabled event rule cannot enqueue work");

  host.state.upsertRoute({ connectionId: "fake-main", eventType: "fake.messageReceived", role: "ops", enabled: true });
  await webhook(host, "missing-hook");
  await settleIngress();
  assert.equal(host.runtime.snapshot().runs.length, 0, "a role that does not subscribe to the hook cannot receive it");

  await saveRole(root, roleSpec({ hooks: ["fake.messageReceived"], read: [] }));
  await webhook(host, "missing-data-authority");
  await settleIngress();
  assert.equal(host.runtime.snapshot().runs.length, 0, "a role cannot receive provider metadata outside its data authority");

  await saveRole(root, roleSpec({ hooks: ["fake.messageReceived"], read: ["connector:fake:fake-main"] }));
  await webhook(host, "authorized-once");
  await settleIngress();
  assert.equal(host.runtime.snapshot().runs.length, 1, "the fully authorized route creates one durable run");
  assert.equal(host.state.listEvents()[0].status, "routed");

  await webhook(host, "authorized-once");
  await settleIngress();
  assert.equal(host.runtime.snapshot().runs.length, 1, "a duplicate provider receipt cannot create a second run");
});

test("received webhook receipts recover once after a post-ACK process gap", async (t) => {
  const { root, env } = await project(t, roleSpec({ hooks: ["fake.messageReceived"], read: ["connector:fake:fake-main"] }));
  const host = createFakeHost({ root, env });
  t.after(() => host.stop());
  host.state.upsertRoute({ connectionId: "fake-main", eventType: "fake.messageReceived", role: "ops", enabled: true });
  const receipt = host.state.ingestEvent({
    connectionId: "fake-main",
    providerEventId: "post-ack-gap",
    type: "fake.messageReceived",
    resource: { id: "thread-1", label: "Fake thread" },
    summary: { subject: "A durable verified receipt" },
    rawPayload: "a provider body that must never enter the event inbox"
  });
  assert.equal(receipt.event.status, "received", "the simulated crash happens after durable ACK and before routing");

  assert.deepEqual(await host.recoverInboundEvents(), { recovered: 1 });
  assert.equal(host.runtime.snapshot().runs.length, 1, "recovery creates the missing governed run");
  assert.equal(host.state.listEvents()[0].status, "routed");
  assert.deepEqual(await host.recoverInboundEvents(), { recovered: 0 }, "only unprocessed receipts are scanned on later recovery passes");
  assert.equal(host.runtime.snapshot().runs.length, 1, "recovery never duplicates the original external receipt");
});

test("a due provider subscription renews through the encrypted connection record", async (t) => {
  const { root, env } = await project(t);
  const renewals = [];
  const plugin = defineIntegrationPlugin({
    id: "renewable",
    label: "Renewable integration",
    capabilities: [{ id: "events", label: "Events", direction: "read", scopes: ["renew.read"] }],
    actions: [],
    events: [{ id: "renewable.changed", capability: "events", label: "Changed", delivery: "webhook", retention: "metadata" }],
    adapter: {
      async renew({ subscription, connection, credentials }) {
        renewals.push({ subscriptionId: subscription.id, connectionId: connection.id, accessToken: credentials.accessToken });
        return { ...subscription, expiresAt: Date.now() + 60 * 60_000, status: "active" };
      }
    }
  });
  const host = createIntegrationHost({ targetRoot: root, plugins: [plugin], publicBaseUrl: PUBLIC_BASE_URL, vaultKey: VAULT_KEY, env });
  t.after(() => host.stop());
  host.state.saveConnection({
    id: "renewable-main", pluginId: "renewable", account: { id: "account-1", label: "Account" },
    scopes: ["renew.read"], capabilities: ["events"], credentials: { accessToken: "private-renew-token" }
  });
  host.state.upsertSubscription({
    id: "renewable-subscription", connectionId: "renewable-main", providerKey: "renewable.changed",
    resource: { kind: "inbox" }, expiresAt: Date.now() - 1, status: "active"
  });

  await Promise.all([host.tick(), host.tick()]);

  assert.deepEqual(renewals.map(({ subscriptionId, connectionId }) => ({ subscriptionId, connectionId })), [{ subscriptionId: "renewable-subscription", connectionId: "renewable-main" }], "overlapping host ticks share one durable renewal claim");
  assert.ok(host.state.getSubscription("renewable-main", "renewable.changed", { kind: "inbox" }).expiresAt > Date.now());
  assert.doesNotMatch(JSON.stringify(await host.operations.getSnapshot()), /private-renew-token/);
});

test("disconnect refreshes an expired credential for provider revocation, then clears local secrets", async (t) => {
  const { root, env } = await project(t);
  const calls = [];
  const plugin = defineIntegrationPlugin({
    id: "revocable",
    label: "Revocable integration",
    capabilities: [], actions: [], events: [],
    adapter: {
      async refreshCredentials({ credentials }) {
        calls.push(`refresh:${credentials.accessToken}`);
        return { credentials: { accessToken: "refreshed-private-token", refreshToken: credentials.refreshToken, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() } };
      },
      async revoke({ credentials }) { calls.push(`revoke:${credentials.accessToken}`); return { revoked: true }; }
    }
  });
  const host = createIntegrationHost({ targetRoot: root, plugins: [plugin], publicBaseUrl: PUBLIC_BASE_URL, vaultKey: VAULT_KEY, env });
  t.after(() => host.stop());
  host.state.saveConnection({
    id: "revocable-main", pluginId: "revocable", account: { id: "account-1", label: "Account" },
    credentials: { accessToken: "expired-private-token", refreshToken: "refresh-private-token", expiresAt: new Date(Date.now() - 1).toISOString() }
  });

  await host.operations.disconnect({ id: "revocable-main" });

  assert.deepEqual(calls, ["refresh:expired-private-token", "revoke:refreshed-private-token"]);
  assert.equal(host.state.getConnection("revocable-main").status, "disconnected");
  assert.equal(host.state.getConnection("revocable-main", { credentials: true }).credentials, null);
});

test("approved integration delivery rechecks role authority and connection revision before provider invocation", async (t) => {
  const { root, env } = await project(t);
  const providerCalls = [];
  const host = createFakeHost({ root, env, calls: providerCalls });
  t.after(() => host.stop());

  const authorityPending = await queuedApproval(host);
  assert.equal(authorityPending.status, "awaiting_approval");
  host.runtime.decideApproval(authorityPending.actionId, "approve");
  await saveRole(root, roleSpec({ write: [], revision: 2 }));
  const authorityResult = await host.runtime.deliver(authorityPending.actionId);
  assert.equal(authorityResult.status, "failed");
  assert.match(authorityResult.error, /not authorized|outside this role's authority/i);
  assert.equal(providerCalls.length, 0, "an approval cannot survive revoked role authority");

  await saveRole(root, roleSpec({ revision: 3 }));
  const connectionPending = await queuedApproval(host);
  assert.equal(connectionPending.status, "awaiting_approval");
  host.runtime.decideApproval(connectionPending.actionId, "approve");
  const connection = host.state.getConnection("fake-main", { credentials: true });
  host.state.saveConnection({
    id: connection.id,
    pluginId: connection.plugin,
    account: connection.account,
    scopes: connection.scopes,
    capabilities: connection.capabilities,
    credentials: connection.credentials
  });
  const staleConnection = await host.runtime.deliver(connectionPending.actionId);
  assert.equal(staleConnection.status, "failed");
  assert.match(staleConnection.error, /connection changed after review/i);
  assert.equal(providerCalls.length, 0, "a stale connection revision cannot invoke a provider");
});

test("an approved integration delivery retains its role, runner, and model in the audit chain", async (t) => {
  const { root, env } = await project(t, roleSpec({ runner: "claude-agent-sonnet-high" }));
  const providerCalls = [];
  const host = createFakeHost({ root, env, calls: providerCalls });
  t.after(() => host.stop());

  const pending = await queuedApproval(host);
  host.runtime.decideApproval(pending.actionId, "approve");
  await saveRole(root, roleSpec({ runner: "codex-agent-high" }));
  const delivered = await host.runtime.deliver(pending.actionId);

  assert.equal(delivered.status, "delivered");
  assert.equal(providerCalls.length, 1);
  const completed = host.runtime.governance.audit.list().find((entry) => entry.outcome === "completed" && entry.tool_name === "fake.send");
  assert.equal(completed.actor, "ops");
  assert.equal(completed.runner, "claude-agent-sonnet-high");
  assert.equal(completed.model, "sonnet");
});

test("the hosted console renders actual plugin cards and the event inbox, not legacy connector defaults", async (t) => {
  const { root, env } = await project(t, {
    ...roleSpec({ hooks: ["slack.channelMessage"], read: ["connector:slack:slack-main"] }),
    contract: {
      version: 1,
      revision: 1,
      mandate: "Review Slack event metadata.",
      authority: { tools: [], data: { read: ["connector:slack:slack-main"], write: [] } }
    }
  });
  Object.assign(env, {
    CREWRUN_SLACK_CLIENT_ID: "slack-client-id",
    CREWRUN_SLACK_CLIENT_SECRET: "slack-client-secret-never-public",
    CREWRUN_GOOGLE_CLIENT_ID: "google-client-id",
    CREWRUN_GOOGLE_CLIENT_SECRET: "google-client-secret-never-public",
    CREWRUN_MICROSOFT_CLIENT_ID: "microsoft-client-id",
    CREWRUN_MICROSOFT_CLIENT_SECRET: "microsoft-client-secret-never-public",
    CREWRUN_GITHUB_APP_ID: "12345",
    CREWRUN_GITHUB_WEBHOOK_SECRET: "github-webhook-secret-never-public"
  });
  const host = createHost({ targetRoot: root, env });
  host.state.saveConnection({
    id: "slack-main",
    pluginId: "slack",
    account: { id: "T1", label: "CrewRun workspace" },
    scopes: ["channels:history", "chat:write"],
    capabilities: ["messages"],
    credentials: { accessToken: "slack-access-token-never-public" }
  });
  t.after(() => host.stop());
  const models = collectModels(root, { knownEvents: host.knownEvents, operations: await host.operations.getSnapshot() });
  const connectors = renderPartial("integrations", models, { canConnect: true, canDisconnect: true });
  for (const label of ["Slack", "Google Workspace", "Microsoft 365", "GitHub"]) assert.match(connectors, new RegExp(label));
  assert.match(connectors, /Connect Google Workspace/, "the inventory has visible connection actions");
  const detail = renderPartial("integrations", models, { canConnect: true, selectedIntegration: "google-workspace" });
  assert.match(detail, /Choose access/, "capabilities are chosen on the connection page");
  assert.doesNotMatch(connectors, /WhatsApp Business|Google Calendar/, "host inventory replaces old standalone gateway cards");
  assert.doesNotMatch(connectors, /slack-client-secret-never-public|slack-access-token-never-public/);

  const events = renderPartial("activity", models, { tab: "events", canManageEventRoutes: true });
  assert.match(events, /<h1>Activity<\/h1>/);
  assert.doesNotMatch(events, /Add or update event rule|action="\/integrations\/route"/);
  const rules = renderPartial("integrations", models, { canManageEventRoutes: true, selectedIntegration: "slack", tab: "rules" });
  assert.match(rules, /Add or update event rule/);
  assert.match(rules, /slack\.channelMessage/);
  assert.match(rules, /action="\/integrations\/route"/);
  assert.doesNotMatch(rules, /Recent verified receipts/);
});
