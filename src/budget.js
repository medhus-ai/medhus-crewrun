// Token/cost usage ledger shared by every crew host. One row per agent run so concurrent
// writers append atomically; cost_usd is null on subscription auth and estimated in reports.

// USD/Mtok rates for estimating API-equivalent cost on subscription runs; more-specific
// prefixes must precede shorter ones. Hosts override via createBudgetLedger({ pricing }).
export const DEFAULT_PRICING = [
  { prefix: "claude-agent-sonnet", inputPerMtok: 3, outputPerMtok: 15 },
  { prefix: "claude-agent-opus", inputPerMtok: 15, outputPerMtok: 75 },
  // Code Spark has no dedicated OpenAI pricing row; proxy with GPT-5.4 mini rate until one is published.
  { prefix: "codex-agent-spark", inputPerMtok: 0.75, outputPerMtok: 4.5 },
  { prefix: "codex-agent", inputPerMtok: 5, outputPerMtok: 30 }
];

const FAILURE_RESULTS = new Set(["failed", "fail", "error", "errored"]);

const INSERT_SQL = `INSERT INTO budget_runs
  (month, timestamp, workflow, repository, runner_id, engine, provider, issue_or_pr, actor, result, duration_seconds, input_tokens, output_tokens, cost_usd)
  VALUES (@month, @timestamp, @workflow, @repository, @runner_id, @engine, @provider, @issue_or_pr, @actor, @result, @duration_seconds, @input_tokens, @output_tokens, @cost_usd)`;

// `getDb` returns a better-sqlite3-compatible handle (prepare/exec); the host owns the file,
// so GitCrew keeps its rows in cockpit.db and another host can use its own database.
export function createBudgetLedger({ getDb, describeSource = () => "", pricing = DEFAULT_PRICING } = {}) {
  if (typeof getDb !== "function") throw new Error("createBudgetLedger requires a getDb() handle");

  function ensure() {
    const db = getDb();
    const existed = db.prepare("PRAGMA table_info(budget_runs)").all().length > 0;
    if (!existed) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS budget_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          month TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          workflow TEXT,
          repository TEXT,
          runner_id TEXT,
          engine TEXT,
          provider TEXT,
          issue_or_pr TEXT,
          actor TEXT,
          result TEXT,
          duration_seconds REAL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost_usd REAL
        );
        CREATE INDEX IF NOT EXISTS idx_budget_runs_month ON budget_runs (month);
      `);
    }
    return db;
  }

  function recordRun({ workflow, repository, runnerId, engine, provider, ref, actor, result, durationSeconds, usage } = {}) {
    const timestamp = new Date().toISOString();
    // month is derived from the timestamp so reports group by an indexed column.
    const row = {
      month: timestamp.slice(0, 7),
      timestamp,
      workflow: workflow ?? null,
      repository: repository ?? null,
      runner_id: runnerId ?? null,
      engine: engine ?? null,
      provider: provider ?? null,
      issue_or_pr: ref ?? null,
      actor: actor ?? null,
      result: result ?? null,
      duration_seconds: durationSeconds ?? null,
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null,
      cost_usd: usage?.costUsd ?? null
    };
    ensure().prepare(INSERT_SQL).run(row);
    return row;
  }

  function readRuns() {
    return ensure().prepare("SELECT * FROM budget_runs ORDER BY timestamp ASC, id ASC").all();
  }

  function source() {
    ensure();
    return describeSource();
  }

  function estimateCostUsd(runnerId, inputTokens, outputTokens) {
    const rate = pricing.find((p) => String(runnerId || "").startsWith(p.prefix));
    if (!rate || !inputTokens) return null;
    return (inputTokens * rate.inputPerMtok + (outputTokens || 0) * rate.outputPerMtok) / 1_000_000;
  }

  function report(runs = readRuns()) {
    const byMonth = new Map();
    for (const run of runs) {
      const month = run.month || String(run.timestamp || "").slice(0, 7);
      if (!month) continue;
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(run);
    }
    const months = [...byMonth.entries()]
      .map(([month, monthRuns]) => summarizeMonth(month, monthRuns))
      .sort((a, b) => b.month.localeCompare(a.month));
    const currentMonth = new Date().toISOString().slice(0, 7);
    return {
      source: source(),
      months,
      current: months.find((m) => m.month === currentMonth) || null
    };
  }

  function summarizeMonth(month, runs) {
    const totals = emptyTotals();
    const byProject = new Map();
    const byEngine = new Map();
    const byRunner = new Map();

    for (const run of runs) {
      const inputTokens = numberOrZero(run.input_tokens);
      const outputTokens = numberOrZero(run.output_tokens);
      const reportedCost = run.cost_usd;
      const isSubscription = reportedCost === null || reportedCost === undefined;
      const usage = {
        runs: 1,
        failures: FAILURE_RESULTS.has(String(run.result || "").toLowerCase()) ? 1 : 0,
        inputTokens,
        outputTokens,
        costUsd: isSubscription ? 0 : numberOrZero(reportedCost),
        estimatedCostUsd: isSubscription ? (estimateCostUsd(run.runner_id, inputTokens, outputTokens) || 0) : 0,
        durationSeconds: numberOrZero(run.duration_seconds)
      };
      add(totals, usage);
      add(upsert(byProject, run.repository || "unknown"), usage);
      add(upsert(byEngine, run.engine || (run.workflow === "cockpit-chat" ? "cli" : "ci")), usage);
      add(upsert(byRunner, run.runner_id || "(none)"), usage);
    }

    return {
      month,
      totals,
      byProject: toSortedRows(byProject),
      byEngine: toSortedRows(byEngine),
      byRunner: toSortedRows(byRunner)
    };
  }

  return { recordRun, readRuns, report, source, estimateCostUsd };
}

function emptyTotals() {
  return { runs: 0, failures: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimatedCostUsd: 0, durationSeconds: 0 };
}

function upsert(map, key) {
  if (!map.has(key)) map.set(key, { key, ...emptyTotals() });
  return map.get(key);
}

function add(target, usage) {
  target.runs += usage.runs;
  target.failures += usage.failures;
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.costUsd += usage.costUsd;
  target.estimatedCostUsd += usage.estimatedCostUsd;
  target.durationSeconds += usage.durationSeconds;
}

function toSortedRows(map) {
  return [...map.values()].sort((a, b) =>
    (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || b.runs - a.runs
  );
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
