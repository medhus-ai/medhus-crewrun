import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import { createBudgetLedger, DEFAULT_PRICING } from "../src/budget.js";

function memoryLedger(options = {}) {
  const db = new Database(":memory:");
  return createBudgetLedger({ getDb: () => db, describeSource: () => ":memory:", ...options });
}

test("recordRun appends normalized rows and readRuns returns them in order", () => {
  const ledger = memoryLedger();
  ledger.recordRun({ workflow: "cockpit-chat", repository: "demo", runnerId: "claude-agent-sonnet-high", engine: "claude-agent", provider: "anthropic", ref: "chat-planner", actor: "b", result: "done", durationSeconds: 12, usage: { inputTokens: 1000, outputTokens: 200, costUsd: null } });
  ledger.recordRun({ repository: "demo", runnerId: "openrouter-auto", engine: "claude-agent", provider: "openrouter", result: "done", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02 } });
  const runs = ledger.readRuns();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].issue_or_pr, "chat-planner");
  assert.equal(runs[0].month, runs[0].timestamp.slice(0, 7));
  assert.equal(runs[0].cost_usd, null);
  assert.equal(runs[1].cost_usd, 0.02);
  assert.equal(ledger.source(), ":memory:");
});

test("report estimates subscription cost from pricing and aggregates by project, engine, runner", () => {
  const ledger = memoryLedger();
  const month = "2026-08";
  const report = ledger.report([
    { month, timestamp: "2026-08-01T00:00:00Z", repository: "a", engine: "claude-agent", runner_id: "claude-agent-sonnet-high", result: "done", input_tokens: 1_000_000, output_tokens: 100_000, cost_usd: null },
    { month, timestamp: "2026-08-02T00:00:00Z", repository: "a", engine: "codex-agent", runner_id: "codex-agent-high", result: "failed", input_tokens: 50, output_tokens: 5, cost_usd: 0.5 },
    { month: "2026-07", timestamp: "2026-07-02T00:00:00Z", repository: "b", engine: "cli", runner_id: "x", result: "done", input_tokens: 1, output_tokens: 1, cost_usd: null }
  ]);
  assert.deepEqual(report.months.map((m) => m.month), ["2026-08", "2026-07"]);
  const aug = report.months[0];
  assert.equal(aug.totals.runs, 2);
  assert.equal(aug.totals.failures, 1);
  assert.equal(aug.totals.costUsd, 0.5);
  // 1Mtok in @ $3 + 0.1Mtok out @ $15 = $4.50 estimated for the subscription run.
  assert.equal(aug.totals.estimatedCostUsd, 4.5);
  assert.deepEqual(aug.byProject.map((row) => row.key), ["a"]);
  assert.deepEqual(aug.byEngine.map((row) => row.key).sort(), ["claude-agent", "codex-agent"]);
  assert.equal(ledger.estimateCostUsd("unknown-runner", 100, 100), null);
});

test("pricing is host-overridable and getDb is required", () => {
  const ledger = memoryLedger({ pricing: [{ prefix: "my-", inputPerMtok: 1, outputPerMtok: 2 }] });
  assert.equal(ledger.estimateCostUsd("my-runner", 1_000_000, 1_000_000), 3);
  assert.ok(DEFAULT_PRICING.some((rate) => rate.prefix === "claude-agent-sonnet"));
  assert.throws(() => createBudgetLedger({}), /getDb/);
});
