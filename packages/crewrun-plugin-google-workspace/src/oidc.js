import { createPublicKey, verify as verifySignature } from "node:crypto";

// Google publishes the signing keys for service-account OIDC tokens here. Keep this URL
// fixed for the built-in verifier; hosts that need a test double can inject it explicitly.
export const GOOGLE_OIDC_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_OIDC_ISSUERS = Object.freeze(["accounts.google.com", "https://accounts.google.com"]);

const DEFAULT_CACHE_MS = 5 * 60 * 1000;
const MAX_CACHE_MS = 60 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_SECONDS = 300;
const DEFAULT_MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_TOKEN_LENGTH = 16 * 1024;
const UNKNOWN_KID_REFRESH_MS = 30 * 1000;

// Returns a verifier suitable for a webhook boundary. It deliberately returns only a boolean
// result: callers never need to retain the token or its claims after verification. A Pub/Sub
// push endpoint can additionally pin the operator-selected service-account email; a valid
// Google token for some other service account is not proof that it came from this subscription.
export function createGoogleOidcVerifier({
  fetch: defaultFetch = null,
  now = Date.now,
  jwksUrl = GOOGLE_OIDC_JWKS_URL,
  issuers = GOOGLE_OIDC_ISSUERS,
  cacheTtlMs = DEFAULT_CACHE_MS,
  maxCacheTtlMs = MAX_CACHE_MS,
  clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
  maxTokenLifetimeSeconds = DEFAULT_MAX_TOKEN_LIFETIME_SECONDS,
  requestTimeoutMs = 5_000
} = {}) {
  const trustedIssuers = new Set(Array.isArray(issuers) ? issuers.filter((value) => typeof value === "string" && value) : GOOGLE_OIDC_ISSUERS);
  const endpoint = validHttpsUrl(jwksUrl) ? String(jwksUrl) : GOOGLE_OIDC_JWKS_URL;
  const maximumCacheMs = boundedMilliseconds(maxCacheTtlMs, MAX_CACHE_MS, MAX_CACHE_MS);
  const fallbackCacheMs = Math.min(boundedMilliseconds(cacheTtlMs, DEFAULT_CACHE_MS, maximumCacheMs), maximumCacheMs);
  const skew = boundedSeconds(clockSkewSeconds, DEFAULT_CLOCK_SKEW_SECONDS, 15 * 60);
  const maximumLifetime = boundedSeconds(maxTokenLifetimeSeconds, DEFAULT_MAX_TOKEN_LIFETIME_SECONDS, 7 * 24 * 60 * 60);
  const timeout = boundedMilliseconds(requestTimeoutMs, 5_000, 30_000);
  let cache = null;
  let inFlight = null;
  let lastUnknownKidRefreshAt = -Infinity;

  return async function verifyGoogleOidcToken({ token, audience, serviceAccountEmail, fetch: requestFetch } = {}) {
    try {
      const parsed = parseJwt(token);
      const expectedAudience = exactAudience(audience);
      if (!parsed || !expectedAudience || parsed.header.alg !== "RS256" || !parsed.header.kid || !trustedIssuers.has(parsed.claims.iss)) return { ok: false };
      if (parsed.claims.aud !== expectedAudience || !validTimes(parsed.claims, now, skew, maximumLifetime)) return { ok: false };
      const expectedServiceAccount = normalizedServiceAccountEmail(serviceAccountEmail);
      if (serviceAccountEmail != null && (!expectedServiceAccount || !matchesServiceAccount(parsed.claims, expectedServiceAccount))) return { ok: false };
      const fetchFn = requestFetch || defaultFetch || globalThis.fetch;
      if (typeof fetchFn !== "function") return { ok: false };
      const current = nowMilliseconds(now);
      const cacheWasFresh = Boolean(cache && cache.expiresAt > current);
      let key = await keyFor(parsed.header.kid, fetchFn, false);
      // A new key can appear before an advertised cache TTL ends. Refresh exactly once for an
      // unknown kid; this preserves rotation support without giving every forged kid an
      // unauthenticated outbound-fetch primitive.
      if (!key && cacheWasFresh && current - lastUnknownKidRefreshAt >= UNKNOWN_KID_REFRESH_MS) {
        lastUnknownKidRefreshAt = current;
        key = await keyFor(parsed.header.kid, fetchFn, true);
      }
      if (!key) return { ok: false };
      const publicKey = createPublicKey({ key, format: "jwk" });
      return { ok: verifySignature("RSA-SHA256", Buffer.from(parsed.signed, "ascii"), publicKey, parsed.signature) };
    } catch {
      // Token, key, and network errors all fail closed without putting security-sensitive input
      // in provider logs or response bodies.
      return { ok: false };
    }
  };

  async function keyFor(kid, fetchFn, forceRefresh) {
    const current = nowMilliseconds(now);
    if (!forceRefresh && cache && cache.expiresAt > current) return cache.keys.get(kid) || null;
    await refreshKeys(fetchFn);
    return cache?.keys.get(kid) || null;
  }

  async function refreshKeys(fetchFn) {
    if (inFlight) return await inFlight;
    inFlight = (async () => {
      const options = {
        headers: { accept: "application/json" },
        redirect: "error"
      };
      const signal = timeoutSignal(timeout);
      if (signal) options.signal = signal;
      const response = await fetchFn(endpoint, options);
      if (!response?.ok || typeof response.json !== "function") throw new Error("Google OIDC JWKS request failed");
      const payload = await response.json();
      if (!Array.isArray(payload?.keys)) throw new Error("Google OIDC JWKS response is invalid");
      const keys = new Map();
      for (const candidate of payload.keys) {
        const normalized = normalizedRsaSigningKey(candidate);
        if (normalized && !keys.has(normalized.kid)) keys.set(normalized.kid, normalized);
      }
      if (keys.size === 0) throw new Error("Google OIDC JWKS response has no signing keys");
      const advertisedCacheMs = cacheControlMaxAge(response.headers);
      const ttl = advertisedCacheMs == null ? fallbackCacheMs : Math.min(advertisedCacheMs, maximumCacheMs);
      cache = { keys, expiresAt: nowMilliseconds(now) + ttl };
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  }
}

// Direct consumers can use this default verifier, while a plugin instance creates its own
// cache so injected test/request fetch functions never leak across host instances.
export const verifyGoogleOidcToken = createGoogleOidcVerifier();

function parseJwt(token) {
  if (typeof token !== "string" || token.length < 16 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const header = decodeJson(parts[0], 4 * 1024);
  const claims = decodeJson(parts[1], 8 * 1024);
  const signature = Buffer.from(parts[2], "base64url");
  if (!plainObject(header) || !plainObject(claims) || signature.length < 128 || signature.length > 1024) return null;
  return { header, claims, signature, signed: `${parts[0]}.${parts[1]}` };
}

function decodeJson(value, maximumLength) {
  if (value.length > maximumLength || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length === 0 || decoded.length > maximumLength) return null;
    return JSON.parse(decoded.toString("utf8"));
  } catch {
    return null;
  }
}

function validTimes(claims, now, skew, maximumLifetime) {
  const current = Math.floor(nowMilliseconds(now) / 1000);
  const exp = numericDate(claims.exp);
  const issuedAt = numericDate(claims.iat);
  const notBefore = claims.nbf == null ? null : numericDate(claims.nbf);
  if (exp == null || issuedAt == null || exp < current - skew || issuedAt > current + skew) return false;
  if (Object.prototype.hasOwnProperty.call(claims, "nbf") && notBefore == null) return false;
  if (issuedAt > exp + skew || exp - issuedAt > maximumLifetime + skew) return false;
  if (notBefore != null && (notBefore > current + skew || notBefore > exp + skew)) return false;
  return true;
}

function normalizedRsaSigningKey(value) {
  if (!plainObject(value) || value.kty !== "RSA" || (value.use && value.use !== "sig") || (value.alg && value.alg !== "RS256")) return null;
  const kid = boundedText(value.kid, 200);
  const n = boundedText(value.n, 8 * 1024);
  const e = boundedText(value.e, 64);
  if (!kid || !n || !e || !/^[A-Za-z0-9_-]+$/.test(n) || !/^[A-Za-z0-9_-]+$/.test(e)) return null;
  return { kty: "RSA", kid, n, e, ...(value.use ? { use: "sig" } : {}), ...(value.alg ? { alg: "RS256" } : {}) };
}

function cacheControlMaxAge(headers) {
  const cacheControl = headerValue(headers, "cache-control");
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?:,|$)/i.exec(cacheControl);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) && seconds <= Math.floor(Number.MAX_SAFE_INTEGER / 1000) ? seconds * 1000 : null;
}

function headerValue(headers, name) {
  if (headers?.get) return String(headers.get(name) || "");
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === name) return Array.isArray(value) ? String(value[0] || "") : String(value || "");
  }
  return "";
}

function exactAudience(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 2_048 ? value : "";
}

function normalizedServiceAccountEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9][a-z0-9._%+-]{0,127}@[a-z0-9.-]{1,190}\.[a-z]{2,63}$/i.test(email) ? email : "";
}

function matchesServiceAccount(claims, expectedEmail) {
  const email = normalizedServiceAccountEmail(claims?.email);
  return Boolean(email && email === expectedEmail && claims?.email_verified === true);
}

function numericDate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.floor(value) : null;
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : "";
}

function boundedMilliseconds(value, fallback, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), maximum) : fallback;
}

function boundedSeconds(value, fallback, maximum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), maximum) : fallback;
}

function nowMilliseconds(now) {
  const value = typeof now === "function" ? Number(now()) : Number(now);
  return Number.isFinite(value) && value >= 0 ? value : Date.now();
}

function validHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === "https:";
  } catch {
    return false;
  }
}

function timeoutSignal(milliseconds) {
  return typeof globalThis.AbortSignal?.timeout === "function" ? globalThis.AbortSignal.timeout(milliseconds) : null;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
