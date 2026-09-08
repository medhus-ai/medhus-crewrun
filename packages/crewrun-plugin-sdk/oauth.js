import { normalizeOAuthMetadata, providerOAuthMetadata } from "./manifest.js";
import { normalizedStrings, requiredText } from "./safe.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Build a provider authorization URL from declarative metadata. OAuth state is intentionally
// required and must be issued/verified by the host. This helper never exchanges a code or sees
// a client secret, refresh token, or PKCE verifier.
export function oauthAuthorizationUrl({ plugin, oauth, clientId, redirectUri, state, scopes, codeChallenge } = {}) {
  const metadata = providerOAuthMetadata(plugin ?? oauth);
  if (!metadata) throw new Error("OAuth provider metadata is required");
  const client = requiredText(clientId, "clientId");
  const redirect = validRedirectUri(redirectUri);
  const csrfState = requiredText(state, "state");
  const requestedScopes = normalizedStrings(scopes?.length ? scopes : metadata.defaultScopes);
  if (requestedScopes.length === 0) throw new Error("at least one OAuth scope is required");
  if (metadata.pkce === "required" && !codeChallenge) throw new Error("OAuth codeChallenge is required");
  if (metadata.pkce === "none" && codeChallenge) throw new Error("OAuth provider does not support PKCE");

  const url = new URL(metadata.authorizationEndpoint);
  for (const [key, value] of Object.entries(metadata.authorizationParams || {})) url.searchParams.set(key, value);
  url.searchParams.set("client_id", client);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", csrfState);
  url.searchParams.set("scope", requestedScopes.join(metadata.scopeSeparator));
  url.searchParams.set("response_type", "code");
  if (codeChallenge) {
    url.searchParams.set("code_challenge", requiredText(codeChallenge, "codeChallenge"));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export { normalizeOAuthMetadata };

function validRedirectUri(value) {
  const redirect = requiredText(value, "redirectUri");
  let parsed;
  try { parsed = new URL(redirect); } catch { throw new Error("redirectUri must be an absolute URL"); }
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed.toString();
  throw new Error("redirectUri must use https or a loopback http URL");
}
