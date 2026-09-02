import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

import { createCrewrunTurnAdapter } from "../examples/slack/crewrun-adapter.mjs";
import { createEventDedupe, createSlackHost, createSlackPoster, promptText, verifySlackSignature } from "../examples/slack/host.mjs";

const SECRET = "slack-signing-secret";
const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const quietLogger = { log() {}, warn() {}, error() {} };

function signedPayload(payload, { secret = SECRET, now = NOW } = {}) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(now / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return { rawBody, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } };
}

function mention(overrides = {}) {
  return {
    type: "event_callback",
    event_id: "Ev-123",
    event: {
      type: "app_mention",
      user: "U_ALLOWED",
      channel: "C1",
      ts: "123.456",
      text: "<@B1> inspect the heat-stress report"
    },
    ...overrides
  };
}

function fixture(overrides = {}) {
  const queued = [];
  const calls = [];
  const posts = [];
  const gateway = createSlackHost({
    signingSecret: SECRET,
    users: { U_ALLOWED: { targetRoot: "/project", role: "analyst" } },
    runTurn: async (input) => {
      calls.push(input);
      return { text: "Here is the report summary." };
    },
    postMessage: async (input) => { posts.push(input); return { ok: true }; },
    dedupe: createEventDedupe({ now: () => NOW }),
    now: () => NOW,
    schedule: (work) => queued.push(work),
    logger: quietLogger,
    ...overrides
  });
  return { gateway, queued, calls, posts };
}

async function runQueued(fixture) {
  const work = fixture.queued.shift();
  assert.ok(work, "a turn was scheduled");
  work();
  await fixture.gateway.waitForIdle();
}

test("valid app mentions are acknowledged before the asynchronous role turn, deduplicated, and replied in-thread", async () => {
  const state = fixture();
  const request = signedPayload(mention());
  const response = state.gateway.receive(request);
  assert.equal(response.status, 200);
  assert.equal(state.calls.length, 0, "the runner was not awaited in the request path");
  assert.equal(state.posts.length, 0);
  assert.equal(state.queued.length, 1);

  const duplicate = state.gateway.receive(request);
  assert.equal(duplicate.status, 200);
  assert.equal(state.queued.length, 1, "the same event_id cannot schedule another turn");

  await runQueued(state);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].text, "inspect the heat-stress report");
  assert.deepEqual(state.posts, [{
    channel: "C1",
    threadTs: "123.456",
    text: "Here is the report summary."
  }]);
  assert.equal(promptText("<@B1> ask <@U2> for the data"), "ask <@U2> for the data");
});

test("invalid signatures and stale signed payloads are rejected before authorization or scheduling", () => {
  const state = fixture();
  const request = signedPayload(mention());
  const invalid = state.gateway.receive({ ...request, headers: { ...request.headers, "x-slack-signature": "v0=wrong" } });
  assert.equal(invalid.status, 401);
  assert.equal(state.queued.length, 0);

  const stale = signedPayload(mention(), { now: NOW - (6 * 60 * 1000) });
  assert.equal(state.gateway.receive(stale).status, 401);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, rawBody: request.rawBody, timestamp: request.headers["x-slack-request-timestamp"], signature: request.headers["x-slack-signature"], now: NOW }), true);
});

test("url verification succeeds, while unconfigured users are acknowledged but never sent to a role", () => {
  const state = fixture();
  const challenge = signedPayload({ type: "url_verification", challenge: "challenge-token" });
  const verified = state.gateway.receive(challenge);
  assert.equal(verified.status, 200);
  assert.equal(verified.body, "challenge-token");
  assert.equal(state.queued.length, 0);

  const unauthorized = signedPayload(mention({ event_id: "Ev-unauthorized", event: { ...mention().event, user: "U_OTHER" } }));
  assert.equal(state.gateway.receive(unauthorized).status, 200);
  assert.equal(state.queued.length, 0);
});

test("the HTTP handler verifies the raw request and returns before its queued turn", async () => {
  const state = fixture();
  const request = signedPayload(mention({ event_id: "Ev-http" }));
  const req = Readable.from([Buffer.from(request.rawBody)]);
  req.method = "POST";
  req.url = "/slack/events";
  req.headers = { "content-type": "application/json", ...request.headers };
  const response = await new Promise((resolve) => {
    const res = {
      writeHead: (status, headers) => { res.status = status; res.headers = headers; },
      end: (body) => resolve({ status: res.status, headers: res.headers, body: String(body || "") })
    };
    void state.gateway.handleRequest(req, res);
  });
  assert.equal(response.status, 200);
  assert.equal(state.calls.length, 0);
  assert.equal(state.queued.length, 1);
});

test("the Slack poster uses chat.postMessage through injected fetch without a network call", async () => {
  const calls = [];
  const post = createSlackPoster({
    botToken: "xoxb-test",
    fetch: async (...args) => {
      calls.push(args);
      return { ok: true, json: async () => ({ ok: true, ts: "1.2" }) };
    }
  });
  const response = await post({ channel: "C1", threadTs: "1.1", text: "hello" });
  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://slack.com/api/chat.postMessage");
  assert.equal(calls[0][1].headers.authorization, "Bearer xoxb-test");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    channel: "C1",
    text: "hello",
    unfurl_links: false,
    unfurl_media: false,
    thread_ts: "1.1"
  });
});

test("the crewrun adapter forwards the role configuration without imposing an auth mode", async () => {
  const calls = [];
  const runner = {
    runRoleCapture: async (input) => {
      calls.push(input);
      return { ok: true, text: "role reply" };
    }
  };
  const runTurn = createCrewrunTurnAdapter({ runner, timeoutMs: 12_000, log: () => {} });
  const result = await runTurn({
    user: { targetRoot: "/project", role: "analyst" },
    userId: "U_ALLOWED",
    text: "check this",
    channel: "C1",
    threadTs: "1.1",
    eventId: "Ev-adapter"
  });
  assert.deepEqual(result, { text: "role reply" });
  assert.equal(calls[0].root, "/project");
  assert.equal(calls[0].role, "analyst");
  assert.equal(calls[0].prompt, "check this");
  assert.equal(calls[0].timeoutMs, 12_000);
  assert.equal(calls[0].auth, undefined);
  assert.match(calls[0].context, /Slack user: U_ALLOWED/);
});
