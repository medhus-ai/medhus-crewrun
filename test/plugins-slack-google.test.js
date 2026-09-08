import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { createPluginRegistry } from "../packages/crewrun-plugin-sdk/index.js";
import { createGoogleOidcVerifier, createGoogleWorkspacePlugin, validateMailDraft } from "../packages/crewrun-plugin-google-workspace/src/index.js";
import { createSlackPlugin } from "../packages/crewrun-plugin-slack/src/index.js";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const GMAIL_PUSH_SERVICE_ACCOUNT = "crewrun-push@example.iam.gserviceaccount.com";

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function slackRequest(payload, secret = "slack-signing-secret") {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(NOW / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return { rawBody, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } };
}

function signedGoogleOidcToken({ privateKey, kid, audience = "https://crew.example", issuedAt = Math.floor(NOW / 1000), expiresAt = Math.floor(NOW / 1000) + 3600, notBefore, issuer = "https://accounts.google.com", email = GMAIL_PUSH_SERVICE_ACCOUNT, emailVerified = true } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, iat: issuedAt, exp: expiresAt, email, email_verified: emailVerified, ...(notBefore == null ? {} : { nbf: notBefore }) })).toString("base64url");
  const signed = `${header}.${claims}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
}

function jwksResponse(keys, cacheControl = "public, max-age=600") {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => String(name).toLowerCase() === "cache-control" ? cacheControl : null },
    json: async () => ({ keys })
  };
}

test("Slack exposes a public manifest, keeps OAuth credentials private, and normalizes only signed metadata events", async () => {
  const plugin = createSlackPlugin();
  const registry = createPluginRegistry({ plugins: [plugin] });
  const publicManifest = registry.list()[0];
  assert.deepEqual(publicManifest.actions.map((action) => action.id), ["slack.getThread", "slack.postMessage", "slack.replyToMention"]);
  assert.equal("adapter" in publicManifest, false, "adapter functions never cross the public manifest boundary");
  assert.doesNotMatch(JSON.stringify(publicManifest), /xoxb-|slack-signing-secret|client-secret|refresh-private/i);
  assert.equal(publicManifest.subscription.endpoint, "/integrations/webhooks/slack");

  const authorize = await plugin.adapter.authorizationUrl({
    clientId: "client-id", redirectUri: "https://crew.example/integrations/oauth/slack/callback", state: "one-time-state", codeChallenge: "host-generated-but-not-used", capabilities: ["mentions"]
  });
  const url = new URL(authorize);
  assert.equal(url.origin, "https://slack.com");
  assert.equal(url.searchParams.get("scope"), "chat:write,app_mentions:read");
  assert.equal(url.searchParams.has("code_challenge"), false, "Slack v2 uses confidential-client exchange rather than PKCE");

  const exchange = await plugin.adapter.exchangeCode({
    code: "code", redirectUri: "https://crew.example/integrations/oauth/slack/callback", clientId: "client-id", clientSecret: "client-secret",
    fetch: async () => response({ ok: true, access_token: "xoxb-private", refresh_token: "refresh-private", scope: "chat:write,app_mentions:read", team: { id: "T1", name: "Test team" } })
  });
  assert.deepEqual(exchange.account, { id: "T1", label: "Test team" });
  assert.equal(exchange.credentials.accessToken, "xoxb-private", "only the host OAuth exchange receives credentials");
  const refreshed = await plugin.adapter.refreshCredentials({
    credentials: exchange.credentials, config: { clientId: "client-id", clientSecret: "client-secret" },
    fetch: async () => response({ ok: true, access_token: "xoxb-refreshed", refresh_token: "refresh-next", scope: "chat:write" })
  });
  assert.equal(refreshed.credentials.accessToken, "xoxb-refreshed");

  const calls = [];
  const posted = await plugin.adapter.invoke({
    action: "slack.postMessage", input: { channel: "C123", text: "hello" }, credentials: { accessToken: "xoxb-private" },
    fetch: async (...args) => { calls.push(args); return response({ ok: true, channel: "C123", ts: "1.2" }); }
  });
  assert.deepEqual(posted, { channel: "C123", messageTs: "1.2", threadTs: "1.2" });
  assert.equal(calls[0][0], "https://slack.com/api/chat.postMessage");
  assert.doesNotMatch(JSON.stringify(posted), /xoxb|private/i);

  const mention = slackRequest({
    type: "event_callback", event_id: "Ev1", event_time: Math.floor(NOW / 1000), team_id: "T1",
    event: { type: "app_mention", user: "U1", channel: "C123", ts: "1.2", text: "<@B1> this must not persist" }
  });
  const verified = await plugin.adapter.verifyWebhook({
    ...mention, connectionId: "slack-1", now: NOW, config: { signingSecret: "slack-signing-secret" }
  });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.events[0], {
    connectionId: "slack-1", providerEventId: "Ev1", type: "slack.appMention",
    resource: { id: "C123", label: "Slack channel" },
    summary: { workspaceId: "T1", channelId: "C123", messageTs: "1.2", threadTs: "1.2", senderId: "U1" },
    occurredAt: new Date(NOW).toISOString()
  });
  assert.doesNotMatch(JSON.stringify(verified.events), /must not persist/);

  const handshake = slackRequest({ type: "url_verification", challenge: "challenge" });
  assert.deepEqual(
    await plugin.adapter.verifyWebhook({ ...handshake, now: NOW, config: { signingSecret: "slack-signing-secret" } }),
    { ok: true, challenge: "challenge", contentType: "text/plain; charset=utf-8", events: [] }
  );
  assert.equal((await plugin.adapter.verifyWebhook({ ...mention, connectionId: "slack-1", now: NOW, config: { signingSecret: "wrong" } })).ok, false);
});

test("Google Workspace limits OAuth capabilities, returns sanitized tools, and verifies Gmail and Drive deliveries", async () => {
  const plugin = createGoogleWorkspacePlugin();
  const adapter = plugin.adapter;
  const authorize = await adapter.authorizationUrl({
    clientId: "google-client", redirectUri: "https://crew.example/integrations/oauth/google-workspace/callback", state: "one-time-state", codeChallenge: "challenge", capabilities: ["gmail-read", "drive"]
  });
  const url = new URL(authorize);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope"), /gmail\.readonly/);
  assert.match(url.searchParams.get("scope"), /drive\.metadata\.readonly/);
  assert.doesNotMatch(url.searchParams.get("scope"), /documents/);

  const oauthCalls = [];
  const exchange = await adapter.exchangeCode({
    code: "code", verifier: "verifier", redirectUri: "https://crew.example/integrations/oauth/google-workspace/callback", clientId: "google-client", clientSecret: "google-secret",
    fetch: async (request) => {
      oauthCalls.push(String(request));
      return oauthCalls.length === 1
        ? response({ access_token: "google-private", refresh_token: "google-refresh", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/gmail.readonly" })
        : response({ sub: "google-user", email: "user@example.test", name: "Test User" });
    }
  });
  assert.deepEqual(exchange.account, { id: "google-user", label: "Test User", email: "user@example.test" });
  assert.equal(exchange.credentials.accessToken, "google-private");
  const refreshed = await adapter.refreshCredentials({
    credentials: exchange.credentials, config: { clientId: "google-client", clientSecret: "google-secret" },
    fetch: async () => response({ access_token: "google-refreshed", expires_in: 3600, scope: "openid email" })
  });
  assert.equal(refreshed.credentials.accessToken, "google-refreshed");
  assert.equal(refreshed.credentials.refreshToken, "google-refresh");

  const driveCalls = [];
  const searched = await adapter.invoke({
    action: "google-workspace.searchDrive", input: { query: "quarterly plan", maxResults: 2 }, credentials: { accessToken: "google-private" },
    fetch: async (request) => { driveCalls.push(String(request)); return response({ files: [{ id: "file_1", name: "Plan", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-08T00:00:00Z", webViewLink: "https://docs.google.test/file_1" }] }); }
  });
  assert.deepEqual(searched, { files: [{ id: "file_1", name: "Plan", mimeType: "application/vnd.google-apps.document", modifiedAt: "2026-09-08T00:00:00Z", url: "https://docs.google.test/file_1" }] });
  assert.match(driveCalls[0], /fullText/);
  assert.doesNotMatch(JSON.stringify(searched), /google-private/);
  assert.equal(validateMailDraft({ to: ["person@example.test"], subject: "ok\nBcc: hidden", text: "body" }).ok, false);

  const mailbox = Buffer.from(JSON.stringify({ emailAddress: "user@example.test", historyId: "42" })).toString("base64url");
  const gmail = await adapter.verifyWebhook({
    rawBody: JSON.stringify({ message: { messageId: "pubsub-1", data: mailbox, publishTime: "2026-09-08T12:00:00.000Z" } }),
    headers: { authorization: "Bearer signed-oidc" },
    config: {
      gmailPushAudience: "https://crew.example", gmailPushServiceAccount: GMAIL_PUSH_SERVICE_ACCOUNT,
      verifyOidcToken: async ({ token, audience, serviceAccountEmail }) => token === "signed-oidc" && audience === "https://crew.example" && serviceAccountEmail === GMAIL_PUSH_SERVICE_ACCOUNT
    }
  });
  assert.deepEqual(gmail.events[0], {
    accountId: "user@example.test", providerEventId: "gmail:pubsub-1", type: "google-workspace.gmailMailboxChanged",
    resource: { id: "user@example.test", label: "Gmail mailbox" }, summary: { historyId: "42", emailAddress: "user@example.test" }, occurredAt: "2026-09-08T12:00:00.000Z"
  });

  const drive = await adapter.verifyWebhook({
    connectionId: "google-workspace-1", headers: {
      "x-goog-channel-id": "channel-1", "x-goog-channel-token": "drive-secret", "x-goog-resource-id": "resource-1",
      "x-goog-resource-state": "change", "x-goog-message-number": "7"
    },
    config: { driveChannelId: "channel-1", driveChannelToken: "drive-secret" }
  });
  assert.equal(drive.ok, true);
  assert.equal(drive.events[0].providerEventId, "drive:channel-1:7");
  assert.doesNotMatch(JSON.stringify(drive.events), /drive-secret/);
});

test("Google Drive watch subscriptions are private host records and use a connection-specific callback", async () => {
  const plugin = createGoogleWorkspacePlugin();
  const calls = [];
  const subscriptions = await plugin.adapter.subscribe({
    credentials: { accessToken: "google-private" }, connection: { id: "google-workspace-1", account: { id: "google-user" } }, publicBaseUrl: "https://crew.example",
    config: { driveEvents: true }, fetch: async (request, options) => {
      calls.push([String(request), options]);
      return calls.length === 1 ? response({ startPageToken: "page-1" }) : response({ id: "channel-1", resourceId: "resource-1", expiration: String(NOW + 86_400_000) });
    }
  });
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].providerKey, "google-workspace.driveChanged");
  assert.equal(subscriptions[0].metadata.channelId, "channel-1");
  assert.match(calls[1][1].body, /integrations\/webhooks\/google-workspace\/google-workspace-1/);
  assert.doesNotMatch(JSON.stringify({ metadata: subscriptions[0].metadata }), /secret|token|google-private/i);
});

test("Provider subscription lifecycle uses host arrays, rotates Drive watches, and stops remote watches on disconnect", async () => {
  const slack = createSlackPlugin();
  assert.deepEqual(await slack.adapter.subscribe({ webhookUrl: "https://crew.example/slack" }), []);
  assert.deepEqual(await slack.adapter.renew({ subscription: { id: "not-persisted" } }), []);

  const google = createGoogleWorkspacePlugin();
  const previousDrive = {
    id: "drive-google-workspace-1",
    providerKey: "google-workspace.driveChanged",
    resource: { kind: "drive" },
    metadata: { channelId: "old-channel", resourceId: "old-resource" },
    secret: { channelToken: "old-private-token", startPageToken: "old-page" }
  };
  const renewalCalls = [];
  const renewed = await google.adapter.renew({
    subscription: previousDrive,
    credentials: { accessToken: "google-private" },
    connection: { id: "google-workspace-1" },
    publicBaseUrl: "https://crew.example",
    config: { driveEvents: true },
    fetch: async (request, options = {}) => {
      const url = String(request);
      renewalCalls.push({ url, options });
      if (url.includes("/changes/startPageToken")) return response({ startPageToken: "next-page" });
      if (url.includes("/changes/watch")) {
        const body = JSON.parse(options.body);
        return response({ id: body.id, resourceId: "new-resource", expiration: String(NOW + 86_400_000) });
      }
      if (url.includes("/channels/stop")) return response({});
      throw new Error(`unexpected Google renewal request: ${url}`);
    }
  });
  assert.equal(renewed.length, 1, "renewal returns the host's subscription-array contract");
  assert.notEqual(renewed[0].metadata.channelId, "old-channel");
  assert.notEqual(renewed[0].secret.channelToken, "old-private-token");
  const oldStop = renewalCalls.find((call) => call.url.includes("/drive/v3/channels/stop"));
  assert.deepEqual(JSON.parse(oldStop.options.body), { id: "old-channel", resourceId: "old-resource" });

  const gmailSubscriptions = await google.adapter.subscribe({
    kind: "gmail-pubsub-watch",
    credentials: { accessToken: "google-private" },
    connection: { id: "google-workspace-1", account: { id: "google-user" }, capabilities: ["gmail-read"] },
    config: { gmailPubsubTopic: "projects/test/topics/crewrun-mail", gmailLabelIds: ["INBOX"] },
    fetch: async () => response({ historyId: "10", expiration: String(NOW + 86_400_000) })
  });
  assert.deepEqual(gmailSubscriptions[0].metadata.labelIds, ["INBOX"]);
  let renewedGmailBody = null;
  await google.adapter.renew({
    subscription: gmailSubscriptions[0], credentials: { accessToken: "google-private" }, connection: { id: "google-workspace-1" }, config: {},
    fetch: async (_request, options = {}) => {
      renewedGmailBody = JSON.parse(options.body);
      return response({ historyId: "11", expiration: String(NOW + 86_400_000) });
    }
  });
  assert.deepEqual(renewedGmailBody.labelIds, ["INBOX"], "renewal preserves the originally watched Gmail labels");

  let unrelatedWatchCalls = 0;
  assert.deepEqual(await google.adapter.subscribe({
    credentials: { accessToken: "google-private" }, connection: { id: "google-workspace-1", capabilities: ["gmail-send"] }, config: { driveEvents: true },
    fetch: async () => { unrelatedWatchCalls += 1; return response({}); }
  }), []);
  assert.equal(unrelatedWatchCalls, 0, "a connection without an event capability does not request unrelated provider watches");

  const revokeCalls = [];
  const revoked = await google.adapter.revoke({
    credentials: { accessToken: "google-private", refreshToken: "google-refresh-private" },
    subscriptions: [gmailSubscriptions[0], previousDrive],
    fetch: async (request, options = {}) => {
      revokeCalls.push({ url: String(request), options });
      return response({});
    }
  });
  assert.equal(revoked.revoked, true);
  assert.ok(revokeCalls.some((call) => call.url.includes("/gmail/v1/users/me/stop")));
  assert.ok(revokeCalls.some((call) => call.url.includes("/drive/v3/channels/stop")));
  const revokeCall = revokeCalls.find((call) => call.url === "https://oauth2.googleapis.com/revoke");
  assert.match(revokeCall.options.body, /token=google-refresh-private/);
  assert.doesNotMatch(JSON.stringify(revoked), /google-(?:private|refresh-private)/);
});

test("Google Pub/Sub OIDC uses Google JWKS by default, honors token claims, refreshes rotated keys, and permits an explicit verifier override", async () => {
  const first = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const second = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const firstJwk = { ...first.publicKey.export({ format: "jwk" }), kid: "google-key-1", use: "sig", alg: "RS256" };
  const secondJwk = { ...second.publicKey.export({ format: "jwk" }), kid: "google-key-2", use: "sig", alg: "RS256" };
  let jwksCalls = 0;
  const fetchJwks = async (url, options) => {
    jwksCalls += 1;
    assert.equal(String(url), "https://keys.example.test/google");
    assert.equal(options.redirect, "error");
    return jwksResponse(jwksCalls === 1 ? [firstJwk] : [firstJwk, secondJwk]);
  };
  const verifier = createGoogleOidcVerifier({ fetch: fetchJwks, now: () => NOW, jwksUrl: "https://keys.example.test/google" });
  const firstToken = signedGoogleOidcToken({ privateKey: first.privateKey, kid: "google-key-1" });
  assert.deepEqual(await verifier({ token: firstToken, audience: "https://crew.example" }), { ok: true });
  assert.deepEqual(await verifier({ token: firstToken, audience: "https://crew.example" }), { ok: true });
  assert.equal(jwksCalls, 1, "fresh official keys are cached");
  assert.deepEqual(await verifier({ token: firstToken, audience: "https://wrong.example" }), { ok: false });
  assert.deepEqual(await verifier({ token: signedGoogleOidcToken({ privateKey: first.privateKey, kid: "google-key-1", expiresAt: Math.floor(NOW / 1000) - 301 }), audience: "https://crew.example" }), { ok: false });
  assert.deepEqual(await verifier({ token: signedGoogleOidcToken({ privateKey: first.privateKey, kid: "google-key-1", notBefore: Math.floor(NOW / 1000) + 301 }), audience: "https://crew.example" }), { ok: false });
  assert.deepEqual(await verifier({ token: signedGoogleOidcToken({ privateKey: second.privateKey, kid: "google-key-2" }), audience: "https://crew.example" }), { ok: true });
  assert.equal(jwksCalls, 2, "an unknown kid causes one conservative refresh");

  const mailbox = Buffer.from(JSON.stringify({ emailAddress: "user@example.test", historyId: "99" })).toString("base64url");
  const plugin = createGoogleWorkspacePlugin({ now: () => NOW });
  let defaultFetchCalls = 0;
  const defaultVerified = await plugin.adapter.verifyWebhook({
    rawBody: JSON.stringify({ message: { messageId: "pubsub-built-in", data: mailbox, publishTime: "2026-09-08T12:00:00.000Z" } }),
    headers: { authorization: `Bearer ${firstToken}` },
    config: { gmailPushAudience: "https://crew.example", gmailPushServiceAccount: GMAIL_PUSH_SERVICE_ACCOUNT },
    fetch: async (url) => {
      defaultFetchCalls += 1;
      assert.equal(String(url), "https://www.googleapis.com/oauth2/v3/certs");
      return jwksResponse([firstJwk]);
    }
  });
  assert.equal(defaultVerified.ok, true);
  assert.equal(defaultFetchCalls, 1, "the adapter forwards its request fetch to the built-in verifier");

  const wrongPushIdentity = await plugin.adapter.verifyWebhook({
    rawBody: JSON.stringify({ message: { messageId: "pubsub-wrong-identity", data: mailbox, publishTime: "2026-09-08T12:00:00.000Z" } }),
    headers: { authorization: `Bearer ${firstToken}` },
    config: { gmailPushAudience: "https://crew.example", gmailPushServiceAccount: "other-push@example.iam.gserviceaccount.com" },
    fetch: async () => jwksResponse([firstJwk])
  });
  assert.equal(wrongPushIdentity.ok, false, "a valid Google token from another configured service account is rejected");

  let overrideCalled = false;
  const overridden = await plugin.adapter.verifyWebhook({
    rawBody: JSON.stringify({ message: { messageId: "pubsub-override", data: mailbox, publishTime: "2026-09-08T12:00:00.000Z" } }),
    headers: { authorization: "Bearer opaque-test-token" },
    config: {
      gmailPushAudience: "https://crew.example",
      gmailPushServiceAccount: GMAIL_PUSH_SERVICE_ACCOUNT,
      verifyOidcToken: async ({ token, audience, serviceAccountEmail }) => {
        overrideCalled = token === "opaque-test-token" && audience === "https://crew.example" && serviceAccountEmail === GMAIL_PUSH_SERVICE_ACCOUNT;
        return overrideCalled;
      }
    },
    fetch: async () => { throw new Error("the configured verifier must override the default"); }
  });
  assert.equal(overridden.ok, true);
  assert.equal(overrideCalled, true);
});
