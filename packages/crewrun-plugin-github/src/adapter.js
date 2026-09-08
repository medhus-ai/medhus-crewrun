import { createSign } from "node:crypto";

import { githubActions, validateGitHubAction } from "./actions.js";
import { githubSubscription, normalizeGitHubEvent, verifyGitHubWebhook } from "./events.js";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

// A GitHub App private key stays in host-private adapter configuration. The adapter may sign with
// it directly or use `signAppJwt`, but never returns the key or an installation access token.
// `withGitHubInstallationToken` uses a token internally for one caller-provided operation and
// discards it when that operation completes.
export function createGitHubAdapter({ fetch: defaultFetch = globalThis.fetch, appId = "", appSlug = "", signAppJwt, apiBase = GITHUB_API, now = Date.now, webhookSecret = "" } = {}) {
  async function authorizationUrl({ state, installUrl, slug, appSlug: requestedAppSlug, config = {} } = {}) {
    const runtime = adapterConfig({ config, appSlug: requestedAppSlug });
    const base = String(installUrl || installUrlFor(slug || runtime.appSlug || appSlug)).trim();
    const url = new URL(base);
    const value = String(state || "").trim();
    if (value) url.searchParams.set("state", value);
    return url.toString();
  }

  // GitHub App installation redirects include `installation_id` rather than an OAuth code. A
  // host passes it here after consuming its one-time CrewRun state token.
  async function exchangeCode({ installationId, fetch, appId: requestedAppId, appSlug: requestedAppSlug, signAppJwt: requestedSigner, privateKey, privateKeyBase64, apiBase: requestedApiBase, config = {} } = {}) {
    const runtime = adapterConfig({ config, fetch, appId: requestedAppId, appSlug: requestedAppSlug, signAppJwt: requestedSigner, privateKey, privateKeyBase64, apiBase: requestedApiBase });
    const installation = await appInstallation({ installationId, client: clientFor(runtime) });
    return {
      credentials: { installationId: installation.id },
      account: { id: installation.id, label: installation.accountLabel },
      scopes: installation.permissions,
      status: "connected"
    };
  }

  async function identifyAccount({ credentials, installationId, fetch, appId: requestedAppId, signAppJwt: requestedSigner, privateKey, privateKeyBase64, apiBase: requestedApiBase, config = {} } = {}) {
    const runtime = adapterConfig({ config, fetch, appId: requestedAppId, signAppJwt: requestedSigner, privateKey, privateKeyBase64, apiBase: requestedApiBase });
    const installation = await appInstallation({ installationId: installationId || credentials?.installationId, client: clientFor(runtime) });
    return { id: installation.id, label: installation.accountLabel };
  }

  async function invoke({ connection, credentials, action, input = {}, fetch, appId: requestedAppId, signAppJwt: requestedSigner, privateKey, privateKeyBase64, apiBase: requestedApiBase, config = {} } = {}) {
    const runtime = adapterConfig({ config, fetch, appId: requestedAppId, signAppJwt: requestedSigner, privateKey, privateKeyBase64, apiBase: requestedApiBase });
    const installationId = installationFrom({ connection, credentials, config });
    const checked = validateGitHubAction(action, input);
    if (!checked.ok) throw new Error(checked.error);
    return await invokeGitHubAction({ action, input: checked.input, client: clientFor(runtime), installationId });
  }

  async function subscribe({ connection, publicBaseUrl = "" } = {}) {
    const connectionId = required(connection?.id, "connection.id");
    const endpointUrl = String(publicBaseUrl || "").replace(/\/$/, "")
      ? `${String(publicBaseUrl).replace(/\/$/, "")}/integrations/webhooks/github`
      : githubSubscription.endpoint;
    return [{
      id: `github-webhook-${connectionId}`,
      providerKey: "github.webhook",
      resource: { installationId: installationFrom({ connection }), endpoint: endpointUrl },
      metadata: { kind: githubSubscription.kind, events: [...githubSubscription.events], configured: "app-settings" },
      status: "active"
    }];
  }

  async function renew({ subscription } = {}) { return { ...(subscription || {}), status: "active" }; }

  // Deliberately does not uninstall the GitHub App or alter repository administration. The host
  // removes its encrypted connection and ceases processing deliveries after this returns.
  async function revoke() { return { disconnected: true }; }

  function verifyWebhook(request = {}) {
    return verifyGitHubWebhook({ ...request, webhookSecret: request?.config?.webhookSecret ?? webhookSecret });
  }

  function adapterConfig({ config = {}, fetch, appId: requestedAppId = "", appSlug: requestedAppSlug = "", signAppJwt: requestedSigner, privateKey: requestedPrivateKey = "", privateKeyBase64: requestedPrivateKeyBase64 = "", apiBase: requestedApiBase = "" } = {}) {
    const source = config && typeof config === "object" && !Array.isArray(config) ? config : {};
    const privateKey = privateKeyFrom({
      privateKey: requestedPrivateKey || source.privateKey,
      privateKeyBase64: requestedPrivateKeyBase64 || source.privateKeyBase64
    });
    const signer = typeof requestedSigner === "function"
      ? requestedSigner
      : typeof source.signAppJwt === "function"
        ? source.signAppJwt
      : privateKey
        ? (payload) => signGitHubAppJwt({ ...payload, privateKey })
        : signAppJwt;
    return {
      appId: String(requestedAppId || source.appId || appId || "").trim(),
      appSlug: String(requestedAppSlug || source.appSlug || appSlug || "").trim(),
      signAppJwt: signer,
      fetch: typeof fetch === "function" ? fetch : typeof source.fetch === "function" ? source.fetch : defaultFetch,
      apiBase: requestedApiBase || source.apiBase || apiBase
    };
  }

  function clientFor(runtime) {
    return createGitHubAppClient({ fetch: runtime.fetch, appId: runtime.appId, signAppJwt: runtime.signAppJwt, apiBase: runtime.apiBase, now });
  }

  return { authorizationUrl, exchangeCode, identifyAccount, invoke, verifyWebhook, normalizeEvent: normalizeGitHubEvent, subscribe, renew, revoke };

  async function appInstallation({ installationId, client }) {
    const id = normalizedInstallationId(installationId);
    const payload = await client.appRequest({ path: `/app/installations/${encodeURIComponent(id)}` });
    return {
      id,
      accountLabel: String(payload?.account?.login || payload?.account?.name || `GitHub installation ${id}`).slice(0, 256),
      permissions: permissions(payload?.permissions)
    };
  }
}

export function installUrlFor(appSlug) {
  const slug = String(appSlug || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(slug)) throw new Error("GitHub appSlug is required to start installation");
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

// A self-host may keep this PEM in an encrypted host environment variable. The signer returns a
// short-lived RS256 app JWT and never exposes the supplied key through a connection, action,
// event, error, or public plugin manifest.
export function signGitHubAppJwt({ appId, issuedAt, expiresAt, privateKey } = {}) {
  const id = required(appId, "GitHub appId");
  const key = required(privateKey, "GitHub App private key");
  const issued = Number(issuedAt);
  const expires = Number(expiresAt);
  if (!Number.isInteger(issued) || !Number.isInteger(expires) || expires <= issued || expires - issued > 600) {
    throw new Error("GitHub App JWT timestamps are invalid");
  }
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issued, exp: expires, iss: id }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(key).toString("base64url")}`;
}

// A closure-scoped client may cache a short-lived installation token, but the token never
// crosses this API boundary. Inject a fetch mock and either a private key or vault-backed signer;
// no global credential source is consulted.
export function createGitHubAppClient({ fetch: defaultFetch = globalThis.fetch, appId = "", signAppJwt, apiBase = GITHUB_API, now = Date.now } = {}) {
  const endpoint = normalizedApiBase(apiBase);
  const tokenCache = new Map();

  function withFetch(fetch) {
    const fetchFn = typeof fetch === "function" ? fetch : defaultFetch;
    return { request: (request) => requestWithInstallationToken({ ...request, fetch: fetchFn }), appRequest: (request) => appRequest({ ...request, fetch: fetchFn }) };
  }

  async function appRequest({ path, method = "GET", json, fetch = defaultFetch } = {}) {
    const jwt = await appJwt({ appId, signAppJwt, now });
    return await apiRequest({ fetch, endpoint, path, method, json, token: jwt });
  }

  async function requestWithInstallationToken({ installationId, path, method = "GET", json, fetch = defaultFetch } = {}) {
    const id = normalizedInstallationId(installationId);
    return await withGitHubInstallationToken({
      fetch,
      installationId: id,
      appId,
      signAppJwt,
      apiBase: endpoint,
      now,
      cached: tokenCache.get(id),
      cache: (entry) => tokenCache.set(id, entry),
      useToken: async (token) => await apiRequest({ fetch, endpoint, path, method, json, token })
    });
  }

  return { request: (request) => requestWithInstallationToken({ ...request, fetch: defaultFetch }), appRequest: (request) => appRequest({ ...request, fetch: defaultFetch }), withFetch };
}

// `useToken` is the only code that can observe the ephemeral token. Its result is returned; the
// token itself is never included in that result by this helper.
export async function withGitHubInstallationToken({ fetch, installationId, appId, signAppJwt, apiBase = GITHUB_API, now = Date.now, cached = null, cache = () => {}, useToken } = {}) {
  if (typeof fetch !== "function") throw new Error("GitHub App client needs an injected fetch implementation");
  if (typeof useToken !== "function") throw new Error("GitHub App client needs a token-bound operation");
  const current = Number(typeof now === "function" ? now() : now);
  const token = cached?.token && Number(cached.expiresAt || 0) > current + 60_000 ? cached.token : await mintInstallationToken({ fetch, installationId, appId, signAppJwt, apiBase, now, cache });
  return await useToken(token);
}

export async function invokeGitHubAction({ action, input, client, installationId } = {}) {
  if (!client?.request) throw new Error("GitHub action needs an installation-scoped client");
  const checked = validateGitHubAction(action, input);
  if (!checked.ok) throw new Error(checked.error);
  const value = checked.input;
  const root = `/repos/${encodeURIComponent(value.owner)}/${encodeURIComponent(value.repo)}`;
  const request = (path, options = {}) => client.request({ installationId, path, ...options });

  switch (action) {
    case "github.getRepository": return await request(root);
    case "github.getFile": return await request(`${root}/contents/${filePath(value.path)}${value.ref ? `?ref=${encodeURIComponent(value.ref)}` : ""}`);
    case "github.listPullRequests": return await request(`${root}/pulls?state=${encodeURIComponent(value.state)}&per_page=${value.maxResults}`);
    case "github.getPullRequest": return await request(`${root}/pulls/${value.number}`);
    case "github.getIssue": return await request(`${root}/issues/${value.number}`);
    case "github.createBranch": return await createBranch({ request, root, ...value });
    case "github.commitFiles": return await commitFiles({ request, root, ...value });
    case "github.createPullRequest": return await request(`${root}/pulls`, { method: "POST", json: { title: value.title, head: value.head, base: value.base, ...(value.body ? { body: value.body } : {}) } });
    case "github.createIssue": return await request(`${root}/issues`, { method: "POST", json: { title: value.title, ...(value.body ? { body: value.body } : {}) } });
    case "github.addIssueComment": return await request(`${root}/issues/${value.number}/comments`, { method: "POST", json: { body: value.body } });
    case "github.submitPullRequestReview": return await request(`${root}/pulls/${value.number}/reviews`, { method: "POST", json: { event: value.event, ...(value.body ? { body: value.body } : {}) } });
    case "github.addLabels": return await request(`${root}/issues/${value.number}/labels`, { method: "POST", json: { labels: value.labels } });
    default: throw new Error(`unsupported GitHub action: ${action || "<empty>"}`);
  }
}

async function createBranch({ request, root, name, fromBranch }) {
  const source = await request(`${root}/git/ref/heads/${encodeURIComponent(fromBranch)}`);
  const sha = String(source?.object?.sha || "");
  if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error("GitHub source branch did not return a commit sha");
  return await request(`${root}/git/refs`, { method: "POST", json: { ref: `refs/heads/${name}`, sha } });
}

// Git's tree/commit/ref sequence creates one atomic commit and advances the named ref with
// force:false. It never sends a deletion tree entry or force-pushes a branch.
async function commitFiles({ request, root, branch, message, files }) {
  const ref = await request(`${root}/git/ref/heads/${encodeURIComponent(branch)}`);
  const parentSha = String(ref?.object?.sha || "");
  if (!/^[a-f0-9]{40,64}$/i.test(parentSha)) throw new Error("GitHub branch did not return a commit sha");
  const parent = await request(`${root}/git/commits/${parentSha}`);
  const baseTree = String(parent?.tree?.sha || "");
  if (!/^[a-f0-9]{40,64}$/i.test(baseTree)) throw new Error("GitHub commit did not return a tree sha");
  const tree = [];
  for (const file of files) {
    const blob = await request(`${root}/git/blobs`, { method: "POST", json: { content: file.content, encoding: "utf-8" } });
    const sha = String(blob?.sha || "");
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error("GitHub blob did not return a sha");
    tree.push({ path: file.path, mode: "100644", type: "blob", sha });
  }
  const nextTree = await request(`${root}/git/trees`, { method: "POST", json: { base_tree: baseTree, tree } });
  const treeSha = String(nextTree?.sha || "");
  if (!/^[a-f0-9]{40,64}$/i.test(treeSha)) throw new Error("GitHub tree did not return a sha");
  const commit = await request(`${root}/git/commits`, { method: "POST", json: { message, tree: treeSha, parents: [parentSha] } });
  const commitSha = String(commit?.sha || "");
  if (!/^[a-f0-9]{40,64}$/i.test(commitSha)) throw new Error("GitHub commit did not return a sha");
  const updated = await request(`${root}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", json: { sha: commitSha, force: false } });
  return { sha: commitSha, ref: String(updated?.ref || `refs/heads/${branch}`), files: files.map((file) => file.path) };
}

async function mintInstallationToken({ fetch, installationId, appId, signAppJwt, apiBase, now, cache }) {
  const jwt = await appJwt({ appId, signAppJwt, now });
  const endpoint = normalizedApiBase(apiBase);
  const payload = await apiRequest({ fetch, endpoint, path: `/app/installations/${encodeURIComponent(normalizedInstallationId(installationId))}/access_tokens`, method: "POST", token: jwt });
  const token = required(payload?.token, "GitHub installation access token");
  const expires = new Date(payload?.expires_at).getTime();
  if (!Number.isFinite(expires)) throw new Error("GitHub installation token did not return expires_at");
  cache({ token, expiresAt: expires });
  return token;
}

async function appJwt({ appId, signAppJwt, now }) {
  const id = required(appId, "GitHub appId");
  if (typeof signAppJwt !== "function") throw new Error("GitHub App client needs a vault-backed signAppJwt function");
  const issuedAt = Math.floor((Number(typeof now === "function" ? now() : now) || Date.now()) / 1000) - 30;
  const value = await signAppJwt({ appId: id, issuedAt, expiresAt: issuedAt + 540 });
  return required(value, "GitHub App JWT");
}

async function apiRequest({ fetch, endpoint, path, method = "GET", json, token } = {}) {
  if (typeof fetch !== "function") throw new Error("GitHub App client needs an injected fetch implementation");
  const url = new URL(String(path || ""), endpoint);
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${required(token, "GitHub authorization")}`,
      "x-github-api-version": API_VERSION,
      ...(json === undefined ? {} : { "content-type": "application/json" })
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) })
  });
  const payload = await response?.json?.().catch(() => ({}));
  if (!response?.ok) throw new Error(`GitHub ${method} ${url.pathname} failed: ${String(payload?.message || response?.status || "unknown error").slice(0, 1_000)}`);
  return payload && typeof payload === "object" ? payload : {};
}

function installationFrom({ connection, credentials, config } = {}) {
  return normalizedInstallationId(credentials?.installationId || connection?.credentials?.installationId || config?.credentials?.installationId || config?.installationId || connection?.account?.id || connection?.installationId);
}
function normalizedInstallationId(value) { const result = String(value || "").trim(); if (!/^\d{1,20}$/.test(result)) throw new Error("GitHub installationId is required"); return result; }
// This reference plugin covers github.com only. Validate the base before a GitHub App JWT or
// installation token is minted, so an operator JSON typo cannot turn the provider endpoint into
// a credential exfiltration target. GitHub Enterprise needs a separately reviewed plugin.
function normalizedApiBase(value) {
  const url = new URL(String(value || GITHUB_API));
  if (url.protocol !== "https:" || url.hostname !== "api.github.com" || url.port || url.username || url.password
    || !["", "/"].includes(url.pathname) || url.search || url.hash) {
    throw new Error("GitHub App API base must be https://api.github.com");
  }
  return `${GITHUB_API}/`;
}
function required(value, name) { const result = typeof value === "string" || typeof value === "number" ? String(value).trim() : ""; if (!result) throw new Error(`${name} is required`); return result; }
function filePath(value) { return String(value || "").split("/").map((part) => encodeURIComponent(part)).join("/"); }
function permissions(value) { return Object.entries(value && typeof value === "object" ? value : {}).filter(([, level]) => ["read", "write"].includes(level)).map(([name, level]) => `${name}:${level}`).sort(); }
function privateKeyFrom(config) {
  const direct = typeof config?.privateKey === "string" ? config.privateKey.trim() : "";
  if (direct) return direct;
  const encoded = typeof config?.privateKeyBase64 === "string" ? config.privateKeyBase64.trim() : "";
  if (!encoded) return "";
  try { return Buffer.from(encoded, "base64").toString("utf8").trim(); } catch { throw new Error("GitHub App privateKeyBase64 is invalid"); }
}
function base64url(value) { return Buffer.from(String(value), "utf8").toString("base64url"); }
