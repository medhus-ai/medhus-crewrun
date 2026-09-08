import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { createIntegrationIngress, oauthCallbackUrl } from "../packages/crewrun-reference-host/src/ingress.js";
import { createIntegrationState } from "../packages/crewrun-reference-host/src/state.js";

const VAULT_KEY = "test-only-integration-vault-key-that-is-long-enough";
const PUBLIC_BASE = "https://crewrun.example.test";

async function fixture(t, plugin, { onEvent = () => {}, config = {}, extraPlugins = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-reference-host-ingress-"));
  const state = createIntegrationState({
    targetRoot: root,
    vaultKey: VAULT_KEY,
    env: { CREW_HOME: path.join(root, "crew-home") }
  });
  const allPlugins = [plugin, ...extraPlugins];
  const registry = { get: (id) => allPlugins.find((entry) => entry.id === id) || null };
  const ingress = createIntegrationIngress({
    plugins: registry,
    state,
    configFor: () => config,
    onEvent,
    publicBaseUrl: PUBLIC_BASE
  });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, state, ingress };
}

function request(ingress, { method = "GET", url = "/", headers = {}, body = "" } = {}) {
  const input = Readable.from(body ? [Buffer.from(body)] : []);
  input.method = method;
  input.url = url;
  input.headers = headers;
  return new Promise((resolve, reject) => {
    const response = {
      headersSent: false,
      statusCode: 0,
      headers: {},
      writeHead(statusCode, responseHeaders) {
        this.statusCode = statusCode;
        this.headers = responseHeaders || {};
        this.headersSent = true;
      },
      end(responseBody = "") {
        resolve({ status: this.statusCode, headers: this.headers, body: String(responseBody) });
      }
    };
    void ingress.handle(input, response).catch(reject);
  });
}

function plugin(overrides = {}) {
  return {
    id: "slack",
    label: "Slack",
    capabilities: [{ id: "messages", label: "Messages" }],
    events: [{ id: "slack.messageReceived", label: "Message received" }],
    adapter: {},
    ...overrides
  };
}

test("public integration ingress refuses non-loopback listeners", async (t) => {
  const { ingress } = await fixture(t, plugin());
  assert.throws(() => ingress.listen({ port: 0, host: "0.0.0.0" }), /loopback address/i);

  // Some restricted CI sandboxes prohibit opening any listening socket. Outside those
  // sandboxes this also proves the accepted address is actually loopback.
  let server;
  try {
    server = await ingress.listen({ port: 0, host: "127.0.0.1" });
    assert.equal(server.address().address, "127.0.0.1");
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

test("OAuth callback consumes PKCE state once and stores only encrypted credentials", async (t) => {
  const exchanges = [];
  const accessToken = "oauth-access-token-never-public";
  const fake = plugin({
    adapter: {
      async exchangeCode(input) {
        exchanges.push(input);
        return {
          credentials: { accessToken, refreshToken: "oauth-refresh-token-never-public" },
          account: { id: "T1", label: "CrewRun test workspace", accessToken },
          scopes: ["chat:write"],
          status: "connected"
        };
      },
      async subscribe() {
        return [{ id: "sub-1", providerKey: "messages", resource: { channel: "C1" }, secret: "subscription-secret" }];
      }
    }
  });
  const { state, ingress } = await fixture(t, fake, { config: { clientId: "client-id", clientSecret: "client-secret" } });
  const verifier = "pkce-verifier-for-callback";
  const stateValue = state.issueOAuthState({ pluginId: "slack", capabilities: ["messages"], verifier });
  const callback = `/integrations/oauth/slack/callback?code=provider-code&state=${encodeURIComponent(stateValue)}`;

  const connected = await request(ingress, { url: callback });
  assert.equal(connected.status, 200);
  assert.match(connected.body, /Slack connected/);
  assert.equal(connected.body.includes(accessToken), false);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].verifier, verifier);
  assert.equal(exchanges[0].redirectUri, `${PUBLIC_BASE}/integrations/oauth/slack/callback`);
  assert.deepEqual(exchanges[0].capabilities, ["messages"]);

  const connection = state.listConnections()[0];
  assert.deepEqual(connection.account, { id: "T1", label: "CrewRun test workspace" });
  assert.equal(JSON.stringify(connection).includes(accessToken), false);
  assert.equal(state.listSubscriptions()[0].id, "sub-1");
  assert.equal(state.subscriptionSecretById("sub-1"), "subscription-secret");
  assert.equal((await readFile(state.file, "utf8")).includes(accessToken), false);

  const replay = await request(ingress, { url: callback });
  assert.equal(replay.status, 400);
  assert.match(replay.body, /Connection expired/);
  assert.equal(exchanges.length, 1, "an OAuth callback replay never exchanges the code again");
});

test("an OAuth callback for another installed provider cannot consume its state", async (t) => {
  const slackExchanges = [];
  const slack = plugin({
    adapter: {
      async exchangeCode(input) {
        slackExchanges.push(input);
        return { credentials: { accessToken: "slack-private" }, account: { id: "T1", label: "Workspace" } };
      }
    }
  });
  const google = {
    ...plugin({ id: "google-workspace", label: "Google Workspace" }),
    adapter: { async exchangeCode() { throw new Error("the mismatched state must never exchange"); } }
  };
  const { state, ingress } = await fixture(t, slack, { extraPlugins: [google] });
  const stateValue = state.issueOAuthState({ pluginId: "slack", capabilities: ["messages"], verifier: "pkce-verifier-for-bound-state" });

  const wrongCallback = await request(ingress, {
    url: `/integrations/oauth/google-workspace/callback?code=wrong-provider-code&state=${encodeURIComponent(stateValue)}`
  });
  assert.equal(wrongCallback.status, 400);
  assert.match(wrongCallback.body, /Connection expired/);
  assert.equal(slackExchanges.length, 0);

  const rightCallback = await request(ingress, {
    url: `/integrations/oauth/slack/callback?code=right-provider-code&state=${encodeURIComponent(stateValue)}`
  });
  assert.equal(rightCallback.status, 200, "the mismatched callback did not burn the valid state");
  assert.equal(slackExchanges.length, 1);
});

test("a subscription setup failure revokes and clears the new authorization without retiring the prior connection", async (t) => {
  const revoked = [];
  const fake = plugin({
    adapter: {
      async exchangeCode() {
        return {
          credentials: { accessToken: "new-private-token", refreshToken: "new-private-refresh" },
          account: { id: "T-new", label: "New workspace" }
        };
      },
      async subscribe() { throw new Error("provider event endpoint rejected"); },
      async revoke({ connection, credentials }) {
        revoked.push({ id: connection.id, accessToken: credentials.accessToken });
      }
    }
  });
  const { state, ingress } = await fixture(t, fake);
  state.saveConnection({
    id: "slack-prior", pluginId: "slack", account: { id: "T-prior", label: "Prior workspace" },
    capabilities: ["messages"], credentials: { accessToken: "prior-private-token" }
  });
  const stateValue = state.issueOAuthState({ pluginId: "slack", capabilities: ["messages"], verifier: "pkce-verifier-for-failed-subscription" });

  const reply = await request(ingress, {
    url: `/integrations/oauth/slack/callback?code=provider-code&state=${encodeURIComponent(stateValue)}`
  });
  assert.equal(reply.status, 502);
  assert.match(reply.body, /Connection not completed/);
  assert.doesNotMatch(reply.body, /Slack connected/);
  assert.equal(revoked.length, 1, "the newly granted provider authorization is revoked");
  assert.equal(revoked[0].accessToken, "new-private-token");

  const connections = state.listConnections();
  const prior = connections.find((connection) => connection.id === "slack-prior");
  const failed = connections.find((connection) => connection.id === revoked[0].id);
  assert.equal(prior.status, "connected", "the previous connection remains available after setup failure");
  assert.equal(failed.status, "disconnected");
  assert.equal(state.getConnection(failed.id, { credentials: true }).credentials, null, "new credentials are cleared from local encrypted state");
});

test("a non-connected OAuth exchange result is revoked and cleared instead of being reported as connected", async (t) => {
  const revoked = [];
  const fake = plugin({
    adapter: {
      async exchangeCode() {
        return {
          credentials: { accessToken: "unusable-private-token" },
          account: { id: "T-unusable", label: "Unusable workspace" },
          status: "needs_reconnect"
        };
      },
      async revoke({ connection }) { revoked.push(connection.id); }
    }
  });
  const { state, ingress } = await fixture(t, fake);
  const stateValue = state.issueOAuthState({ pluginId: "slack", capabilities: ["messages"], verifier: "pkce-verifier-for-unusable-result" });

  const reply = await request(ingress, {
    url: `/integrations/oauth/slack/callback?code=provider-code&state=${encodeURIComponent(stateValue)}`
  });
  assert.equal(reply.status, 502);
  assert.match(reply.body, /Connection not completed/);
  assert.doesNotMatch(reply.body, /Slack connected/);
  assert.equal(revoked.length, 1);
  const connection = state.listConnections().find((entry) => entry.id === revoked[0]);
  assert.equal(connection.status, "disconnected");
  assert.equal(state.getConnection(connection.id, { credentials: true }).credentials, null);
});

test("public integration URLs require an HTTPS origin without a path prefix", () => {
  assert.equal(
    oauthCallbackUrl("https://crewrun.example.test/", "slack"),
    "https://crewrun.example.test/integrations/oauth/slack/callback"
  );
  assert.throws(
    () => oauthCallbackUrl("https://crewrun.example.test/funnel-prefix", "slack"),
    /https origin without a path/i
  );
  assert.throws(
    () => oauthCallbackUrl("https://crewrun.example.test?unexpected=1", "slack"),
    /https origin without a path/i
  );
});

test("a verified webhook persists metadata only, deduplicates receipt IDs, and rejects a mismatched connection", async (t) => {
  const received = [];
  let events = [];
  let verifiedRawBody = "";
  const fake = plugin({
    adapter: {
      async verifyWebhook(input) {
        verifiedRawBody = input.rawBody;
        return { ok: true, events };
      }
    }
  });
  const { state, ingress } = await fixture(t, fake, { onEvent: (event) => received.push(event) });
  state.saveConnection({ id: "slack-safe", pluginId: "slack", account: { id: "T1", label: "Workspace" } });
  state.saveConnection({ id: "github-safe", pluginId: "github", account: { id: "I1", label: "Wrong provider" } });
  const rawPayload = JSON.stringify({ event: "message", body: "private provider content never enters CrewRun state" });
  events = [{
    providerEventId: "Ev-001",
    type: "slack.messageReceived",
    resource: { channel: "C1" },
    summary: { subject: "A new message arrived" },
    occurredAt: "2026-09-01T12:00:00.000Z"
  }];

  const accepted = await request(ingress, {
    method: "POST",
    url: "/integrations/webhooks/slack/slack-safe",
    headers: { "content-type": "application/json" },
    body: rawPayload
  });
  assert.equal(accepted.status, 200);
  assert.equal(verifiedRawBody, rawPayload, "the provider verifier receives the exact signed body");
  assert.equal(state.listEvents().length, 1);
  assert.equal(received.length, 1);
  assert.equal(JSON.stringify(state.listEvents()).includes("private provider content"), false);
  assert.equal((await readFile(state.file, "utf8")).includes("private provider content"), false);
  assert.equal(JSON.stringify(received[0]).includes("private provider content"), false);

  const duplicate = await request(ingress, {
    method: "POST",
    url: "/integrations/webhooks/slack/slack-safe",
    body: rawPayload
  });
  assert.equal(duplicate.status, 200);
  assert.equal(state.listEvents().length, 1);
  assert.equal(received.length, 1, "duplicate deliveries do not route another event");

  events = [{
    providerEventId: "Ev-foreign",
    type: "slack.messageReceived",
    resource: { channel: "C1" },
    summary: { subject: "This route belongs to another provider" }
  }];
  const foreignConnection = await request(ingress, {
    method: "POST",
    url: "/integrations/webhooks/slack/github-safe",
    body: rawPayload
  });
  assert.equal(foreignConnection.status, 200);
  assert.equal(state.listEvents().length, 1, "a Slack endpoint cannot write a GitHub connection receipt");

  events = [{
    providerEventId: "Ev-content",
    type: "slack.messageReceived",
    resource: { channel: "C1" },
    summary: { body: "provider content is not allowed in event metadata" }
  }];
  const contentBearing = await request(ingress, {
    method: "POST",
    url: "/integrations/webhooks/slack/slack-safe",
    body: rawPayload
  });
  assert.equal(contentBearing.status, 200, "valid webhook deliveries are acknowledged even when metadata is discarded");
  assert.equal(state.listEvents().length, 1, "content-bearing event metadata is not retained");
});
