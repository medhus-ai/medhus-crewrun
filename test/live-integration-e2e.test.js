// Opt-in live checks. The public route probe deliberately uses an invalid OAuth state, while the
// separate provider probes use a short-lived test-account token for one harmless authenticated
// read. They never exchange a browser code or perform a provider write.
import assert from "node:assert/strict";
import test from "node:test";

const LIVE = process.env.CREW_LIVE_E2E === "1";
const TIMEOUT_MS = 20_000;

function requested(t, provider) {
  if (!LIVE || process.env[`CREW_LIVE_${provider}`] !== "1") {
    t.skip(`set CREW_LIVE_E2E=1 CREW_LIVE_${provider}=1 CREW_LIVE_INTEGRATIONS_URL=https://… to run this ingress check`);
    return null;
  }
  const base = process.env.CREW_LIVE_INTEGRATIONS_URL || process.env.CREWRUN_PUBLIC_BASE_URL;
  if (!base) {
    t.skip("CREW_LIVE_INTEGRATIONS_URL (or CREWRUN_PUBLIC_BASE_URL) is not set");
    return null;
  }
  const url = new URL(base);
  assert.equal(url.protocol, "https:", "the public callback URL must use HTTPS");
  assert.equal(url.pathname, "/", "the reference ingress public base must be a root HTTPS origin");
  assert.equal(url.search, "", "the reference ingress public base cannot include a query");
  assert.equal(url.hash, "", "the reference ingress public base cannot include a fragment");
  return url;
}

function providerToken(t, provider, name) {
  if (!LIVE || process.env[`CREW_LIVE_${provider}`] !== "1") {
    t.skip(`set CREW_LIVE_E2E=1 CREW_LIVE_${provider}=1 to run this provider check`);
    return "";
  }
  const token = String(process.env[name] || "").trim();
  if (!token) {
    t.skip(`set ${name} to a separately provisioned, read-only test-account token`);
    return "";
  }
  return token;
}

async function probeCallback(base, pluginId) {
  const url = new URL(`/integrations/oauth/${encodeURIComponent(pluginId)}/callback?code=live-probe&state=invalid-live-probe`, base);
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
  const body = await response.text();
  assert.equal(response.status, 400, `expected CrewRun's callback rejection at ${url.origin}, got ${response.status}`);
  assert.match(body, /Connection expired/i, "the public URL did not reach CrewRun integration ingress");
}

async function probePrivateConsoleIsNotPublic(base) {
  const response = await fetch(new URL("/", base), { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" });
  const body = await response.text();
  assert.equal(response.status, 404, "the Funnel endpoint must expose only integration callback routes");
  assert.doesNotMatch(body, /CrewRun|Dashboard|role management/i, "a private CrewRun console was exposed through Funnel");
}

async function authenticatedRead(url, token, expected) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error"
  });
  assert.equal(response.ok, true, `expected a safe provider read to succeed (HTTP ${response.status})`);
  const body = await response.json();
  assert.equal(expected(body), true, "provider response did not have the expected safe shape");
}

test("live Slack Funnel callback reaches the configured ingress", { timeout: TIMEOUT_MS + 2_000 }, async (t) => {
  const base = requested(t, "SLACK");
  if (!base) return;
  await probeCallback(base, "slack");
});

test("live Slack test account can perform a safe auth check", { timeout: TIMEOUT_MS + 2_000 }, async (t) => {
  const token = providerToken(t, "SLACK", "CREW_LIVE_SLACK_TOKEN");
  if (!token) return;
  await authenticatedRead("https://slack.com/api/auth.test", token, (body) => body?.ok === true && typeof body.team_id === "string");
});

test("live Google Workspace Funnel callback reaches the configured ingress", { timeout: TIMEOUT_MS + 2_000 }, async (t) => {
  const base = requested(t, "GOOGLE");
  if (!base) return;
  await probeCallback(base, "google-workspace");
});

test("live Google Workspace test account can read its Gmail profile", { timeout: TIMEOUT_MS + 2_000 }, async (t) => {
  const token = providerToken(t, "GOOGLE", "CREW_LIVE_GOOGLE_ACCESS_TOKEN");
  if (!token) return;
  await authenticatedRead("https://gmail.googleapis.com/gmail/v1/users/me/profile", token, (body) => typeof body?.emailAddress === "string" && body.emailAddress.length > 0);
});

test("live Microsoft 365 Funnel callback reaches the configured ingress", { timeout: TIMEOUT_MS + 2_000 }, async (t) => {
  const base = requested(t, "MICROSOFT");
  if (!base) return;
  await probeCallback(base, "microsoft365");
});

test("live Microsoft 365 test account can read its own Graph identity", { timeout: TIMEOUT_MS + 2_000 }, async (t) => {
  const token = providerToken(t, "MICROSOFT", "CREW_LIVE_MICROSOFT_ACCESS_TOKEN");
  if (!token) return;
  await authenticatedRead("https://graph.microsoft.com/v1.0/me?$select=id", token, (body) => typeof body?.id === "string" && body.id.length > 0);
});

test("live GitHub App setup callback reaches the configured ingress", { timeout: TIMEOUT_MS + 2_000 }, async (t) => {
  const base = requested(t, "GITHUB");
  if (!base) return;
  await probeCallback(base, "github");
});

test("live GitHub App installation can list one repository without mutation", { timeout: TIMEOUT_MS + 2_000 }, async (t) => {
  const token = providerToken(t, "GITHUB", "CREW_LIVE_GITHUB_INSTALLATION_TOKEN");
  if (!token) return;
  await authenticatedRead("https://api.github.com/installation/repositories?per_page=1", token, (body) => Array.isArray(body?.repositories));
});

test("live Funnel endpoint is HTTPS and reaches a selected integration callback", { timeout: TIMEOUT_MS + 2_000 }, async (t) => {
  const base = requested(t, "FUNNEL");
  if (!base) return;
  assert.match(base.hostname, /\.ts\.net$/i, "CREW_LIVE_INTEGRATIONS_URL should be the operator-managed Tailscale Funnel hostname");
  await probePrivateConsoleIsNotPublic(base);
  await probeCallback(base, process.env.CREW_LIVE_FUNNEL_PLUGIN || "slack");
});
