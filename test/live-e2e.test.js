// Opt-in tests that exercise real provider sessions and Docker. They never run
// in the normal suite: set CREW_LIVE_E2E=1 plus one or more provider flags.
// See README → Live integration tests for setup.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createContainerEngine } from "../src/engines/container.js";
import { createCliEngine } from "../src/engines/cli.js";
import { createClaudeAgentEngine } from "../src/engines/claude-agent.js";
import { createCodexAgentEngine } from "../src/engines/codex-agent.js";
import { normalizeExecutionPolicy } from "../src/execution-policy.js";

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

test("live Docker boundary keeps the container read-only and omits ambient credentials", { timeout: LIVE_TIMEOUT_MS }, async (t) => {
  if (!requested(t, "DOCKER", "start Docker")) return;
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  assert.equal(docker.status, 0, String(docker.stderr || docker.error?.message || "Docker is unavailable"));

  const root = mkdtempSync(path.join(os.tmpdir(), "crew-live-container-root-"));
  const workdir = mkdtempSync(path.join(os.tmpdir(), "crew-live-container-work-"));
  mkdirSync(path.join(root, ".git"));
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "crew-live-must-not-enter-container";
  try {
    const policy = normalizeExecutionPolicy({
      runtime: "container",
      image: process.env.CREW_LIVE_DOCKER_IMAGE || "node:20-bookworm",
      network: "none"
    });
    const engine = createContainerEngine(createCliEngine(), policy);
    const lines = [];
    const closed = await new Promise((resolve, reject) => {
      engine.startTurn({
        targetRoot: root,
        workdir,
        profile: {
          id: "live-container-cli",
          provider: "local",
          command: "node",
          args: ["-e", [
            "const fs = require('node:fs');",
            "let readOnly = false;",
            "try { fs.writeFileSync('/etc/crewrun-live-probe', 'x'); } catch { readOnly = true; }",
            "console.log(`CREW_CONTAINER_OK readonly=${readOnly} key=${process.env.OPENAI_API_KEY || 'none'}`);"
          ].join(" ")]
        },
        role: "engineer",
        mode: "execute",
        prompt: "print the boundary check",
        onLine: (line) => lines.push(String(line)),
        onError: reject,
        onClose: resolve
      });
    });
    assert.equal(closed.code, 0, closed.stderr);
    assert.ok(lines.some((line) => line.includes("CREW_CONTAINER_OK readonly=true key=none")), lines.join("\n"));
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    await rm(root, { recursive: true, force: true });
    await rm(workdir, { recursive: true, force: true });
  }
});
