import assert from "node:assert/strict";
import test from "node:test";

import {
  INTEGRATION_PLUGIN_API_VERSION,
  connectionMetadata,
  createPluginRegistry,
  defineIntegrationPlugin,
  eventReceiptKey,
  normalizeIntegrationEvent,
  oauthAuthorizationUrl,
  providerOAuthMetadata
} from "../packages/crewrun-plugin-sdk/index.js";

function slackPlugin(overrides = {}) {
  return defineIntegrationPlugin({
    id: "slack",
    label: "Slack",
    description: "Governed Slack messages.",
    oauth: {
      authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
      tokenEndpoint: "https://slack.com/api/oauth.v2.access",
      defaultScopes: ["chat:write", "app_mentions:read"],
      pkce: "required",
      authorizationParams: { prompt: "consent" }
    },
    capabilities: [
      { id: "messages", label: "Messages", direction: "both", scopes: ["chat:write"] }
    ],
    actions: [
      {
        id: "slack.postMessage",
        capability: "messages",
        label: "Post message",
        description: "Post a message after approval.",
        risk: "external-write",
        approval: "none",
        scopes: ["chat:write"],
        inputSchema: (z) => ({ text: z.string() }),
        validate: (input = {}) => typeof input.text === "string"
          ? { ok: true, input: { text: input.text } }
          : { ok: false, error: "text is required" }
      }
    ],
    events: [
      {
        id: "slack.appMention",
        capability: "messages",
        label: "App mention",
        scopes: ["app_mentions:read"]
      }
    ],
    subscription: { delivery: "webhook", renewal: "none" },
    metadata: { setup: "Create a Slack app first." },
    adapter: {
      authorizationUrl: () => "host-only",
      exchangeCode: async () => ({ accessToken: "never-public" }),
      verifyWebhook: async ({ headers }) => headers["x-slack-signature"] === "valid",
      normalizeEvent: (delivery) => ({
        id: delivery.eventId,
        type: "slack.appMention",
        connectionId: delivery.connectionId,
        occurredAt: delivery.occurredAt,
        metadata: { channel: delivery.channel, text: delivery.text }
      })
    },
    ...overrides
  });
}

test("a plugin contract is versioned, immutable, and forces approval for external writes", () => {
  const plugin = slackPlugin();
  assert.equal(plugin.apiVersion, INTEGRATION_PLUGIN_API_VERSION);
  assert.equal(plugin.actions[0].risk, "external-write");
  assert.equal(plugin.actions[0].approval, "required");
  assert.equal(plugin.actions[0].read, false);
  assert.deepEqual(plugin.actions[0].scopeSets, [["chat:write"]]);
  assert.ok(Object.isFrozen(plugin));
  assert.ok(Object.isFrozen(plugin.actions));
  assert.equal(typeof plugin.adapter.exchangeCode, "function");

  assert.throws(() => defineIntegrationPlugin({
    id: "slack",
    label: "Slack",
    capabilities: [{ id: "messages", label: "Messages" }],
    actions: [{ id: "slack.postMessage", capability: "missing", label: "Post" }],
    events: []
  }), /unknown capability/);
  assert.throws(() => defineIntegrationPlugin({
    id: "slack",
    label: "Slack",
    capabilities: [{ id: "messages", label: "Messages" }],
    actions: [],
    events: [{ id: "other.appMention", capability: "messages", label: "Mention" }]
  }), /invalid integration event id/);
  assert.throws(() => defineIntegrationPlugin({
    id: "slack",
    label: "Slack",
    capabilities: [{ id: "messages", label: "Messages" }],
    actions: [{ id: "slack.postMessage", capability: "messages", label: "Post" }],
    events: []
  }), /needs inputSchema and validate functions/);
});

test("the manifest does not retain credential fields and public registry data excludes adapters", () => {
  const plugin = slackPlugin({
    clientSecret: "discarded"
  });
  assert.equal(plugin.clientSecret, undefined);

  const registry = createPluginRegistry({ plugins: [plugin] });
  const publicPlugin = registry.list()[0];
  assert.equal(publicPlugin.adapter, undefined);
  assert.doesNotMatch(JSON.stringify(publicPlugin), /accessToken|refreshToken|clientSecret|credential/i);
  assert.equal(typeof registry.get("slack").adapter.exchangeCode, "function", "runtime adapter remains host-only");
  assert.throws(() => defineIntegrationPlugin({
    id: "slack",
    label: "Slack",
    capabilities: [],
    actions: [],
    events: [],
    metadata: { accessToken: "not allowed" }
  }), /credential field/i);
});

test("v6 rejects top-level runtime hooks instead of normalizing legacy plugins", () => {
  assert.throws(() => defineIntegrationPlugin({
    id: "old-plugin", label: "Old plugin", capabilities: [], actions: [], events: [],
    invoke: async () => ({})
  }), /hooks belong in adapter/);
});

test("OAuth URL construction requires host-issued state and PKCE without exposing a verifier", () => {
  const plugin = slackPlugin();
  const url = new URL(oauthAuthorizationUrl({
    plugin,
    clientId: "public-client-id",
    redirectUri: "https://crew.example.test/integrations/slack/callback",
    state: "one-time-host-state",
    codeChallenge: "s256-public-challenge"
  }));
  assert.equal(url.origin, "https://slack.com");
  assert.equal(url.searchParams.get("client_id"), "public-client-id");
  assert.equal(url.searchParams.get("state"), "one-time-host-state");
  assert.equal(url.searchParams.get("code_challenge"), "s256-public-challenge");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.throws(() => oauthAuthorizationUrl({
    plugin,
    clientId: "public-client-id",
    redirectUri: "http://crew.example.test/callback",
    state: "one-time-host-state",
    codeChallenge: "s256-public-challenge"
  }), /https or a loopback/);
  assert.throws(() => oauthAuthorizationUrl({
    plugin,
    clientId: "public-client-id",
    redirectUri: "https://crew.example.test/callback",
    state: "one-time-host-state"
  }), /codeChallenge is required/);

  const metadata = providerOAuthMetadata(plugin);
  assert.doesNotMatch(JSON.stringify(metadata), /accessToken|refreshToken|clientSecret|credential/i);
});

test("connection and event helpers only publish normalized metadata", () => {
  const connection = connectionMetadata({
    id: "slack-main",
    provider: "slack",
    status: "connected",
    account: { id: "T1", label: "Crew workspace", email: "crew@example.test", accessToken: "hidden" },
    scopes: ["chat:write", "app_mentions:read"],
    capabilities: ["messages"],
    refreshToken: "hidden",
    secretRef: "vault/slack-main"
  });
  assert.deepEqual(connection, {
    id: "slack-main",
    provider: "slack",
    status: "connected",
    account: { id: "T1", label: "Crew workspace", email: "crew@example.test" },
    scopes: ["chat:write", "app_mentions:read"],
    capabilities: ["messages"]
  });
  assert.doesNotMatch(JSON.stringify(connection), /token|secret|vault/i);

  const event = normalizeIntegrationEvent({
    id: "Ev-001",
    provider: "slack",
    type: "slack.appMention",
    connectionId: "slack-main",
    occurredAt: "2026-09-08T12:00:00.000Z",
    receivedAt: "2026-09-08T12:00:01.000Z",
    subject: { id: "C1", label: "#general", url: "https://app.slack.com/client/T1/C1" },
    metadata: { channel: "C1", text: "please help" },
    headers: { authorization: "not copied" },
    rawBody: "not copied",
    payload: { token: "not copied" }
  });
  assert.deepEqual(event, {
    id: "Ev-001",
    provider: "slack",
    type: "slack.appMention",
    connectionId: "slack-main",
    occurredAt: "2026-09-08T12:00:00.000Z",
    receivedAt: "2026-09-08T12:00:01.000Z",
    subject: { id: "C1", label: "#general", url: "https://app.slack.com/client/T1/C1" },
    metadata: { channel: "C1", text: "please help" }
  });
  assert.equal(eventReceiptKey(event), "slack:slack-main:Ev-001");
  assert.doesNotMatch(JSON.stringify(event), /authorization|rawbody|payload|token/i);
  assert.throws(() => normalizeIntegrationEvent({
    id: "Ev-002",
    provider: "slack",
    type: "slack.appMention",
    connectionId: "slack-main",
    occurredAt: "2026-09-08T12:00:00.000Z",
    metadata: { refreshToken: "not allowed" }
  }), /credential field/i);
  assert.throws(() => normalizeIntegrationEvent({
    id: "Ev-003",
    provider: "slack",
    type: "slack.appMention",
    connectionId: "slack-main",
    occurredAt: "2026-09-08T12:00:00.000Z",
    metadata: { providerToken: "not allowed" }
  }), /credential field/i);
});

test("event metadata redacts credential-like values and strips URL query strings", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.signaturevalue123456";
  const event = normalizeIntegrationEvent({
    id: "Ev-004",
    provider: "slack",
    type: "slack.appMention",
    connectionId: "slack-main",
    occurredAt: "2026-09-08T12:00:00.000Z",
    subject: { id: "C1", label: "Bearer abcdefghijklmnopqrstuvwxyz", url: "https://app.example.test/channels/C1?access_token=subject-private#access_token=fragment-private" },
    metadata: {
      note: "Bearer abcdefghijklmnopqrstuvwxyz",
      opaqueValue: jwt,
      link: "https://docs.example.test/files/1?share=metadata-private#section",
      message: "Open https://docs.example.test/files/2?code=embedded-private#heading",
      normal: "plain event metadata"
    }
  });
  assert.equal(event.subject.url, "https://app.example.test/channels/C1");
  assert.equal(event.subject.label, "[redacted]");
  assert.equal(event.metadata.note, "[redacted]");
  assert.equal(event.metadata.opaqueValue, "[redacted]");
  assert.equal(event.metadata.link, "https://docs.example.test/files/1#section");
  assert.equal(event.metadata.message, "Open https://docs.example.test/files/2#heading");
  assert.equal(event.metadata.normal, "plain event metadata");
  assert.doesNotMatch(JSON.stringify(event), /subject-private|fragment-private|metadata-private|embedded-private|eyJhbGci/i);
});

test("a registry indexes provider contracts, normalizes declared events, and delegates webhook verification", async () => {
  const registry = createPluginRegistry({ plugins: [slackPlugin()] });
  assert.deepEqual(registry.actions().map((action) => action.id), ["slack.postMessage"]);
  assert.deepEqual(registry.events().map((event) => event.id), ["slack.appMention"]);
  assert.equal(registry.action("slack.postMessage").validate, undefined, "validation hooks are not console metadata");
  const url = new URL(registry.authorizationUrl("slack", {
    clientId: "client",
    redirectUri: "http://127.0.0.1:4402/callback",
    state: "state",
    codeChallenge: "challenge"
  }));
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:4402/callback");
  assert.equal(await registry.verifyWebhook("slack", { headers: { "x-slack-signature": "valid" } }), true);
  assert.equal(await registry.verifyWebhook("slack", { headers: { "x-slack-signature": "wrong" } }), false);

  const event = registry.normalizeEvent("slack", {
    eventId: "Ev-003",
    connectionId: "slack-main",
    occurredAt: "2026-09-08T12:00:00Z",
    channel: "C1",
    text: "hello"
  });
  assert.equal(event.type, "slack.appMention");
  assert.deepEqual(event.metadata, { channel: "C1", text: "hello" });
  const rawRegistry = createPluginRegistry({ plugins: [slackPlugin({ adapter: null })] });
  assert.throws(() => rawRegistry.normalizeEvent("slack", {
    id: "Ev-004",
    type: "slack.unknownEvent",
    connectionId: "slack-main",
    occurredAt: "2026-09-08T12:00:00Z"
  }), /not declared/);
});
