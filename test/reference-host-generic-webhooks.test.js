import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { createGoogleWorkspacePlugin } from "../packages/crewrun-plugin-google-workspace/src/index.js";
import { createSlackPlugin } from "../packages/crewrun-plugin-slack/src/index.js";
import { createIntegrationIngress } from "../packages/crewrun-reference-host/src/ingress.js";
import { createIntegrationState } from "../packages/crewrun-reference-host/src/state.js";

const VAULT_KEY = "test-only-integration-vault-key-that-is-long-enough";
const PUBLIC_BASE_URL = "https://arsazmar0smars3.taila9c41d.ts.net";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-generic-webhook-"));
  const env = { CREW_HOME: path.join(root, "crew-home") };
  const state = createIntegrationState({ targetRoot: root, vaultKey: VAULT_KEY, env });
  const slack = createSlackPlugin();
  const google = createGoogleWorkspacePlugin();
  const delivered = [];
  const config = {
    slack: { signingSecret: "slack-signing-secret" },
    "google-workspace": {
      gmailPushAudience: "https://crewrun.example.test/gmail-push",
      gmailPushServiceAccount: "crewrun-push@example.iam.gserviceaccount.com",
      verifyOidcToken: async ({ token, audience, serviceAccountEmail }) => token === "trusted-google-push"
        && audience === "https://crewrun.example.test/gmail-push"
        && serviceAccountEmail === "crewrun-push@example.iam.gserviceaccount.com"
    }
  };
  const ingress = createIntegrationIngress({
    plugins: { get: (id) => ({ slack, "google-workspace": google })[id] || null },
    state,
    configFor: (id) => config[id] || {},
    publicBaseUrl: PUBLIC_BASE_URL,
    onEvent: (event) => delivered.push(event)
  });
  t.after(async () => {
    state.close();
    await rm(root, { recursive: true, force: true });
  });
  return { state, ingress, delivered };
}

function post(ingress, { pathname, headers = {}, body }) {
  const request = Readable.from([Buffer.from(String(body || ""))]);
  request.method = "POST";
  request.url = pathname;
  request.headers = headers;
  return new Promise((resolve, reject) => {
    const response = {
      headersSent: false,
      statusCode: 0,
      writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; },
      end(responseBody = "") { resolve({ status: this.statusCode, body: String(responseBody) }); }
    };
    void ingress.handle(request, response).catch(reject);
  });
}

async function flushIngress() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("a generic Slack Events API callback maps its signed team_id to one connected workspace", async (t) => {
  const { state, ingress, delivered } = await fixture(t);
  state.saveConnection({
    id: "slack-main",
    pluginId: "slack",
    account: { id: "T_WORKSPACE", label: "CrewRun workspace" },
    scopes: ["app_mentions:read", "chat:write"],
    capabilities: ["mentions"],
    credentials: { accessToken: "slack-token-never-public" }
  });
  const payload = {
    type: "event_callback",
    event_id: "Ev-single-callback",
    event_time: Math.floor(Date.now() / 1000),
    team_id: "T_WORKSPACE",
    event: { type: "app_mention", user: "U1", channel: "C1", ts: "123.456", text: "untrusted content must not persist" }
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", "slack-signing-secret").update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;

  const response = await post(ingress, {
    pathname: "/integrations/webhooks/slack",
    headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    body: rawBody
  });
  assert.equal(response.status, 200);
  await flushIngress();

  assert.equal(state.listEvents().length, 1);
  assert.equal(state.listEvents()[0].connectionId, "slack-main");
  assert.equal(state.listEvents()[0].type, "slack.appMention");
  assert.equal(delivered[0].connectionId, "slack-main");
  assert.doesNotMatch(JSON.stringify(state.listEvents()), /untrusted content/);

  const unselected = {
    ...payload,
    event_id: "Ev-unselected-channel-message",
    event: { type: "message", user: "U1", channel: "C1", ts: "123.457", text: "still not persisted" }
  };
  const unselectedRaw = JSON.stringify(unselected);
  const unselectedSignature = `v0=${createHmac("sha256", "slack-signing-secret").update(`v0:${timestamp}:${unselectedRaw}`).digest("hex")}`;
  assert.equal((await post(ingress, {
    pathname: "/integrations/webhooks/slack",
    headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": unselectedSignature },
    body: unselectedRaw
  })).status, 200);
  await flushIngress();
  assert.equal(state.listEvents().length, 1, "a signed event outside the selected capability is not retained");
  assert.equal(delivered.length, 1, "an unselected provider event cannot reach the host router");
});

test("a generic Gmail Pub/Sub callback maps emailAddress to the connected account email", async (t) => {
  const { state, ingress, delivered } = await fixture(t);
  state.saveConnection({
    id: "google-workspace-main",
    pluginId: "google-workspace",
    account: { id: "google-subject-id", label: "Owner", email: "owner@example.test" },
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    capabilities: ["gmail-read"],
    credentials: { accessToken: "google-token-never-public" }
  });
  const messageData = Buffer.from(JSON.stringify({ emailAddress: "OWNER@example.test", historyId: "42" })).toString("base64url");
  const rawBody = JSON.stringify({
    message: { messageId: "pubsub-single-callback", data: messageData, publishTime: "2026-09-08T12:00:00.000Z" }
  });

  const response = await post(ingress, {
    pathname: "/integrations/webhooks/google-workspace",
    headers: { authorization: "Bearer trusted-google-push" },
    body: rawBody
  });
  assert.equal(response.status, 200);
  await flushIngress();

  assert.equal(state.listEvents().length, 1);
  assert.equal(state.listEvents()[0].connectionId, "google-workspace-main");
  assert.equal(state.listEvents()[0].type, "google-workspace.gmailMailboxChanged");
  assert.equal(delivered[0].connectionId, "google-workspace-main");
  assert.doesNotMatch(JSON.stringify(state.listEvents()), /google-token-never-public/);
});
