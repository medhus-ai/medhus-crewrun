// A small Slack Events API gateway. It deliberately knows nothing about a particular crewrun
// project: the host supplies a user map and a runTurn adapter.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DEDUPE_EVENTS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_FAILURE_TEXT = "I couldn't complete that request. Please try again.";

// Verify Slack's v0 HMAC over the exact request bytes. A valid signature is necessary but not
// sufficient: a stale timestamp is rejected as a replay attempt too.
export function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, now = Date.now(), toleranceMs = DEFAULT_REPLAY_WINDOW_MS } = {}) {
  const secret = String(signingSecret || "");
  const ts = String(timestamp || "");
  const supplied = String(signature || "");
  const seconds = Number(ts);
  const nowMs = Number(typeof now === "function" ? now() : now);
  if (!secret || !/^\d+$/.test(ts) || !Number.isSafeInteger(seconds) || !Number.isFinite(nowMs)) return false;
  if (Math.abs(nowMs - (seconds * 1000)) > Math.max(0, Number(toleranceMs) || 0)) return false;

  const body = asBuffer(rawBody);
  const base = Buffer.concat([Buffer.from(`v0:${ts}:`, "utf8"), body]);
  const expected = `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
  const actualBuffer = Buffer.from(supplied, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

// Slack retries an event when it does not receive a fast 2xx response. This store records an
// event before a turn is started, so a retry cannot start a second turn. Pass `file` to retain
// that protection across restarts; its contents are only event ids and timestamps.
export function createEventDedupe({ file = "", ttlMs = DEFAULT_DEDUPE_TTL_MS, maxEntries = DEFAULT_MAX_DEDUPE_EVENTS, now = Date.now } = {}) {
  const stateFile = String(file || "").trim();
  const clock = typeof now === "function" ? now : () => now;
  const ttl = positiveNumber(ttlMs, DEFAULT_DEDUPE_TTL_MS);
  const limit = Math.max(1, Math.floor(positiveNumber(maxEntries, DEFAULT_MAX_DEDUPE_EVENTS)));
  const entries = readEntries(stateFile, clock, ttl, limit);

  function prune() {
    const cutoff = Number(clock()) - ttl;
    for (const [eventId, seenAt] of entries) {
      if (!Number.isFinite(seenAt) || seenAt < cutoff) entries.delete(eventId);
    }
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  }

  // Returns true only for a new id. Persistence happens before the caller is allowed to start
  // work, so a successful acknowledgement is never followed by a duplicate after a restart.
  function markIfNew(eventId) {
    const id = String(eventId || "").trim();
    if (!id || id.length > 255) throw new Error("Slack event_id is required");
    prune();
    if (entries.has(id)) return false;
    entries.set(id, Number(clock()));
    prune();
    try {
      persistEntries(stateFile, entries);
    } catch (error) {
      entries.delete(id);
      throw error;
    }
    return true;
  }

  return { markIfNew, size: () => entries.size };
}

// A minimal chat.postMessage client. `fetch` is injectable so hosts and tests never need a
// Slack SDK or a real network call.
export function createSlackPoster({ botToken, fetch: fetchFn = globalThis.fetch, apiUrl = "https://slack.com/api/chat.postMessage" } = {}) {
  const token = String(botToken || "").trim();
  if (!token) throw new Error("Slack botToken is required");
  if (typeof fetchFn !== "function") throw new Error("global fetch is unavailable; use Node 20+ or provide fetch");

  return async function postMessage({ channel, text, threadTs } = {}) {
    const channelId = String(channel || "").trim();
    const message = String(text || "").trim();
    if (!channelId) throw new Error("Slack channel is required");
    if (!message) throw new Error("Slack reply text is required");
    const body = { channel: channelId, text: clipSlackText(message), unfurl_links: false, unfurl_media: false };
    if (threadTs) body.thread_ts = String(threadTs);

    const response = await fetchFn(apiUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) {
      throw new Error(`Slack chat.postMessage failed: ${payload.error || response.status || "unknown error"}`);
    }
    return payload;
  };
}

// `users` is an explicit Slack-user-id → host configuration map. An event from anyone absent
// from it is acknowledged (so Slack does not retry) but never reaches the model.
//
// runTurn receives { event, envelope, user, userId, text, channel, threadTs, eventId } and
// returns either a reply string or { text }. It is deliberately scheduled after the HTTP reply.
export function createSlackHost({
  signingSecret,
  botToken,
  users,
  resolveUser,
  runTurn,
  postMessage,
  dedupe = createEventDedupe(),
  endpoint = "/slack/events",
  replayWindowMs = DEFAULT_REPLAY_WINDOW_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  failureText = DEFAULT_FAILURE_TEXT,
  logger = console,
  now = Date.now,
  schedule = (work) => setImmediate(work)
} = {}) {
  const secret = String(signingSecret || "").trim();
  if (!secret) throw new Error("Slack signingSecret is required");
  if (typeof runTurn !== "function") throw new Error("Slack runTurn adapter is required");
  if (typeof resolveUser !== "function" && (!users || userCount(users) === 0)) {
    throw new Error("Configure at least one Slack user or provide resolveUser(event)");
  }
  if (!dedupe || typeof dedupe.markIfNew !== "function") throw new Error("Slack dedupe must provide markIfNew(eventId)");
  if (typeof schedule !== "function") throw new Error("Slack schedule must be a function");

  const route = normalizeEndpoint(endpoint);
  const post = postMessage || createSlackPoster({ botToken });
  if (typeof post !== "function") throw new Error("Slack postMessage must be a function");
  const inFlight = new Set();
  const maximumBodyBytes = Math.max(1, Math.floor(positiveNumber(maxBodyBytes, DEFAULT_MAX_BODY_BYTES)));

  // Synchronous by design: it verifies, authorizes, deduplicates, queues, and returns an ACK.
  // The runner is never awaited here, which keeps Events API acknowledgements under Slack's 3 s limit.
  function receive({ headers = {}, rawBody } = {}) {
    const timestamp = headerValue(headers, "x-slack-request-timestamp");
    const signature = headerValue(headers, "x-slack-signature");
    if (!verifySlackSignature({ signingSecret: secret, timestamp, signature, rawBody, now, toleranceMs: replayWindowMs })) {
      return reply(401, "invalid Slack signature", { "x-slack-no-retry": "1" });
    }

    let envelope;
    try {
      envelope = JSON.parse(asBuffer(rawBody).toString("utf8"));
    } catch {
      return reply(400, "invalid JSON", { "x-slack-no-retry": "1" });
    }
    if (!envelope || typeof envelope !== "object") return reply(400, "invalid Slack payload", { "x-slack-no-retry": "1" });

    if (envelope.type === "url_verification") {
      const challenge = String(envelope.challenge || "");
      return challenge ? reply(200, challenge, { "content-type": "text/plain; charset=utf-8" }) : reply(400, "missing challenge");
    }
    if (envelope.type !== "event_callback") return reply(200);

    const event = envelope.event;
    if (!event || event.type !== "app_mention" || event.bot_id || event.subtype === "bot_message") return reply(200);
    const userId = String(event.user || "").trim();
    const user = configuredUser({ users, resolveUser, event, envelope, userId });
    if (!user) {
      log(logger, "warn", `Slack app_mention ignored for unconfigured user ${userId || "<missing>"}`);
      return reply(200);
    }

    const eventId = String(envelope.event_id || "").trim();
    const channel = String(event.channel || "").trim();
    const threadTs = String(event.thread_ts || event.ts || "").trim();
    if (!eventId || !channel || !threadTs) return reply(400, "incomplete Slack app_mention", { "x-slack-no-retry": "1" });

    try {
      if (!dedupe.markIfNew(eventId)) return reply(200);
    } catch (error) {
      log(logger, "error", "Slack event could not be deduplicated", error);
      return reply(500, "could not record Slack event");
    }

    const input = {
      event,
      envelope,
      user,
      userId,
      text: promptText(event.text),
      channel,
      threadTs,
      eventId
    };
    schedule(() => startAsyncTurn(input));
    return reply(200);
  }

  async function startAsyncTurn(input) {
    const task = (async () => {
      let postingReply = false;
      try {
        const text = replyText(await runTurn(input));
        if (!text) throw new Error("runner returned no reply text");
        postingReply = true;
        await post({ channel: input.channel, threadTs: input.threadTs, text });
      } catch (error) {
        log(logger, "error", `Slack turn failed for ${input.eventId}`, error);
        if (postingReply) return;
        try {
          await post({ channel: input.channel, threadTs: input.threadTs, text: failureText });
        } catch (postError) {
          log(logger, "error", `Slack failure reply could not be posted for ${input.eventId}`, postError);
        }
      }
    })();
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
    return task;
  }

  async function handleRequest(req, res) {
    const requestPath = new URL(req.url || "/", "http://localhost").pathname;
    if (req.method !== "POST" || requestPath !== route) {
      writeHttpResponse(res, reply(404, "not found"));
      return;
    }
    let rawBody;
    try {
      rawBody = await readRequestBody(req, maximumBodyBytes);
    } catch (error) {
      writeHttpResponse(res, reply(error?.code === "BODY_TOO_LARGE" ? 413 : 400, error?.message || "invalid request"));
      return;
    }
    writeHttpResponse(res, receive({ headers: req.headers, rawBody }));
  }

  function listen({ port = 3000, host = "127.0.0.1" } = {}) {
    const server = createServer((req, res) => { void handleRequest(req, res); });
    server.listen(Number(port), host);
    return server;
  }

  return {
    receive,
    handleRequest,
    listen,
    // Useful for graceful shutdown and deterministic tests. It only waits for turns that have
    // already begun; callers should stop accepting HTTP traffic first.
    waitForIdle: async () => {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    }
  };
}

export function promptText(text) {
  // Slack places the app mention first. Keep any later user mentions because they may be part
  // of the request (for example, "ask <@U123> for the data").
  const withoutBotMention = String(text || "").replace(/^\s*<@[A-Z0-9]+(?:\|[^>]+)?>\s*/i, "").trim();
  return withoutBotMention || "Please help with this request.";
}

function configuredUser({ users, resolveUser, event, envelope, userId }) {
  const value = typeof resolveUser === "function"
    ? resolveUser({ event, envelope, userId })
    : users instanceof Map ? users.get(userId) : users?.[userId];
  return value && typeof value === "object" && value.enabled !== false ? value : null;
}

function userCount(users) {
  return users instanceof Map ? users.size : Object.keys(users || {}).length;
}

function replyText(result) {
  if (typeof result === "string") return result.trim();
  if (result && typeof result === "object") return String(result.text || "").trim();
  return "";
}

function reply(status, body = "", headers = {}) {
  return { status, body: String(body || ""), headers };
}

function writeHttpResponse(res, response) {
  const headers = { "content-type": "text/plain; charset=utf-8", ...response.headers };
  res.writeHead(response.status, headers);
  res.end(response.body);
}

function headerValue(headers, name) {
  const wanted = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? String(value[0] || "") : String(value || "");
  }
  return "";
}

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value || ""), "utf8");
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeEndpoint(value) {
  const route = String(value || "").trim();
  return route.startsWith("/") ? route : `/${route}`;
}

function clipSlackText(text) {
  const max = 39_000;
  return text.length <= max ? text : `${text.slice(0, max - 16)}\n\n[reply truncated]`;
}

function log(logger, level, message, error) {
  const method = logger?.[level] || logger?.log;
  if (typeof method === "function") method.call(logger, error ? `${message}: ${error?.message || error}` : message);
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    const fail = (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("request body too large");
        error.code = "BODY_TOO_LARGE";
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!finished) {
        finished = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", fail);
  });
}

function readEntries(file, now, ttl, limit) {
  const entries = new Map();
  if (!file) return entries;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    for (const row of parsed?.events || []) {
      const [id, seenAt] = Array.isArray(row) ? row : [];
      if (typeof id === "string" && id && id.length <= 255 && Number.isFinite(Number(seenAt))) entries.set(id, Number(seenAt));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`could not read Slack event dedupe file: ${error?.message || error}`);
  }
  const cutoff = Number(now()) - ttl;
  for (const [id, seenAt] of entries) {
    if (seenAt < cutoff) entries.delete(id);
  }
  while (entries.size > limit) entries.delete(entries.keys().next().value);
  return entries;
}

function persistEntries(file, entries) {
  if (!file) return;
  const target = path.resolve(file);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, events: [...entries] })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort only */ }
    throw error;
  }
}
