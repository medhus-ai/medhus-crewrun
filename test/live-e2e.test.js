// Opt-in tests that exercise real provider sessions. They never run
// in the normal suite: set CREW_LIVE_E2E=1 plus one or more provider flags.
// See README → Live integration tests for setup.
import assert from "node:assert/strict";
import test from "node:test";

import { createClaudeAgentEngine } from "../src/engines/claude-agent.js";
import { createCodexAgentEngine } from "../src/engines/codex-agent.js";

const LIVE = process.env.CREW_LIVE_E2E === "1";
const LIVE_TIMEOUT_MS = 120_000;
const CLAUDE_LIVE_TIMEOUT_MS = 75_000;
const CODEX_LIVE_TIMEOUT_MS = 75_000;

function requested(t, name, setup) {
  if (!LIVE || process.env[`CREW_LIVE_${name}`] !== "1") {
    t.skip(`set CREW_LIVE_E2E=1 CREW_LIVE_${name}=1 to run this live check (${setup})`);
    return false;
  }
  return true;
}

test("live Claude Agent SDK uses the signed-in subscription", { timeout: CLAUDE_LIVE_TIMEOUT_MS }, async (t) => {
  if (!requested(t, "CLAUDE", "sign in with `claude`")) return;
  const result = await createClaudeAgentEngine().healthcheck({
    id: "live-claude-subscription",
    provider: "anthropic",
    auth: "subscription"
  }, { timeoutMs: 60_000 });
  assert.equal(result.ok, true, result.message);
});

test("live Codex SDK uses the signed-in ChatGPT subscription", { timeout: CODEX_LIVE_TIMEOUT_MS }, async (t) => {
  if (!requested(t, "CODEX", "sign in with `codex login`")) return;
  const result = await createCodexAgentEngine().healthcheck({
    id: "live-codex-subscription",
    provider: "openai",
    auth: "subscription"
  }, { timeoutMs: 60_000 });
  assert.equal(result.ok, true, result.message);
});

test("live OpenRouter route reaches a tool-capable model", { timeout: LIVE_TIMEOUT_MS }, async (t) => {
  if (!requested(t, "OPENROUTER", "set OPENROUTER_API_KEY")) return;
  if (!process.env.OPENROUTER_API_KEY) {
    t.skip("OPENROUTER_API_KEY is not set");
    return;
  }
  const result = await createClaudeAgentEngine().healthcheck({
    id: "live-openrouter",
    provider: "openrouter",
    base_url: "https://openrouter.ai/api",
    model: process.env.CREW_LIVE_OPENROUTER_MODEL || "openrouter/auto",
    auth: "api-key"
  });
  assert.equal(result.ok, true, result.message);
});
