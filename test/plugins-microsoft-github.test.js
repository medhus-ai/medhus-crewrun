import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createPluginRegistry } from "../packages/crewrun-plugin-sdk/index.js";
import { createConnectorRegistry } from "../src/connectors.js";
import {
  createMicrosoft365Adapter,
  createMicrosoft365Plugin,
  invokeMicrosoft365Action,
  microsoftScopesForCapabilities,
  validateMicrosoftAction,
  verifyMicrosoft365Webhook
} from "../packages/crewrun-plugin-microsoft-365/src/index.js";
import {
  createGitHubAdapter,
  createGitHubPlugin,
  signGitHubAppJwt,
  validateGitHubAction,
  verifyGitHubWebhook
} from "../packages/crewrun-plugin-github/src/index.js";

function jsonResponse(value, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => value,
    text: async () => JSON.stringify(value)
  };
}

test("Microsoft 365 manifest exposes narrow governed capabilities without provider credentials", () => {
  const plugin = createMicrosoft365Plugin();
  const registry = createPluginRegistry({ plugins: [plugin] });
  const actions = registry.actions();
  assert.deepEqual(actions.filter((action) => action.risk === "external-write").map((action) => action.id), [
    "microsoft365.createMailDraft",
    "microsoft365.sendMailDraft",
    "microsoft365.createTextFile",
    "microsoft365.updateWorkbookRange",
    "microsoft365.postTeamsChannelMessage"
  ]);
  assert.ok(actions.some((action) => action.id === "microsoft365.getWorkbookRange"));
  assert.ok(actions.some((action) => action.id === "microsoft365.listTeamsChannelMessages"));
  assert.ok(actions.filter((action) => action.risk === "external-write").every((action) => action.approval === "required"));
  const publicPlugin = registry.list()[0];
  assert.equal(publicPlugin.adapter, undefined);
  assert.doesNotMatch(JSON.stringify(publicPlugin), /accessToken|refreshToken|clientSecret|credentialRef/i);
  assert.equal(publicPlugin.subscription.webhookPath, "/integrations/webhooks/microsoft365/{connectionId}");
});

test("Microsoft 365 action validators retain only bounded input fields", () => {
  const update = validateMicrosoftAction("microsoft365.updateWorkbookRange", {
    itemId: "drive-item-1",
    worksheet: "Overview",
    range: "A1:B2",
    values: [["one", 2], [true, null]],
    accessToken: "model-secret",
    request: { method: "DELETE" }
  });
  assert.deepEqual(update, {
    ok: true,
    input: { itemId: "drive-item-1", worksheet: "Overview", range: "A1:B2", values: [["one", 2], [true, null]] }
  });
  assert.equal(validateMicrosoftAction("microsoft365.createTextFile", { parentItemId: "p", name: "../../danger", content: "no" }).ok, false);
  assert.equal(validateMicrosoftAction("microsoft365.updateWorkbookRange", { itemId: "p", worksheet: "A", range: "not-a-range", values: [[1]] }).ok, false);
  assert.equal(validateMicrosoftAction("microsoft365.updateWorkbookRange", { itemId: "p", worksheet: "A", range: "A1", values: [["=IMPORTXML(\"https://untrusted.example\")"]] }).ok, false);
});

test("Microsoft capability selection becomes the corresponding OAuth scope set", async () => {
  assert.deepEqual(microsoftScopesForCapabilities(["outlook"]), [
    "openid", "profile", "offline_access", "User.Read", "Mail.Read", "Mail.ReadWrite", "Mail.Send"
  ]);
  const adapter = createMicrosoft365Adapter({ clientId: "microsoft-client" });
  const url = new URL(await adapter.authorizationUrl({
    redirectUri: "https://crew.example.test/integrations/oauth/microsoft365/callback",
    state: "one-time-state",
    codeChallenge: "public-pkce-challenge",
    capabilities: ["onedrive", "excel"]
  }));
  const scopes = new Set(url.searchParams.get("scope").split(" "));
  assert.ok(scopes.has("Files.Read"));
  assert.ok(scopes.has("Files.ReadWrite"));
  assert.ok(!scopes.has("Mail.Read"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("Microsoft Graph webhook challenge and per-subscription clientState verification produce metadata-only events", () => {
  assert.deepEqual(verifyMicrosoft365Webhook({ query: { validationToken: "graph-challenge" } }), {
    ok: true,
    kind: "validation",
    events: [],
    challenge: "graph-challenge",
    contentType: "text/plain; charset=utf-8"
  });

  const rawBody = JSON.stringify({
    value: [{
      subscriptionId: "subscription-1",
      clientState: "host-secret-state",
      resource: "/me/mailFolders('Inbox')/messages/message-1",
      changeType: "created",
      resourceData: { id: "message-1", subject: "this raw subject is not forwarded" },
      tenantId: "tenant-1"
    }]
  });
  const accepted = verifyMicrosoft365Webhook({
    rawBody,
    connectionId: "microsoft365-main",
    resolveClientState: (subscriptionId) => subscriptionId === "subscription-1" ? "host-secret-state" : ""
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.events.length, 1);
  assert.deepEqual(accepted.events[0].resource, {
    subscriptionId: "subscription-1",
    resource: "/me/mailFolders('Inbox')/messages/message-1",
    resourceId: "message-1"
  });
  assert.equal(accepted.events[0].type, "microsoft365.outlookMessageCreated");
  assert.doesNotMatch(JSON.stringify(accepted.events[0]), /host-secret-state|clientState|raw subject/i);
  assert.equal(verifyMicrosoft365Webhook({ rawBody, resolveClientState: () => "wrong" }).ok, false);

  const adapter = createMicrosoft365Adapter();
  const throughState = adapter.verifyWebhook({
    rawBody,
    connectionId: "microsoft365-main",
    state: { getSubscriptionSecret: ({ subscriptionId }) => subscriptionId === "subscription-1" ? { secret: "host-secret-state" } : null }
  });
  assert.equal(throughState.ok, true, "adapter uses the host's encrypted subscription-state resolver");
});

test("Microsoft Graph calls use injected fetch and a private access-token resolver", async () => {
  let request;
  const result = await invokeMicrosoft365Action({
    action: "microsoft365.getMail",
    connectionId: "microsoft365-main",
    input: { messageId: "message-1", ignored: "not passed through" },
    accessTokenFor: async () => "private-access-token",
    fetch: async (url, options) => {
      request = { url: String(url), options };
      return jsonResponse({ id: "message-1", subject: "Visible only through the authorized read tool" });
    }
  });
  assert.match(request.url, /\/v1\.0\/me\/messages\/message-1/);
  assert.equal(request.options.headers.authorization, "Bearer private-access-token");
  assert.deepEqual(result, { id: "message-1", subject: "Visible only through the authorized read tool" });
  assert.doesNotMatch(JSON.stringify(result), /private-access-token/i);
});

test("Microsoft Graph rejects an untrusted base URL before resolving or sending a bearer token", async () => {
  let tokenLookups = 0;
  let fetches = 0;
  await assert.rejects(invokeMicrosoft365Action({
    action: "microsoft365.getMail",
    connectionId: "microsoft365-main",
    input: { messageId: "message-1" },
    graphUrl: "https://attacker.example.test/v1.0",
    accessTokenFor: async () => { tokenLookups += 1; return "private-access-token"; },
    fetch: async () => { fetches += 1; return jsonResponse({}); }
  }), /Microsoft Graph URL must be https:\/\/graph\.microsoft\.com\/v1\.0/);
  assert.equal(tokenLookups, 0);
  assert.equal(fetches, 0);
});

test("Microsoft OneDrive text-file creation fails on conflicts instead of overwriting an existing item", async () => {
  const calls = [];
  await invokeMicrosoft365Action({
    action: "microsoft365.createTextFile",
    connectionId: "microsoft365-main",
    input: { parentItemId: "parent-1", name: "new-note.txt", content: "approved plain text" },
    accessTokenFor: async () => "private-access-token",
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return calls.length === 1
        ? jsonResponse({ id: "new-item-1" })
        : jsonResponse({ id: "new-item-1", name: "new-note.txt" });
    }
  });
  assert.match(calls[0].url, /\/me\/drive\/items\/parent-1\/children$/);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    name: "new-note.txt", file: {}, "@microsoft.graph.conflictBehavior": "fail"
  });
  assert.match(calls[1].url, /\/me\/drive\/items\/new-item-1\/content$/);
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(calls[1].options.body, "approved plain text");
});

test("Microsoft subscriptions store a per-subscription state secret for the encrypted host vault", async () => {
  let request;
  const adapter = createMicrosoft365Adapter({
    fetch: async (url, options) => {
      request = { url: String(url), options };
      return jsonResponse({
        id: "graph-subscription-1",
        resource: "/me/mailFolders('Inbox')/messages",
        changeType: "created",
        expirationDateTime: new Date(Date.now() + 30 * 60_000).toISOString()
      });
    }
  });
  const subscriptions = await adapter.subscribe({
    connection: { id: "microsoft365-main" },
    credentials: { accessToken: "private-access-token" },
    publicBaseUrl: "https://crew.example.test",
    eventIds: ["microsoft365.outlookMessageCreated"]
  });
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].providerKey, "microsoft365.outlookMessageCreated");
  assert.match(subscriptions[0].secret, /^[A-Za-z0-9_-]{32,}$/);
  const body = JSON.parse(request.options.body);
  assert.equal(body.notificationUrl, "https://crew.example.test/integrations/webhooks/microsoft365/microsoft365-main");
  assert.equal(body.clientState, subscriptions[0].secret);
  assert.doesNotMatch(JSON.stringify(subscriptions), /private-access-token/i);
});

test("Microsoft subscription renewal requests a fresh Graph-valid expiration instead of reusing the stored value", async () => {
  const renewalNow = Date.UTC(2031, 0, 2, 3, 4, 5);
  const staleExpiration = new Date(renewalNow - (24 * 60 * 60 * 1000)).toISOString();
  let request;
  const adapter = createMicrosoft365Adapter({
    now: () => renewalNow,
    fetch: async (url, options) => {
      request = { url: String(url), options };
      const body = JSON.parse(options.body);
      return jsonResponse({
        id: "graph-subscription-1",
        resource: "/me/mailFolders('Inbox')/messages",
        changeType: "created",
        expirationDateTime: body.expirationDateTime
      });
    }
  });

  const renewed = await adapter.renew({
    subscription: { id: "graph-subscription-1", expiresAt: staleExpiration, providerKey: "microsoft365.outlookMessageCreated" },
    connection: { id: "microsoft365-main" },
    credentials: { accessToken: "private-access-token" }
  });

  assert.match(request.url, /\/subscriptions\/graph-subscription-1$/);
  assert.equal(request.options.method, "PATCH");
  const requestedExpiration = JSON.parse(request.options.body).expirationDateTime;
  assert.equal(requestedExpiration, new Date(renewalNow + (55 * 60 * 1000)).toISOString());
  assert.notEqual(requestedExpiration, staleExpiration);
  assert.ok(Date.parse(requestedExpiration) >= renewalNow + (45 * 60 * 1000));
  assert.ok(Date.parse(requestedExpiration) <= renewalNow + (60 * 60 * 1000));
  assert.equal(renewed.expiresAt, Date.parse(requestedExpiration));
});

test("Microsoft automatic subscriptions respect selected capabilities and skip unresolved Teams templates", async () => {
  const requests = [];
  const adapter = createMicrosoft365Adapter({
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return jsonResponse({
        id: `graph-subscription-${requests.length}`,
        resource: requests.at(-1).resource,
        changeType: requests.at(-1).changeType,
        expirationDateTime: new Date(Date.now() + 30 * 60_000).toISOString()
      });
    }
  });
  const common = { credentials: { accessToken: "private-access-token" }, publicBaseUrl: "https://crew.example.test" };
  const outlook = await adapter.subscribe({ ...common, connection: { id: "microsoft365-main", capabilities: ["outlook"] } });
  assert.deepEqual(outlook.map((subscription) => subscription.providerKey), ["microsoft365.outlookMessageCreated"]);
  assert.deepEqual(requests.map((request) => request.resource), ["/me/mailFolders('Inbox')/messages"]);

  const teams = await adapter.subscribe({
    ...common,
    connection: { id: "microsoft365-main", capabilities: ["teams"] },
    eventIds: ["microsoft365.teamsChannelMessageCreated"]
  });
  assert.deepEqual(teams, [], "a Teams template needs an explicit selected channel before a subscription is attempted");
  assert.equal(requests.length, 1, "an unresolved Teams resource cannot make the connection callback fail");
});

test("GitHub manifest permits curated repository work but excludes destructive or admin tools", () => {
  const plugin = createGitHubPlugin();
  const registry = createPluginRegistry({ plugins: [plugin] });
  const actionIds = registry.actions().map((action) => action.id);
  assert.deepEqual(actionIds.filter((id) => id.startsWith("github.") && !id.startsWith("github.get")), [
    "github.listPullRequests",
    "github.createBranch",
    "github.commitFiles",
    "github.createPullRequest",
    "github.createIssue",
    "github.addIssueComment",
    "github.submitPullRequestReview",
    "github.addLabels"
  ]);
  assert.ok(!actionIds.some((id) => /delete|admin|member|settings|force/i.test(id)));
  assert.ok(registry.actions().filter((action) => action.risk === "external-write").every((action) => action.approval === "required"));
  assert.doesNotMatch(JSON.stringify(registry.list()), /privateKey|accessToken|refreshToken|clientSecret|credentialRef/i);
});

test("GitHub write permissions retain the matching curated read tools", () => {
  const actions = createGitHubPlugin().actions;
  const registry = createConnectorRegistry({
    connections: [{
      id: "github-installation", provider: "github", status: "connected",
      capabilities: ["repositories", "contents", "pull-requests", "issues"],
      scopes: ["metadata:read", "contents:write", "pull_requests:write", "issues:write"]
    }],
    actions,
    roleActions: { ops: actions.map((action) => action.id) },
    roleConnections: { ops: ["github-installation"] },
    invoke: async () => ({ ok: true })
  });
  const tools = registry.toolsForRole("ops");
  for (const action of ["github.getFile", "github.listPullRequests", "github.getPullRequest", "github.getIssue"]) {
    assert.ok(tools.includes(action), `${action} remains available when the GitHub App grants write permission`);
  }
});

test("GitHub App traffic is pinned before it signs or sends a credential", async () => {
  let signed = false;
  let fetched = false;
  const adapter = createGitHubAdapter({
    appId: "42",
    apiBase: "https://attacker.example.test/api",
    signAppJwt: async () => { signed = true; return "private-app-jwt"; },
    fetch: async () => { fetched = true; return jsonResponse({}); }
  });
  await assert.rejects(adapter.exchangeCode({ installationId: "123" }), /API base must be https:\/\/api\.github\.com/);
  assert.equal(signed, false);
  assert.equal(fetched, false);
});

test("GitHub validators prevent path escape hatches and retain only curated fields", () => {
  const commit = validateGitHubAction("github.commitFiles", {
    owner: "medhus-ai",
    repo: "crewrun",
    branch: "feature/safe-change",
    message: "Add integration test",
    files: [{ path: "docs/test.md", content: "hello" }],
    force: true,
    token: "not-allowed"
  });
  assert.deepEqual(commit, {
    ok: true,
    input: {
      owner: "medhus-ai", repo: "crewrun", branch: "feature/safe-change", message: "Add integration test",
      files: [{ path: "docs/test.md", content: "hello" }]
    }
  });
  assert.equal(validateGitHubAction("github.getFile", { owner: "medhus-ai", repo: "crewrun", path: "../.git/config" }).ok, false);
  assert.equal(validateGitHubAction("github.addLabels", { owner: "medhus-ai", repo: "crewrun", number: 1, labels: [] }).ok, false);
});

test("GitHub verifies signed deliveries and persists only normalized event metadata", () => {
  const webhookSecret = "github-webhook-secret";
  const payload = {
    action: "opened",
    installation: { id: 123, account: { login: "medhus-ai" } },
    repository: { id: 7, full_name: "medhus-ai/crewrun", html_url: "https://github.com/medhus-ai/crewrun" },
    pull_request: { number: 8, html_url: "https://github.com/medhus-ai/crewrun/pull/8", body: "not retained" },
    number: 8,
    sender: { id: 4, login: "octocat" }
  };
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
  const verified = verifyGitHubWebhook({
    webhookSecret,
    connectionId: "github-main",
    rawBody,
    headers: { "x-hub-signature-256": signature, "x-github-event": "pull_request", "x-github-delivery": "delivery-1" }
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.events[0].type, "github.pullRequest");
  assert.deepEqual(verified.events[0].resource.repository, { id: "7", fullName: "medhus-ai/crewrun", url: "https://github.com/medhus-ai/crewrun" });
  assert.doesNotMatch(JSON.stringify(verified.events[0]), /webhook-secret|not retained|signature/i);
  assert.equal(verifyGitHubWebhook({ webhookSecret, rawBody, headers: { "x-hub-signature-256": "sha256=bad", "x-github-event": "push", "x-github-delivery": "delivery-2" } }).ok, false);
});

test("GitHub App installation and short-lived tokens stay inside the injected provider adapter", async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/app/installations/123")) {
      return jsonResponse({ account: { login: "medhus-ai" }, permissions: { contents: "write", pull_requests: "write", administration: "none" } });
    }
    if (String(url).endsWith("/app/installations/123/access_tokens")) {
      return jsonResponse({ token: "ephemeral-installation-token", expires_at: new Date(Date.now() + 10 * 60_000).toISOString() }, { status: 201 });
    }
    if (String(url).endsWith("/repos/medhus-ai/crewrun/issues")) {
      return jsonResponse({ number: 44, title: "Created by approved action" }, { status: 201 });
    }
    throw new Error(`unexpected GitHub request ${url}`);
  };
  const adapter = createGitHubAdapter({ appId: "42", appSlug: "crewrun-app", signAppJwt: async () => "private-app-jwt", fetch });
  const install = new URL(await adapter.authorizationUrl({ state: "one-time-state" }));
  assert.equal(install.pathname, "/apps/crewrun-app/installations/new");
  assert.equal(install.searchParams.get("state"), "one-time-state");
  const connection = await adapter.exchangeCode({ installationId: "123" });
  assert.deepEqual(connection, {
    credentials: { installationId: "123" },
    account: { id: "123", label: "medhus-ai" },
    scopes: ["contents:write", "pull_requests:write"],
    status: "connected"
  });
  const issue = await adapter.invoke({
    connection: { id: "github-main", account: { id: "123" } },
    credentials: connection.credentials,
    action: "github.createIssue",
    input: { owner: "medhus-ai", repo: "crewrun", title: "Approved issue" }
  });
  assert.deepEqual(issue, { number: 44, title: "Created by approved action" });
  assert.ok(calls.some((call) => call.options.headers?.authorization === "Bearer private-app-jwt"));
  assert.ok(calls.some((call) => call.options.headers?.authorization === "Bearer ephemeral-installation-token"));
  assert.doesNotMatch(JSON.stringify(issue), /private-app-jwt|ephemeral-installation-token/i);
});

test("GitHub App can use a host-provided private key without publishing it", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const jwt = signGitHubAppJwt({ appId: "42", issuedAt: 1_700_000_000, expiresAt: 1_700_000_540, privateKey: pem });
  assert.equal(jwt.split(".").length, 3);
  assert.doesNotMatch(jwt, /BEGIN PRIVATE KEY/);

  let authorization = "";
  const adapter = createGitHubAdapter({
    fetch: async (_url, options) => {
      authorization = options.headers.authorization;
      return jsonResponse({ account: { login: "medhus-ai" }, permissions: {} });
    }
  });
  const result = await adapter.exchangeCode({ installationId: "123", config: { appId: "42", privateKey: pem } });
  assert.match(authorization, /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(result.credentials, { installationId: "123" });
  assert.doesNotMatch(JSON.stringify(result), /BEGIN PRIVATE KEY/);
});
