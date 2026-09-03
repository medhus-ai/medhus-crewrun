import net from "node:net";

// Web access for roles — off by default, opted into per role in the spec:
//
//   "web": true                                        open web, fetch + search
//   "web": { "allow": ["*.arxiv.org", "github.com"] }  fetch only hosts that match; search stays on
//   "web": { "search": false, "max_chars": 20000 }     fetch only, smaller pages
//
// The kernel exposes it as two built-in tools (`web.fetch`, `web.search`) that appear on a
// role's bridge only when its spec enables them. Fetches are read-only GETs over http(s), follow
// a bounded number of redirects (each hop re-checked against the allowlist), refuse literal
// private/loopback addresses, and return page text (HTML stripped) capped at max_chars.
// Search uses DuckDuckGo's HTML endpoint — no API key — and returns title/url/snippet rows.

export const DEFAULT_MAX_CHARS = 40_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20_000;
const SEARCH_URL = "https://html.duckduckgo.com/html/?q=";
const USER_AGENT = "crewrun/1 (+https://github.com/medhus-ai/medhus-crewrun)";

// false | true | { allow?: string[], search?: boolean, max_chars?: number } → normalized or false.
export function normalizeWeb(value) {
  if (value == null || value === false) return false;
  if (value === true) return { allow: [], search: true, max_chars: DEFAULT_MAX_CHARS };
  if (typeof value !== "object") return false;
  if (value.enabled === false) return false;
  const allow = Array.isArray(value.allow) ? value.allow.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean) : [];
  const maxChars = Number(value.max_chars);
  return {
    allow,
    search: value.search !== false,
    max_chars: Number.isFinite(maxChars) && maxChars > 0 ? Math.min(Math.round(maxChars), 500_000) : DEFAULT_MAX_CHARS
  };
}

// Host allowlist: exact host, or "*.example.com" matching the apex and any subdomain.
export function hostAllowed(hostname, allow = []) {
  if (!allow.length) return true;
  const host = String(hostname || "").toLowerCase();
  return allow.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const apex = pattern.slice(2);
      return host === apex || host.endsWith(`.${apex}`);
    }
    return host === pattern;
  });
}

function assertPublicTarget(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`web.fetch only supports http(s) URLs (got ${url.protocol})`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("web.fetch refuses local hosts");
  if (net.isIP(host)) {
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === "::1" || /^f[cd]/i.test(host) || /^fe80/i.test(host)) {
      throw new Error("web.fetch refuses private or loopback addresses");
    }
  }
}

// Crude but dependency-free: drop scripts/styles, turn block tags into newlines, strip the rest.
export function htmlToText(html) {
  return String(html || "")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<title[\s\S]*?<\/title>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article|header|footer|blockquote|pre|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleOf(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]).slice(0, 200) : "";
}

async function getWithRedirects(startUrl, { allow, fetchImpl, signal }) {
  let url = new URL(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertPublicTarget(url);
    if (!hostAllowed(url.hostname, allow)) throw new Error(`web.fetch: ${url.hostname} is not in this role's allowlist`);
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`web.fetch: redirect without location from ${url.hostname}`);
      url = new URL(location, url);
      continue;
    }
    return { response, url };
  }
  throw new Error(`web.fetch: more than ${MAX_REDIRECTS} redirects`);
}

// → { url, status, title, content_type, text, truncated }
export async function webFetch({ url, allow = [], maxChars = DEFAULT_MAX_CHARS, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!url || typeof url !== "string") throw new Error("web.fetch needs a url");
  if (typeof fetchImpl !== "function") throw new Error("web.fetch: no fetch implementation available (Node 18+ required)");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { response, url: finalUrl } = await getWithRedirects(url, { allow, fetchImpl, signal: controller.signal });
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const body = await response.text();
    const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body.slice(0, 200));
    const text = isHtml ? htmlToText(body) : body;
    return {
      url: finalUrl.toString(),
      status: response.status,
      title: isHtml ? titleOf(body) : "",
      content_type: contentType.split(";")[0] || "unknown",
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars
    };
  } finally {
    clearTimeout(timer);
  }
}

// Parse DuckDuckGo's HTML results page into rows. Result links are redirect wrappers
// (//duckduckgo.com/l/?uddg=<encoded target>), so the real URL is decoded out of `uddg`.
export function parseSearchResults(html, maxResults = 8) {
  const rows = [];
  const blocks = String(html || "").split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    let href = link[1].replace(/&amp;/g, "&");
    const wrapped = href.match(/[?&]uddg=([^&]+)/);
    if (wrapped) { try { href = decodeURIComponent(wrapped[1]); } catch { /* keep raw */ } }
    if (href.startsWith("//")) href = `https:${href}`;
    if (!/^https?:\/\//i.test(href)) continue;
    const snippet = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<(?:div|span)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i);
    rows.push({ title: htmlToText(link[2]), url: href, snippet: snippet ? htmlToText(snippet[1]) : "" });
    if (rows.length >= maxResults) break;
  }
  return rows;
}

// → { query, results: [{ title, url, snippet }] }
export async function webSearch({ query, maxResults = 8, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const text = String(query || "").trim();
  if (!text) throw new Error("web.search needs a query");
  if (typeof fetchImpl !== "function") throw new Error("web.search: no fetch implementation available (Node 18+ required)");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${SEARCH_URL}${encodeURIComponent(text)}`, {
      method: "GET",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html" }
    });
    if (!response.ok) throw new Error(`web.search: search endpoint returned ${response.status}`);
    const limit = Math.max(1, Math.min(Number(maxResults) || 8, 20));
    return { query: text, results: parseSearchResults(await response.text(), limit) };
  } finally {
    clearTimeout(timer);
  }
}
