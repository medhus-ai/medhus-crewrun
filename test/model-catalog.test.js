import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  claudeCatalogEntries,
  codexCatalogEntries,
  isCatalogFresh,
  loadModelCatalog,
  modelCatalogPath,
  openAiCompatEntries,
  refreshModelCatalog
} from "../src/model-catalog.js";
import {
  agentRunnerProfiles,
  discoveredRunnerProfiles,
  resolveRunnerProfile,
  runnerCatalog,
  runnerProfileLabel
} from "../src/runner-config.js";

const ORIGINAL_CATALOG_FILE = process.env.CREW_MODEL_CATALOG_FILE;
const ORIGINAL_RUNNERS_FILE = process.env.CREW_RUNNERS_FILE;
const TEST_DIR = path.join(os.tmpdir(), `crew-test-model-catalog-${process.pid}`);
const CATALOG_FILE = path.join(TEST_DIR, "model-catalog.json");
process.env.CREW_MODEL_CATALOG_FILE = CATALOG_FILE;
process.env.CREW_RUNNERS_FILE = path.join(TEST_DIR, "ai-runners.json");
mkdirSync(TEST_DIR, { recursive: true });

after(async () => {
  if (ORIGINAL_CATALOG_FILE === undefined) delete process.env.CREW_MODEL_CATALOG_FILE;
  else process.env.CREW_MODEL_CATALOG_FILE = ORIGINAL_CATALOG_FILE;
  if (ORIGINAL_RUNNERS_FILE === undefined) delete process.env.CREW_RUNNERS_FILE;
  else process.env.CREW_RUNNERS_FILE = ORIGINAL_RUNNERS_FILE;
  await rm(TEST_DIR, { recursive: true, force: true });
});

const CLAUDE_MODELS = [
  { value: "claude-fable-5[1m]", displayName: "Fable", description: "Most capable", supportedEffortLevels: ["high", "max"] },
  { value: "sonnet", displayName: "Sonnet", description: "Efficient", supportedEffortLevels: ["low", "high"] },
  { value: "haiku", displayName: "Haiku", description: "Fastest" },
  { value: "", displayName: "bogus" }
];

const CODEX_CATALOG = {
  models: [
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Frontier",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }]
    },
    { slug: "codex-auto-review", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: [] }
  ]
};

function writeCatalog(providers, updatedAt = new Date().toISOString()) {
  writeFileSync(CATALOG_FILE, JSON.stringify({ version: 1, updated_at: updatedAt, providers }));
}

test("vendor payloads map to catalog entries", () => {
  assert.deepEqual(claudeCatalogEntries(CLAUDE_MODELS), [
    { model: "claude-fable-5[1m]", label: "Fable", description: "Most capable", efforts: ["high", "max"] },
    { model: "sonnet", label: "Sonnet", description: "Efficient", efforts: ["low", "high"] },
    { model: "haiku", label: "Haiku", description: "Fastest", efforts: [] }
  ]);
  assert.deepEqual(codexCatalogEntries(CODEX_CATALOG), [
    { model: "gpt-5.5", label: "GPT-5.5", description: "Frontier", efforts: ["medium", "high"] }
  ]);
  assert.deepEqual(openAiCompatEntries({ data: [{ id: "glm-4.7" }, { id: " " }, { object: "list" }] }), [
    { model: "glm-4.7", label: "glm-4.7", description: "", efforts: [] }
  ]);
});

test("loadModelCatalog reads the override path and rejects malformed files", () => {
  assert.equal(modelCatalogPath(), CATALOG_FILE);
  writeFileSync(CATALOG_FILE, "not json");
  assert.equal(loadModelCatalog(), null);
  writeCatalog({ anthropic: claudeCatalogEntries(CLAUDE_MODELS) }, "2026-07-01T00:00:00Z");
  const catalog = loadModelCatalog();
  assert.equal(catalog.updated_at, "2026-07-01T00:00:00Z");
  assert.equal(catalog.providers.anthropic.length, 3);
});

test("isCatalogFresh honours the TTL", () => {
  assert.equal(isCatalogFresh({ updated_at: new Date().toISOString() }), true);
  assert.equal(isCatalogFresh({ updated_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() }), false);
  assert.equal(isCatalogFresh(null), false);
});

test("discovered models become runner profiles with sanitized ids", () => {
  writeCatalog({
    anthropic: claudeCatalogEntries(CLAUDE_MODELS),
    openai: codexCatalogEntries(CODEX_CATALOG)
  });
  const profiles = discoveredRunnerProfiles();
  const ids = profiles.map((profile) => profile.id);
  assert.ok(ids.includes("claude-agent-fable-5-1m-max"));
  assert.ok(ids.includes("claude-agent-sonnet-high"));
  assert.ok(ids.includes("claude-agent-haiku")); // effort-less model gets one profile
  assert.ok(ids.includes("codex-agent-gpt-5.5-high"));

  const fable = profiles.find((profile) => profile.id === "claude-agent-fable-5-1m-max");
  assert.equal(fable.runner.model, "claude-fable-5[1m]"); // raw id still reaches the SDK
  assert.equal(fable.displayName, "Claude Fable · Max");
  const haiku = profiles.find((profile) => profile.id === "claude-agent-haiku");
  assert.equal(haiku.runner.reasoning_effort, undefined);
});

test("discovered profiles win by id, built-ins stay resolvable", () => {
  writeCatalog({ anthropic: claudeCatalogEntries(CLAUDE_MODELS) });
  const profiles = agentRunnerProfiles();
  const sonnetHigh = profiles.find((profile) => profile.id === "claude-agent-sonnet-high");
  assert.equal(sonnetHigh.displayName, "Claude Sonnet · High"); // live label, not the stale built-in
  // Opus is absent from the discovered list but existing role mappings must keep resolving.
  assert.ok(resolveRunnerProfile("claude-agent-opus-high"));
  assert.equal(runnerProfileLabel("claude-agent-sonnet-high"), "Claude Sonnet · High");
});

test("runnerCatalog menus track the discovered catalog per provider", () => {
  writeCatalog({ anthropic: claudeCatalogEntries(CLAUDE_MODELS) });
  const catalog = runnerCatalog();
  const claude = catalog.find((group) => group.provider === "anthropic");
  assert.deepEqual(claude.models.map((model) => model.label), ["Fable", "Sonnet", "Haiku"]);
  const haiku = claude.models.find((model) => model.label === "Haiku");
  assert.deepEqual(haiku.options.map((option) => option.label), ["Default"]);
  // No codex discovery — the built-in Codex menu remains.
  const codex = catalog.find((group) => group.provider === "openai");
  assert.ok(codex.models.some((model) => model.label === "GPT-5.5"));
});

test("refreshModelCatalog merges per provider and keeps entries on partial failure", async () => {
  writeCatalog({ openai: codexCatalogEntries(CODEX_CATALOG) }, "2020-01-01T00:00:00Z");
  const result = await refreshModelCatalog({
    force: true,
    discoverClaude: async () => claudeCatalogEntries(CLAUDE_MODELS),
    discoverCodex: async () => { throw new Error("codex CLI not found"); }
  });
  assert.equal(result.refreshed, true);
  assert.deepEqual(result.errors, ["Codex: codex CLI not found"]);
  const written = JSON.parse(readFileSync(CATALOG_FILE, "utf8"));
  assert.equal(written.providers.anthropic.length, 3);
  assert.equal(written.providers.openai.length, 1); // preserved from the previous catalog

  // Fresh catalog short-circuits without force.
  const skipped = await refreshModelCatalog({
    discoverClaude: async () => { throw new Error("should not run"); },
    discoverCodex: async () => { throw new Error("should not run"); }
  });
  assert.equal(skipped.refreshed, false);
  assert.equal(skipped.errors.length, 0);

  // Total failure leaves the file untouched.
  const failed = await refreshModelCatalog({
    force: true,
    discoverClaude: async () => { throw new Error("claude down"); },
    discoverCodex: async () => []
  });
  assert.equal(failed.refreshed, false);
  assert.equal(failed.errors.length, 2);
});

test("keyed and local providers land in the catalog with base_url preserved", async () => {
  const result = await refreshModelCatalog({
    force: true,
    discoverClaude: async () => null,
    discoverCodex: async () => null,
    discoverGlm: async () => [{ model: "glm-4.7", label: "glm-4.7", description: "", efforts: [] }],
    discoverKimi: async () => null, // skipped (locked store) — silent, not an error
    discoverLocal: async () => [
      { model: "qwen3-coder:30b", label: "qwen3-coder:30b", description: "", efforts: [], base_url: "http://localhost:11434" }
    ]
  });
  assert.equal(result.refreshed, true);
  assert.deepEqual(result.errors, []);
  const catalog = loadModelCatalog();
  assert.equal(catalog.providers.glm[0].model, "glm-4.7");
  assert.equal(catalog.providers.local[0].base_url, "http://localhost:11434");
  assert.equal(catalog.providers.kimi, undefined);
});
