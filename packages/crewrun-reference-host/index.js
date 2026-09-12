import { createConsole } from "medhus-crewrun/console/server";
import { createUp } from "medhus-crewrun/up";
import { loadInstalledPlugins } from "medhus-crewrun/integration-plugins";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { integrationStatePath } from "./src/state.js";

import { githubPlugin } from "@medhus-ai/crewrun-plugin-github";
import { googleWorkspacePlugin } from "@medhus-ai/crewrun-plugin-google-workspace";
import { microsoft365Plugin } from "@medhus-ai/crewrun-plugin-microsoft-365";
import { slackPlugin } from "@medhus-ai/crewrun-plugin-slack";

import { createIntegrationHost, createReferenceHost } from "./src/host.js";

export { createIntegrationHost, createReferenceHost } from "./src/host.js";
export { createIntegrationState, integrationStatePath } from "./src/state.js";
export { createIntegrationIngress } from "./src/ingress.js";

export const referencePlugins = Object.freeze([slackPlugin, googleWorkspacePlugin, microsoft365Plugin, githubPlugin]);
export async function loadReferencePlugins(env = process.env) {
  return [...referencePlugins, ...await loadInstalledPlugins({ env })];
}

// This is the bundled `crewrun up` host factory. It deliberately
// reads only operator-owned environment configuration and always keeps the console separate
// from the public callback listener. For programmatic/vault integrations, call
// createIntegrationHost directly with constructed plugin instances and pluginConfig instead.
export function createHost({ targetRoot, log = () => {}, env = process.env, plugins = referencePlugins } = {}) {
  return createIntegrationHost({
    targetRoot,
    plugins,
    pluginConfig: referencePluginConfig(env),
    publicBaseUrl: env.CREWRUN_PUBLIC_BASE_URL,
    vaultKey: env.CREWRUN_INTEGRATIONS_KEY || localVaultKey(targetRoot, env),
    ingressHost: env.CREWRUN_INTEGRATIONS_HOST || "127.0.0.1",
    ingressPort: numberEnv(env.CREWRUN_INTEGRATIONS_PORT, 4411),
    env,
    log
  });
}

// An unattended self-host needs a persistent key, even before any provider is configured.
// Exclusive creation is safe across starts; it is never part of workspace files or snapshots.
function localVaultKey(targetRoot, env) {
  const file = path.join(path.dirname(integrationStatePath(targetRoot, env)), "host.key");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return readFileSync(file, "utf8").trim();
}

// Convenience for a single-owner deployment that wants one call to start the private console
// and the loopback-only provider ingress. Funnel activation remains outside this package.
export async function startReferenceHost({
  targetRoot,
  host = null,
  env = process.env,
  log = () => {},
  consoleHost = "127.0.0.1",
  consolePort = 4400,
  ...hostOptions
} = {}) {
  if (!isLoopback(consoleHost)) throw new Error("the reference console must listen on a loopback address");
  const integrationHost = host || createIntegrationHost({
    targetRoot,
    plugins: hostOptions.plugins || await loadReferencePlugins(env),
    pluginConfig: hostOptions.pluginConfig || referencePluginConfig(env),
    publicBaseUrl: hostOptions.publicBaseUrl || env.CREWRUN_PUBLIC_BASE_URL,
    vaultKey: hostOptions.vaultKey || env.CREWRUN_INTEGRATIONS_KEY || localVaultKey(targetRoot, env),
    ingressHost: hostOptions.ingressHost || env.CREWRUN_INTEGRATIONS_HOST || "127.0.0.1",
    ingressPort: hostOptions.ingressPort || numberEnv(env.CREWRUN_INTEGRATIONS_PORT, 4411),
    fetchImpl: hostOptions.fetchImpl,
    env,
    log
  });
  const up = createUp({ targetRoot, host: integrationHost, env, log });
  const consoleApp = createConsole({
    targetRoot,
    up,
    knownEvents: integrationHost.knownEvents || [],
    operations: up.operations,
    host: consoleHost,
    port: consolePort,
    env,
    log
  });
  let consoleStarted = false;
  try {
    await up.start();
    await consoleApp.listen();
    consoleStarted = true;
  } catch (error) {
    if (consoleStarted) await consoleApp.close().catch(() => {});
    await up.stop().catch(() => {});
    throw error;
  }
  return {
    host: integrationHost,
    up,
    console: consoleApp,
    close: async () => { await consoleApp.close(); await up.stop(); }
  };
}

// JSON is useful for a service manager, while individual names remain friendlier for a small
// self-host. Values are never returned from this function through a console snapshot.
export function referencePluginConfig(env = process.env) {
  const declared = jsonObject(env.CREWRUN_INTEGRATION_PLUGIN_CONFIG);
  const fromEnv = {
    slack: compact({ clientId: env.CREWRUN_SLACK_CLIENT_ID, clientSecret: env.CREWRUN_SLACK_CLIENT_SECRET, signingSecret: env.CREWRUN_SLACK_SIGNING_SECRET }),
    "google-workspace": compact({ clientId: env.CREWRUN_GOOGLE_CLIENT_ID, clientSecret: env.CREWRUN_GOOGLE_CLIENT_SECRET, gmailPubsubTopic: env.CREWRUN_GOOGLE_GMAIL_PUBSUB_TOPIC, gmailPushAudience: env.CREWRUN_GOOGLE_GMAIL_PUSH_AUDIENCE, gmailPushServiceAccount: env.CREWRUN_GOOGLE_GMAIL_PUSH_SERVICE_ACCOUNT }),
    // The Microsoft plugin fixes bearer-token traffic to Microsoft Graph. Do not accept an
    // environment-controlled Graph base URL here: an accidental hostname would exfiltrate a
    // delegated access token before the host could apply any governance policy.
    microsoft365: compact({ clientId: env.CREWRUN_MICROSOFT_CLIENT_ID, clientSecret: env.CREWRUN_MICROSOFT_CLIENT_SECRET }),
    github: compact({ appId: env.CREWRUN_GITHUB_APP_ID, appSlug: env.CREWRUN_GITHUB_APP_SLUG, webhookSecret: env.CREWRUN_GITHUB_WEBHOOK_SECRET, privateKey: env.CREWRUN_GITHUB_PRIVATE_KEY, privateKeyBase64: env.CREWRUN_GITHUB_PRIVATE_KEY_BASE64 })
  };
  return mergePluginConfig(fromEnv, declared);
}

function mergePluginConfig(base, override) {
  const ids = new Set([...Object.keys(base), ...Object.keys(override)]);
  const merged = Object.fromEntries([...ids].map((id) => [id, { ...object(base[id]), ...object(override[id]) }]));
  // github.com is pinned in the plugin before it signs or sends a credential. Do not carry an
  // arbitrary endpoint through the standard one-owner host configuration either.
  delete merged.github?.apiBase;
  return merged;
}
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string" && item.trim())); }
function jsonObject(value) { try { return object(JSON.parse(String(value || "{}"))); } catch { throw new Error("CREWRUN_INTEGRATION_PLUGIN_CONFIG must be a JSON object"); } }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function numberEnv(value, fallback) { const number = Number(value); return Number.isInteger(number) && number > 0 && number < 65_536 ? number : fallback; }
function isLoopback(value) { return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(String(value || "").toLowerCase()); }
