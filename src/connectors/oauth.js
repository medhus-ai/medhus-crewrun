const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Endpoint metadata only. A host owns its OAuth callback, client secret, code exchange, refresh
// token storage, revocation, and user/session binding. These helpers only make a safe Connect
// button straightforward to implement without pulling an OAuth runtime into CrewRun.
export const connectorProviders = Object.freeze({
  slack: Object.freeze({
    id: "slack",
    label: "Slack",
    authorizationEndpoint: "https://slack.com/oauth/v2/authorize",
    tokenEndpoint: "https://slack.com/api/oauth.v2.access",
    scopeSeparator: ",",
    defaultScopes: Object.freeze(["chat:write", "app_mentions:read"])
  }),
  gmail: Object.freeze({
    id: "gmail",
    label: "Google Gmail",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopeSeparator: " ",
    defaultScopes: Object.freeze(["https://www.googleapis.com/auth/gmail.send"])
  })
});

// Returns an authorization URL only. `state` must be an opaque, one-time value generated and
// verified by the host; it is intentionally required rather than silently invented here.
export function connectorAuthorizationUrl({ provider, clientId, redirectUri, state, scopes, codeChallenge } = {}) {
  const metadata = connectorProvider(provider);
  const client = requiredText(clientId, "clientId");
  const redirect = validRedirectUri(redirectUri);
  const csrfState = requiredText(state, "state");
  const requestedScopes = normalizedScopes(scopes?.length ? scopes : metadata.defaultScopes);
  if (requestedScopes.length === 0) throw new Error("at least one OAuth scope is required");
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("client_id", client);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", csrfState);
  url.searchParams.set("scope", requestedScopes.join(metadata.scopeSeparator));
  url.searchParams.set("response_type", "code");
  if (metadata.id === "gmail") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("include_granted_scopes", "true");
    if (codeChallenge) {
      url.searchParams.set("code_challenge", requiredText(codeChallenge, "codeChallenge"));
      url.searchParams.set("code_challenge_method", "S256");
    }
  }
  return url.toString();
}

export function connectorProvider(provider) {
  const id = String(provider || "").trim();
  const metadata = connectorProviders[id];
  if (!metadata) throw new Error(`unknown connector provider: ${id || "<empty>"}`);
  return metadata;
}

function validRedirectUri(value) {
  const redirect = requiredText(value, "redirectUri");
  let parsed;
  try { parsed = new URL(redirect); } catch { throw new Error("redirectUri must be an absolute URL"); }
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed.toString();
  throw new Error("redirectUri must use https or a loopback http URL");
}

function requiredText(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 2048) throw new Error(`${name} is required`);
  return text;
}

function normalizedScopes(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  return [...new Set(list.map((scope) => String(scope || "").trim()).filter(Boolean))];
}
