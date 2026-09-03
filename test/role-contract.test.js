import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createActionAuditLog,
  createRoleGovernance,
  evaluateRoleAction,
  evaluateRoleHandoff,
  mergeRoleContracts,
  normalizeRoleContract,
  roleContractFingerprint,
  summarizeRoleContract,
  validateRoleContract
} from "../src/role-contract.js";
import { createToolBroker } from "../src/tool-broker.js";
import { loadRoleSpec } from "../src/role-spec.js";

function operationsContract(revision = 4) {
  return {
    version: 1,
    revision,
    mandate: "Keep customers informed without exposing unrelated systems.",
    authority: {
      tools: [
        { name: "slack.post", impact: "external-write", data: { write: ["slack:*"] } },
        { name: "drive.read-file", impact: "read", data: { read: ["drive:briefs"] } }
      ],
      data: { read: ["drive:*"], write: ["slack:*"] },
      handoffs: { send: ["ops"], receive: ["ceo"] }
    },
    approvals: { required_for: ["internal-write"] },
    budget: { max_usd_per_run: 2.5, max_runs_per_day: 6 }
  };
}

test("role contracts normalize into a stable, reviewable dashboard summary", () => {
  const contract = normalizeRoleContract(operationsContract(), { role: "communications" });
  assert.equal(contract.role, "communications");
  assert.equal(contract.revision, 4);
  assert.equal(contract.authority.tools[0].name, "drive.read-file", "tools are stable sorted data");
  assert.deepEqual(contract.approvals.required_for, ["internal-write", "external-write", "destructive", "financial"]);
  assert.equal(Object.isFrozen(contract.authority.tools), true);

  const summary = summarizeRoleContract(contract);
  assert.equal(summary.status, "governed");
  assert.equal(summary.tool_count, 2);
  assert.equal(summary.fingerprint, roleContractFingerprint(contract));
  assert.deepEqual(summary.budget, {
    max_usd_per_run: 2.5,
    max_usd_per_month: null,
    max_tokens_per_run: null,
    max_runs_per_day: 6
  });
  assert.deepEqual(summarizeRoleContract(null, { role: "old-role" }).issues, ["No governed role contract"]);
  assert.match(validateRoleContract({ version: 9 }, { role: "communications" }).error, /version/);
});

test("defaults form a stricter contract floor and cannot relax approvals or budgets", () => {
  const merged = mergeRoleContracts({
    version: 1,
    revision: 2,
    mandate: "Shared operating floor.",
    authority: { tools: [{ name: "audit.read", impact: "read" }], data: { read: ["audit:*"] } },
    budget: { max_usd_per_run: 1, max_runs_per_day: 2 }
  }, {
    ...operationsContract(9),
    budget: { max_usd_per_run: 9, max_runs_per_day: 1 }
  }, { role: "communications" });

  assert.equal(merged.revision, 9);
  assert.equal(merged.mandate, operationsContract().mandate);
  assert.deepEqual(merged.authority.tools.map((tool) => tool.name), ["audit.read", "drive.read-file", "slack.post"]);
  assert.equal(merged.budget.max_usd_per_run, 1, "the lower shared cap wins");
  assert.equal(merged.budget.max_runs_per_day, 1, "a role can make its own cap tighter");
  assert.ok(merged.approvals.required_for.includes("financial"));
});

test("a role spec exposes its merged contract and UI summary without changing legacy role fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-contract-spec-"));
  const roles = path.join(root, ".crew", "roles");
  await mkdir(roles, { recursive: true });
  await writeFile(path.join(roles, "_defaults.json"), JSON.stringify({
    runner: "claude-agent-sonnet-high",
    contract: {
      version: 1,
      revision: 2,
      authority: { tools: [{ name: "audit.read", impact: "read" }] }
    }
  }), "utf8");
  await writeFile(path.join(roles, "communications.json"), JSON.stringify({
    runner: "codex-agent-high",
    contract: operationsContract(6)
  }), "utf8");

  const spec = loadRoleSpec(root, "communications");
  assert.equal(spec.runner, "codex-agent-high");
  assert.equal(spec.contract.revision, 6);
  assert.deepEqual(spec.contract.authority.tools.map((tool) => tool.name), ["audit.read", "drive.read-file", "slack.post"]);
  assert.equal(spec.contractSummary.status, "governed");
  assert.equal(spec.contractSummary.role, "communications");
});

test("authority, data boundaries, approvals, and handoffs are evaluated independently", () => {
  const contract = normalizeRoleContract(operationsContract(), { role: "communications" });
  const approval = { id: "approval-17", approved_by: "founder", status: "approved" };

  const read = evaluateRoleAction(contract, { toolName: "drive.read-file", data: { read: ["drive:briefs"] } });
  assert.equal(read.allowed, true);
  assert.equal(read.approval_required, false);

  const external = evaluateRoleAction(contract, { toolName: "slack.post", impact: "read", data: { write: ["slack:announcements"] } });
  assert.equal(external.allowed, false, "a caller cannot downgrade a declared external action");
  assert.equal(external.decision, "approval-required");
  assert.equal(external.impact, "external-write");
  assert.equal(evaluateRoleAction(contract, {
    toolName: "slack.post", data: { write: ["slack:announcements"] }, approval
  }).allowed, true);
  const staleApproval = {
    ...approval,
    authorization: {
      contract_version: 1,
      contract_revision: 3,
      contract_fingerprint: "older-reviewed-contract"
    }
  };
  assert.equal(evaluateRoleAction(contract, {
    toolName: "slack.post", data: { write: ["slack:announcements"] }, approval: staleApproval
  }).decision, "approval-required", "a bundled approval tied to another contract revision cannot be replayed");

  const wrongData = evaluateRoleAction(contract, { toolName: "drive.read-file", data: { read: ["drive:payroll"] } });
  assert.equal(wrongData.decision, "denied");
  assert.match(wrongData.reason, /outside/);
  assert.equal(evaluateRoleAction(contract, { toolName: "gmail.send", approval }).allowed, false);
  assert.equal(evaluateRoleAction(null, { toolName: "anything" }).decision, "legacy");
  assert.equal(evaluateRoleAction(null, { toolName: "anything", requireContract: true }).decision, "denied");

  assert.equal(evaluateRoleHandoff(contract, { direction: "send", role: "ops" }).allowed, true);
  assert.equal(evaluateRoleHandoff(contract, { direction: "send", role: "ceo" }).allowed, false);
  assert.equal(evaluateRoleHandoff(contract, { direction: "receive", role: "ceo" }).allowed, true);

  const governance = createRoleGovernance({ contracts: { communications: operationsContract() }, requireContracts: true });
  assert.equal(governance.authorizeHandoff({ role: "communications", direction: "send", peerRole: "ops" }).allowed, true);
  assert.equal(governance.authorizeHandoff({ role: "communications", direction: "receive", peerRole: "ceo" }).allowed, true);
  assert.equal(governance.authorizeHandoff({ role: "communications", direction: "send", peerRole: "ceo" }).allowed, false);
});

test("the action log is append-only, tamper-evident, and excludes raw action payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-contract-audit-"));
  const contract = normalizeRoleContract(operationsContract(), { role: "communications" });
  let next = 0;
  const audit = createActionAuditLog({
    targetRoot: root,
    env: { CREW_HOME: path.join(root, "host") },
    now: () => new Date("2026-09-03T12:00:00.000Z"),
    createId: () => `fixed-${++next}`
  });
  assert.match(audit.file, /host[\\/]audit[\\/]/, "runtime audit state stays out of the repository");
  const decision = evaluateRoleAction(contract, {
    toolName: "slack.post", data: { write: ["slack:announcements"] }, approval: { id: "a-1", approved_by: "founder" }
  });
  const started = audit.append({
    role: "communications", actor: "founder", action: "tool", toolName: "slack.post", outcome: "started",
    decision, contract, data: { write: ["slack:announcements"] }, input: { text: "secret customer update" }
  });
  const completed = audit.append({
    role: "communications", actor: "founder", action: "tool", toolName: "slack.post", operationId: started.id,
    outcome: "completed", decision, contract, output: { ok: true }
  });
  assert.equal(completed.operation_id, started.id);
  assert.deepEqual(audit.verify(), { valid: true, records: 2, head: completed.hash });
  const raw = await readFile(audit.file, "utf8");
  assert.doesNotMatch(raw, /secret customer update/);
  assert.match(raw, /input_hash/);

  await writeFile(audit.file, raw.replace('"completed"', '"tampered"'), "utf8");
  assert.equal(audit.verify().valid, false);
});

test("the optional broker hook enforces governed connector actions and records decisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-contract-broker-"));
  let approveNow = false;
  let approvalRequests = 0;
  const governance = createRoleGovernance({
    contracts: { communications: operationsContract() },
    requireContracts: true,
    targetRoot: root,
    env: { CREW_HOME: path.join(root, "host") },
    requestApproval: () => {
      approvalRequests += 1;
      return approveNow ? { id: "approval-1", approved_by: "founder", status: "approved" } : null;
    }
  });
  const broker = createToolBroker({
    allowlists: { communications: ["slack.post", "drive.read-file"] },
    governance
  });
  let calls = 0;
  const registry = {
    "slack.post": async () => { calls += 1; return { ok: true }; },
    "drive.read-file": async () => { calls += 1; return { ok: true }; }
  };

  await assert.rejects(
    broker.callTool({ role: "communications", toolName: "slack.post", input: { text: "hello" }, registry, data: { write: ["slack:announcements"] } }),
    /needs host approval/
  );
  assert.equal(calls, 0);
  assert.equal(approvalRequests, 1, "the host receives a pending approval request");
  approveNow = true;
  await broker.callTool({
    role: "communications", toolName: "slack.post", input: { text: "hello" }, registry,
    data: { write: ["slack:announcements"] }, actor: "founder", runner: "claude-agent", model: "sonnet"
  });
  assert.equal(calls, 1);
  assert.equal(approvalRequests, 2, "an explicitly approved host response resumes the action");
  assert.equal(governance.audit.verify().valid, true);
  const rows = governance.audit.list();
  assert.deepEqual(rows.map((row) => row.outcome), ["approval-required", "started", "completed"]);
  assert.equal(rows.at(-1).model, "sonnet");
  assert.doesNotMatch(await readFile(governance.audit.file, "utf8"), /hello/);
});
