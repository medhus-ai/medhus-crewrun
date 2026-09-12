import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import test from "node:test";
import { createHost } from "../packages/crewrun-reference-host/index.js";
import { createIntegrationHost } from "../packages/crewrun-reference-host/src/host.js";
import { defineIntegrationPlugin, pluginSetupPatch } from "../packages/crewrun-plugin-sdk/index.js";
import { createConsole } from "../src/console/server.js";
import { collectModels, renderPartial } from "../src/console/pages.js";

const origin = "https://crewrun.example.test";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewrun-setup-"));
  await mkdir(path.join(root, ".crew/agents"), { recursive: true });
  const env = { CREW_HOME: path.join(root, "private"), CREWRUN_PUBLIC_BASE_URL: origin, CREWRUN_INTEGRATIONS_KEY: "test-only-vault-key-at-least-thirty-two-characters" };
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, env };
}

function callback(host, query) {
  const req = Readable.from([]);
  Object.assign(req, { method: "GET", url: `/integrations/oauth/example/callback?${new URLSearchParams(query)}`, headers: {} });
  return new Promise((resolve, reject) => {
    const res = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(body) { resolve({ status: this.status, body }); } };
    host.ingress.handle(req, res).catch(reject);
  });
}

test("private setup has actionable buttons, encrypted persistence, no readback and CSRF protection", async (t) => {
  const { root, env } = await fixture(t);
  let host = createHost({ targetRoot: root, env });
  const app = createConsole({ targetRoot: root, env, operations: host.operations, host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${await app.listen()}`;
  t.after(async () => { await app.close(); await host.stop(); });
  const list = await (await fetch(base + "/integrations")).text();
  for (const label of ["Slack", "Google Workspace", "Microsoft 365", "GitHub"]) assert.ok(list.includes(`Set up ${label}`));
  const post = (fields, origin = base) => fetch(base + "/integrations/setup", { method: "POST", redirect: "manual", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  assert.equal((await post({ id: "slack", clientSecret: "forged-secret" }, "https://attacker.example")).status, 403);
  assert.deepEqual(host.state.getAppConfig("slack"), {});
  assert.equal((await post({ id: "slack", clientId: "my-client", clientSecret: "never-echo-this-secret", signingSecret: "never-echo-signing", apiBase: "https://attacker.example" })).status, 303);
  assert.equal(host.state.getAppConfig("slack").apiBase, undefined);
  const page = await (await fetch(base + "/integrations?integration=slack")).text();
  assert.match(page, /Connect Slack/);
  assert.ok(page.includes(origin + "/integrations/oauth/slack/callback"));
  assert.ok(page.includes(origin + "/integrations/webhooks/slack"));
  assert.match(page, /Saved. Leave blank/);
  assert.match(page, /Tailscale HTTPS — recommended default/);
  assert.match(page, /tailscale funnel --bg --https=443 http:\/\/127\.0\.0\.1:4411/);
  assert.match(page, /tailscale funnel --https=443 off/);
  assert.match(page, /does not prove public reachability/);
  assert.doesNotMatch(page, /funnel[^<\n]*:4402/);
  assert.doesNotMatch(page, /never-echo|forged-secret/);
  assert.doesNotMatch(JSON.stringify(await host.operations.getSnapshot()), /never-echo/);
  const stored = JSON.stringify(host.state.db.prepare("SELECT * FROM integration_app_config").all());
  assert.doesNotMatch(stored, /never-echo|my-client/);
  await post({ id: "slack", clientSecret: "" });
  assert.equal(host.state.getAppConfig("slack").clientSecret, "never-echo-this-secret");
  await host.stop();
  host = createHost({ targetRoot: root, env });
  assert.equal(host.state.getAppConfig("slack").clientSecret, "never-echo-this-secret");
  assert.equal((await host.operations.getSnapshot()).connectors.find((c) => c.id === "slack").configured, true);
});

test("HTTPS setup defaults to Tailscale without publishing anything and uses the configured callback port", async (t) => {
  const { root, env } = await fixture(t);
  const host = createHost({ targetRoot: root, env: { ...env, CREWRUN_PUBLIC_BASE_URL: "", CREWRUN_INTEGRATIONS_PORT: "4512" } });
  t.after(() => host.stop());
  assert.equal(host.ingress, null);
  const models = collectModels(root, { operations: await host.operations.getSnapshot() });
  const page = renderPartial("integrations", models, { selectedIntegration: "slack", canConfigureIntegrations: true, canConnect: true });
  assert.match(page, /id="https-setup" open/);
  assert.match(page, /Tailscale HTTPS — recommended default/);
  assert.match(page, /tailscale funnel --bg --https=443 http:\/\/127\.0\.0\.1:4512/);
  assert.match(page, /YOUR-MACHINE.YOUR-TAILNET.ts.net/);
  assert.match(page, /Never enter a sudo password/);
  assert.doesNotMatch(page, /arsazmar0smars3|funnel[^<\n]*:4402/);
});

test("provider setup declares requirements, environment ownership, and invalidates older consent", async (t) => {
  const { root, env } = await fixture(t);
  const host = createHost({ targetRoot: root, env: { ...env, CREWRUN_MICROSOFT_CLIENT_ID: "managed-client" } });
  t.after(() => host.stop());
  const microsoft = (await host.operations.getSnapshot()).connectors.find((c) => c.id === "microsoft365");
  assert.equal(microsoft.configured, false, "confidential Microsoft OAuth requires a secret too");
  assert.equal(microsoft.setup.fields.find((f) => f.key === "clientId").locked, true);
  await assert.rejects(host.operations.saveIntegrationSetup({ connectorId: "microsoft365", fields: { clientId: "replacement" } }), /managed by the host/);
  await host.operations.saveIntegrationSetup({ connectorId: "microsoft365", fields: { clientSecret: "private-secret" } });
  assert.equal((await host.operations.getSnapshot()).connectors.find((c) => c.id === "microsoft365").configured, true);
  const pending = host.state.issueOAuthState({ pluginId: "slack", verifier: "test-verifier" });
  await host.operations.saveIntegrationSetup({ connectorId: "slack", fields: { clientId: "new-app" } });
  assert.equal(host.state.consumeOAuthState(pending, { pluginId: "slack" }), null);
  host.state.saveConnection({ id: "slack-test", pluginId: "slack", credentials: { accessToken: "private" } });
  await assert.rejects(host.operations.saveIntegrationSetup({ connectorId: "slack", fields: { clientSecret: "replacement" } }), /Disconnect/);
});

test("setup contract rejects unsafe keys and accepts only declared scalar fields", () => {
  assert.throws(() => defineIntegrationPlugin({ id: "example", label: "Example", setup: { docsUrl: "https://example.com", fields: [{ key: "__proto__" }] } }), /setup field/);
  const plugin = defineIntegrationPlugin({ id: "example", label: "Example", setup: { docsUrl: "https://example.com", fields: [{ key: "clientSecret" }] } });
  assert.deepEqual(pluginSetupPatch(plugin, { arbitrary: "dropped", clientSecret: "secret" }), { clientSecret: "secret" });
  assert.throws(() => pluginSetupPatch(plugin, { clientSecret: ["a", "b"] }), /Invalid setup/);
});

test("consent cancellation/replay, explicit event setup failure, account health and single-account reconnect", async (t) => {
  const { root, env } = await fixture(t);
  let exchanges = 0;
  let subscriptions = 0;
  const plugin = defineIntegrationPlugin({
    id: "example", label: "Example",
    setup: { docsUrl: "https://example.com/setup", fields: [{ key: "clientId", type: "text", required: true }, { key: "clientSecret", required: true }] },
    oauth: { authorizationEndpoint: "https://example.com/oauth" },
    adapter: {
      async exchangeCode({ code, verifier, config }) {
        assert.ok(verifier); assert.equal(config.clientSecret, "secret");
        exchanges++;
        return { account: { id: code, label: code }, credentials: { accessToken: "token-" + code } };
      },
      async identifyAccount({ connection }) { return connection.account; },
      async subscribe() { subscriptions++; throw new Error("provider unavailable with secret details"); },
      async revoke() {}
    }
  });
  const host = createIntegrationHost({ targetRoot: root, env, plugins: [plugin], publicBaseUrl: origin, vaultKey: env.CREWRUN_INTEGRATIONS_KEY });
  t.after(() => host.stop());
  await host.operations.saveIntegrationSetup({ connectorId: "example", fields: { clientId: "client", clientSecret: "secret" } });
  const stateFor = async () => new URL((await host.operations.connect({ connectorId: "example" })).redirect).searchParams.get("state");
  const cancelled = await stateFor();
  assert.equal((await callback(host, { state: cancelled, error: "access_denied" })).status, 400);
  assert.equal((await callback(host, { state: cancelled, code: "not-allowed" })).status, 400);
  assert.equal(exchanges, 0);
  const first = await stateFor();
  assert.equal((await callback(host, { state: first, code: "first" })).status, 200);
  assert.equal((await callback(host, { state: first, code: "first" })).status, 400);
  assert.equal(subscriptions, 0, "OAuth does not subscribe or start automation");
  const connection = host.state.listConnections()[0];
  await assert.rejects(host.operations.configureIntegrationEvents({ id: connection.id }), /still connected/);
  await assert.rejects(host.operations.configureIntegrationEvents({ id: connection.id }), /already attempted/);
  assert.equal(subscriptions, 1, "uncertain event setup cannot be silently retried");
  assert.equal(host.state.getConnection(connection.id).status, "connected");
  await host.operations.checkIntegrationConnection({ id: connection.id });
  assert.equal((await host.operations.getSnapshot()).connectors[0].accountHealth.status, "healthy");
  const second = await stateFor();
  assert.equal((await callback(host, { state: second, code: "second" })).status, 200);
  assert.equal(host.state.findConnections({ pluginId: "example" }).length, 1);
  assert.equal(host.state.getConnection(connection.id, { credentials: true }).credentials, null);
  assert.equal(host.state.listRoutes().length, 0);
  const current = host.state.findConnections({ pluginId: "example" })[0];
  await host.operations.disconnect({ id: current.id });
  assert.equal(host.state.findConnections({ pluginId: "example" }).length, 0);
});
