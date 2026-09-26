import { randomBytes, timingSafeEqual } from "node:crypto";

const secret = () => randomBytes(32).toString("base64url");
const equal = (a, b) => typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const LOGIN = '<!doctype html><meta charset="utf-8"><title>CrewRun · Sign in</title><main style="max-width:28rem;margin:12vh auto;font:16px system-ui"><h1>CrewRun</h1><p>Generate a single-use code with <code>CrewRun --login</code> on the host, then enter it here.</p><form method="post" action="/_crew/login"><label>Access code <input name="code" type="password" required autocomplete="off"></label><button>Connect</button></form></main>';

// Console sessions are not provider credentials. Everything is in-memory and
// expires on restart. The persistent control secret never enters renderer code.
export function createConsoleAccess({ controlToken, identity, onStop, now = Date.now }) {
  const sessions = new Map(), codes = new Map();
  const cookieName = `crew_${identity.slice(0, 16)}`;
  const cleanup = (map) => { for (const [key, expiry] of map) if (expiry <= now()) map.delete(key); };
  function session() {
    cleanup(sessions);
    if (sessions.size >= 64) throw new Error("Too many console sessions; stop the runner to revoke all sessions");
    const value = secret(); sessions.set(value, now() + 12 * 60 * 60 * 1000);
    return { name: cookieName, value };
  }
  const cookieHeader = (cookie) => `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`;
  function loginCode() {
    cleanup(codes);
    if (codes.size >= 16) throw new Error("Too many pending login codes; wait for expiry");
    const code = secret(); codes.set(code, now() + 5 * 60 * 1000); return code;
  }
  const json = (response, value) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
  return async function access(request, response, url) {
    // no-referrer makes browsers send Origin: null on form POST navigation,
    // which correctly fails the console's CSRF check. Preserve same-origin
    // form provenance while still withholding referrers from external sites.
    response.setHeader("referrer-policy", "same-origin");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    cleanup(sessions); cleanup(codes);
    if (url.pathname.startsWith("/_crew/control/")) {
      if (request.method !== "POST" || !equal(request.headers.authorization, `Bearer ${controlToken}`)) {
        response.writeHead(403).end("Forbidden"); return false;
      }
      const action = url.pathname.slice("/_crew/control/".length);
      if (action === "status") json(response, { protocol: 1, identity, pid: process.pid });
      else if (action === "session") json(response, { cookie: session() });
      else if (action === "login-code") json(response, { code: loginCode() });
      else if (action === "stop") { json(response, { stopping: true }); setImmediate(onStop); }
      else response.writeHead(404).end("Not found");
      return false;
    }
    if (url.pathname === "/_crew/login" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 1024) { response.writeHead(413).end("Too large"); return false; }
      }
      const code = new URLSearchParams(body).get("code");
      if (!codes.delete(code)) { response.writeHead(403).end("Invalid or expired code"); return false; }
      response.setHeader("set-cookie", cookieHeader(session()));
      response.writeHead(303, { location: "/" }).end(); return false;
    }
    const cookies = String(request.headers.cookie || "").split(";").map((part) => part.trim());
    const value = cookies.find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (sessions.has(value)) return true;
    response.writeHead(request.method === "GET" ? 200 : 401, { "content-type": "text/html; charset=utf-8" }).end(LOGIN);
    return false;
  };
}
