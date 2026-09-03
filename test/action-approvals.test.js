import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  actionApprovalPath,
  approveAction,
  claimActionApproval,
  createActionApprovalPolicy,
  getActionApproval,
  listActionApprovals,
  requestActionApproval
} from "../src/action-approvals.js";

test("external action approvals preserve only a request digest and are single-use", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-action-approvals-"));
  const root = path.join(parent, "repo");
  const env = { CREW_HOME: path.join(parent, "home") };
  const now = new Date("2026-09-03T12:00:00.000Z");
  try {
    const proposal = requestActionApproval({
      targetRoot: root,
      role: "ops",
      action: "slack.postMessage",
      connectionId: "slack-workspace",
      input: { channel: "C123", text: "secret body must not be persisted" },
      summary: "Post an incident update to #ops.",
      authorization: { decision: "approval-required", contract_version: 1, contract_revision: 2 },
      createId: () => "fixed",
      now,
      env
    });
    assert.equal(proposal.status, "pending");
    assert.equal(listActionApprovals({ targetRoot: root, env }).length, 1);

    const raw = await readFile(actionApprovalPath(root, env), "utf8");
    assert.doesNotMatch(raw, /secret body/, "the raw external payload never enters approval state");
    assert.match(raw, /inputHash/);

    const approved = approveAction({ targetRoot: root, approvalId: proposal.id, approvedBy: "chandra", now, env });
    assert.equal(approved.status, "approved");
    const claim = claimActionApproval({
      targetRoot: root,
      approvalId: proposal.id,
      role: "ops",
      action: "slack.postMessage",
      connectionId: "slack-workspace",
      input: { text: "secret body must not be persisted", channel: "C123" },
      now,
      env
    });
    assert.deepEqual(claim, {
      id: proposal.id,
      approved_by: "chandra",
      status: "approved",
      decided_at: now.toISOString(),
      authorization: { decision: "approval-required", contract_version: 1, contract_revision: 2, contract_fingerprint: "" }
    });
    assert.equal(getActionApproval({ targetRoot: root, approvalId: proposal.id, env }).status, "used");
    assert.throws(() => claimActionApproval({ targetRoot: root, approvalId: proposal.id, role: "ops", action: "slack.postMessage", connectionId: "slack-workspace", input: { channel: "C123", text: "secret body must not be persisted" }, env }), /is used/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("approval claims cannot be replayed for a different action or expired request", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-action-approval-match-"));
  const root = path.join(parent, "repo");
  const env = { CREW_HOME: path.join(parent, "home") };
  const created = new Date("2026-09-03T12:00:00.000Z");
  try {
    const proposal = requestActionApproval({
      targetRoot: root, role: "ops", action: "gmail.sendDraft", connectionId: "gmail-me", input: { draftId: "abc" },
      expiresInMs: 2_000, now: created, env, createId: () => "match"
    });
    approveAction({ targetRoot: root, approvalId: proposal.id, now: created, env });
    assert.throws(() => claimActionApproval({
      targetRoot: root, approvalId: proposal.id, role: "ops", action: "gmail.sendDraft", connectionId: "gmail-me", input: { draftId: "other" }, now: created, env
    }), /does not match/);

    const expired = requestActionApproval({
      targetRoot: root, role: "ops", action: "gmail.sendDraft", input: { draftId: "late" },
      expiresInMs: 1_000, now: created, env, createId: () => "late"
    });
    approveAction({ targetRoot: root, approvalId: expired.id, now: created, env });
    assert.throws(() => claimActionApproval({
      targetRoot: root, approvalId: expired.id, role: "ops", action: "gmail.sendDraft", input: { draftId: "late" }, now: new Date(created.getTime() + 2_000), env
    }), /is expired/);
    assert.equal(getActionApproval({ targetRoot: root, approvalId: expired.id, env }).status, "expired");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the local approval policy returns pending work, then claims an exact approved retry", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-action-policy-"));
  const root = path.join(parent, "repo");
  const env = { CREW_HOME: path.join(parent, "home") };
  const now = new Date("2026-09-03T12:00:00.000Z");
  try {
    const policy = createActionApprovalPolicy({ targetRoot: root, env, now: () => now });
    const request = {
      role: "ops",
      action: "slack.postMessage",
      connectionId: "slack-main",
      input: { channel: "C1", text: "safe retry boundary" },
      decision: { decision: "approval-required", contract_version: 1, contract_revision: 1, contract_fingerprint: "contract-one" }
    };
    const pending = policy.requestApproval(request);
    assert.equal(pending.status, "pending");
    assert.equal(policy.requestApproval(request).id, pending.id, "retries do not duplicate a pending request");
    policy.approve({ approvalId: pending.id, approvedBy: "operator" });
    const claimed = policy.requestApproval(request);
    assert.deepEqual(claimed, {
      id: pending.id,
      approved_by: "operator",
      status: "approved",
      decided_at: now.toISOString(),
      authorization: {
        decision: "approval-required",
        contract_version: 1,
        contract_revision: 1,
        contract_fingerprint: "contract-one"
      }
    });
    assert.equal(policy.list().find((entry) => entry.id === pending.id).status, "used");
    const changed = policy.requestApproval({ ...request, input: { channel: "C1", text: "different" } });
    assert.equal(changed.status, "pending");
    assert.notEqual(changed.id, pending.id, "a changed payload requires a separately approved request");
    const revised = policy.requestApproval({ ...request, decision: { ...request.decision, contract_revision: 2 } });
    assert.equal(revised.status, "pending");
    assert.notEqual(revised.id, pending.id, "a contract revision cannot reuse an old decision");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("an approved record cannot be claimed under a different contract revision", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-action-approval-contract-"));
  const root = path.join(parent, "repo");
  const env = { CREW_HOME: path.join(parent, "home") };
  const now = new Date("2026-09-03T12:00:00.000Z");
  const authorization = { decision: "approval-required", contract_version: 1, contract_revision: 2, contract_fingerprint: "contract-v2" };
  try {
    const request = requestActionApproval({
      targetRoot: root,
      role: "ops",
      action: "slack.postMessage",
      input: { channel: "C1", text: "reviewed" },
      authorization,
      now,
      env
    });
    approveAction({ targetRoot: root, approvalId: request.id, now, env });
    assert.throws(() => claimActionApproval({
      targetRoot: root,
      approvalId: request.id,
      role: "ops",
      action: "slack.postMessage",
      input: { channel: "C1", text: "reviewed" },
      authorization: { ...authorization, contract_revision: 3, contract_fingerprint: "contract-v3" },
      now,
      env
    }), /does not match/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
