import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Must be set before the modules read the paths.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "crew-routing-test-"));
process.env.CREW_SECRETS_FILE = path.join(tmpRoot, "secrets.json");
process.env.CREW_RUNNERS_FILE = path.join(tmpRoot, "ai-runners.json");

const store = await import("../src/secret-store.js");
const { addLocalRunner, resolveRunnerProfile, runnerCatalog } = await import("../src/runner-config.js");
const { createClaudeAgentEngine } = await import("../src/engines/claude-agent.js");
const { createCodexAgentEngine } = await import("../src/engines/codex-agent.js");

const PASSWORD = "routing test pass 1";

after(async () => {
  store.resetSecretStoreForTests();
  await rm(tmpRoot, { recursive: true, force: true });
});

function fakeClaudeQuery(captured, messages) {
  return async function* query({ prompt, options }) {
    captured.prompt = prompt;
    captured.options = options;
    yield* messages;
  };
}

const OK_RESULT = { type: "result", subtype: "success", is_error: false, result: "ok", usage: {} };

function runTurn(engine, profile) {
  return new Promise((resolve, reject) => {
    engine.startTurn({
      profile,
      workdir: "/tmp/anywhere",
      role: "planner",
      mode: "propose",
      systemPrompt: "system!",
      prompt: "hello",
      onClose: resolve,
      onError: reject
    });
  });
}

test("anthropicRouteEnv maps provider keys to the Anthropic env contract", () => {
  store.unlock(PASSWORD);
  store.setSecret("GLM_API_KEY", "glm-key-1");
  store.setSecret("glm-personal", "glm-key-2");

  const glm = resolveRunnerProfile("glm-4.7");
  assert.deepEqual(store.anthropicRouteEnv(glm), {
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: "glm-key-1"
  });
  // secret_ref wins over the provider default key.
  assert.equal(store.anthropicRouteEnv({ ...glm, secret_ref: "glm-personal" }).ANTHROPIC_AUTH_TOKEN, "glm-key-2");
  // Local servers route without a key (Ollama needs none).
  assert.deepEqual(
    store.anthropicRouteEnv({ provider: "local", base_url: "http://localhost:11434" }),
    { ANTHROPIC_BASE_URL: "http://localhost:11434" }
  );
  // No base_url → no routing; subscription/ambient auth stays untouched.
  assert.deepEqual(store.anthropicRouteEnv({ provider: "anthropic", model: "sonnet" }), {});

  store.lock();
  // Locked store still routes the URL, just without a token.
  assert.deepEqual(store.anthropicRouteEnv(glm), { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" });
});

test("GLM and Kimi presets are in the picker and resolve with base_url", () => {
  const providers = runnerCatalog().map((group) => group.provider);
  assert.ok(providers.includes("glm"));
  assert.ok(providers.includes("kimi"));

  const kimi = resolveRunnerProfile("kimi-k2.7");
  assert.equal(kimi.engine, "claude-agent");
  assert.equal(kimi.base_url, "https://api.moonshot.ai/anthropic");
  assert.equal(kimi.model, "kimi-k2.7-code");
});

test("local runners validate, persist, and appear in the picker", () => {
  assert.throws(() => addLocalRunner({ id: "bad", base_url: "localhost:1234", model: "m" }), /http/);
  assert.throws(() => addLocalRunner({ id: "bad", base_url: "http://localhost:1234", model: "" }), /model is required/);

  addLocalRunner({ id: "ollama-qwen", base_url: "http://localhost:11434", model: "qwen3-coder:30b" });
  const local = runnerCatalog().find((group) => group.provider === "local");
  assert.ok(local.models.some((model) => model.model === "qwen3-coder:30b"));
  assert.equal(resolveRunnerProfile("ollama-qwen").base_url, "http://localhost:11434");
});

test("claude-agent routes env for base_url profiles and leaves others alone", async () => {
  store.unlock(PASSWORD);
  store.setSecret("MOONSHOT_API_KEY", "kimi-key");

  const routed = {};
  await runTurn(
    createClaudeAgentEngine({ loadQuery: async () => fakeClaudeQuery(routed, [OK_RESULT]) }),
    resolveRunnerProfile("kimi-k2.7")
  );
  assert.equal(routed.options.model, "kimi-k2.7-code");
  assert.equal(routed.options.env.ANTHROPIC_BASE_URL, "https://api.moonshot.ai/anthropic");
  assert.equal(routed.options.env.ANTHROPIC_AUTH_TOKEN, "kimi-key");
  assert.equal(routed.options.env.PATH, process.env.PATH); // process env inherited, not replaced

  const plain = {};
  await runTurn(
    createClaudeAgentEngine({ loadQuery: async () => fakeClaudeQuery(plain, [OK_RESULT]) }),
    { id: "claude-agent-sonnet-high", provider: "anthropic", model: "sonnet", reasoning_effort: "high" }
  );
  assert.equal(plain.options.env, undefined);
});

test("discovered GLM/Kimi/local models become routed picker profiles", () => {
  writeFileSync(path.join(tmpRoot, "model-catalog.json"), JSON.stringify({
    version: 1,
    updated_at: new Date().toISOString(),
    providers: {
      glm: [{ model: "glm-4.7", label: "glm-4.7", efforts: [] }, { model: "glm-5.2", label: "glm-5.2", efforts: [] }],
      kimi: [{ model: "kimi-k2.7-code", label: "kimi-k2.7-code", efforts: [] }],
      local: [
        { model: "qwen3-coder:30b", label: "qwen3-coder:30b", efforts: [], base_url: "http://localhost:11434" },
        { model: "no-server", label: "no-server", efforts: [] } // no base_url → skipped
      ]
    }
  }));

  // Discovered glm-4.7 shares the built-in preset id; new models get their own.
  const glm52 = resolveRunnerProfile("glm-5.2");
  assert.equal(glm52.base_url, "https://api.z.ai/api/anthropic");
  assert.equal(glm52.model, "glm-5.2");
  const localQwen = resolveRunnerProfile("local-qwen3-coder-30b");
  assert.equal(localQwen.base_url, "http://localhost:11434");
  assert.equal(resolveRunnerProfile("local-no-server"), null);

  const catalog = runnerCatalog();
  const glmGroup = catalog.find((group) => group.provider === "glm");
  assert.deepEqual(glmGroup.models.map((model) => model.model), ["glm-4.7", "glm-5.2"]);
  assert.ok(catalog.find((group) => group.provider === "kimi").models.some((model) => model.model === "kimi-k2.7-code"));
});

test("codex-agent passes baseUrl and apiKey only for routed profiles while isolating every turn", async () => {
  store.unlock(PASSWORD);
  store.setSecret("OPENAI_API_KEY", "sk-vllm");

  const seen = [];
  class FakeCodex {
    constructor(options = {}) { seen.push(options); }
    startThread() {
      return { run: async () => ({ finalResponse: "OK" }) };
    }
  }
  const engine = createCodexAgentEngine({ loadCodex: async () => FakeCodex });

  await engine.healthcheck({ id: "vllm-qwen", provider: "openai", base_url: "http://localhost:8000/v1", model: "qwen3" });
  assert.equal(seen[0].baseUrl, "http://localhost:8000/v1");
  assert.equal(seen[0].apiKey, "sk-vllm");

  await engine.healthcheck({ id: "codex-agent-high", provider: "openai" });
  assert.equal(seen[1].baseUrl, undefined);
  assert.equal(seen[1].apiKey, undefined);
  assert.equal(seen[1].config.features.memories, false);
  assert.equal(seen[1].config.features.multi_agent, false);
  assert.equal(seen[1].config.memories.use_memories, false);
  assert.equal(seen[1].env.GH_TOKEN, undefined);
});
