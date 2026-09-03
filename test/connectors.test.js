import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMcpBridge } from "../src/mcp.js";
import { createActionApprovalPolicy } from "../src/action-approvals.js";
import { createRoleGovernance } from "../src/role-contract.js";
import {
  builtInConnectorActions,
  classifyConnectorAction,
  connectionMetadata,
  connectorActions,
  connectorAuthorizationUrl,
  connectorProvider,
  createConnectionCatalog,
  createConnectorRegistry
} from "../src/connectors.js";

const CONNECTIONS = [
  {
    id: "slack-team",
    provider: "slack",
    status: "connected",
    account: { id: "T1", label: "Team workspace", accessToken: "never-copy-this" },
    scopes: ["chat:write", "app_mentions:read"],
    accessToken: "xoxb-secret",
    refreshToken: "refresh-secret",
    secretRef: "vault/slack-team"
  },
  {
    id: "gmail-alice",
    provider: "gmail",
    status: "connected",
    accountId: "alice@example.test",
    scopes: ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"],
    accessToken: "google-secret"
  }
];

function registry(overrides = {}) {
  const calls = [];
  const approvals = [];
  return {
    calls,
    approvals,
    registry: createConnectorRegistry({
      connections: CONNECTIONS,
      roleActions: {
        operator: ["slack.postMessage", "slack.replyToMention", "gmail.sendDraft", "gmail.searchMetadata", "gmail.getMessage"],
        viewer: ["gmail.searchMetadata"]
      },
      roleConnections: {
        operator: ["slack-team", "gmail-alice"],
        viewer: ["gmail-alice"]
      },
      gmailRead: false,
      approve: async (request) => { approvals.push(request); return true; },
      invoke: async (request) => { calls.push(request); return { ok: true, action: request.action }; },
      ...overrides
    })
  };
}

test("connection metadata copies only safe display fields", () => {
  const metadata = connectionMetadata(CONNECTIONS[0]);
  assert.deepEqual(metadata, {
    id: "slack-team",
    provider: "slack",
    status: "connected",
    account: { id: "T1", label: "Team workspace" },
    scopes: ["chat:write", "app_mentions:read"]
  });
  const serialized = JSON.stringify(metadata);
  assert.doesNotMatch(serialized, /secret|token|vault/i);

  const catalog = createConnectionCatalog({ "slack-team": CONNECTIONS[0] });
  const first = catalog.get("slack-team");
  first.account.label = "mutated copy";
  assert.equal(catalog.get("slack-team").account.label, "Team workspace", "catalog never gives callers its internal metadata object");
});

test("safe Slack and Gmail descriptors are narrow, and Gmail reads are opt-in", () => {
  assert.deepEqual(connectorActions().map((action) => action.id), [
    "slack.postMessage",
    "slack.replyToMention",
    "gmail.sendDraft"
  ]);
  assert.deepEqual(connectorActions({ gmailRead: true }).map((action) => action.id), builtInConnectorActions.map((action) => action.id));

  const state = registry();
  assert.deepEqual(state.registry.toolsForRole("operator"), ["slack.postMessage", "slack.replyToMention", "gmail.sendDraft"]);
  const slack = state.registry.validate("slack.postMessage", {
    connectionId: "slack-team",
    channel: "C1",
    text: "  hello  ",
    blocks: [{ type: "section" }],
    approved: true
  });
  assert.deepEqual(slack, { ok: true, input: { channel: "C1", text: "hello", connectionId: "slack-team" } });
  assert.match(state.registry.describe("slack.postMessage"), /host must approve/i);
  assert.equal(state.registry.validate("slack.replyToMention", { channel: "C1", text: "reply", threadTs: "not-a-ts" }).ok, false);
  assert.equal(state.registry.validate("gmail.sendDraft", { draftId: "draft-1", raw: "RFC822 payload" }).ok, true);
  assert.deepEqual(state.registry.validate("gmail.sendDraft", { draftId: "draft-1", raw: "RFC822 payload" }).input, { draftId: "draft-1" });
  assert.equal(state.registry.validate("gmail.sendDraft", { draftId: "../../etc/passwd" }).ok, false);
});

test("role, connection, scope, and approval boundaries are enforced before invocation", async () => {
  const state = registry();
  assert.equal(state.registry.canCallAction("viewer", "slack.postMessage"), false);
  assert.deepEqual(state.registry.toolsForRole("viewer"), [], "disabled Gmail reads never surface even if a role requests them");
  assert.deepEqual(state.registry.actionPolicy("slack.postMessage", { role: "operator" }), {
    impact: "external-write",
    data: { read: [], write: ["connector:slack:slack-team"] }
  });

  await assert.rejects(
    state.registry.call({ role: "viewer", toolName: "slack.postMessage", input: { channel: "C1", text: "nope" } }),
    /viewer is not allowed to call slack\.postMessage/
  );
  assert.equal(state.calls.length, 0);

  await state.registry.call({
    role: "operator",
    toolName: "slack.postMessage",
    input: { channel: "C1", text: "deployment complete", connectionId: "slack-team", token: "model-supplied-secret" },
    context: { requestId: "r1" }
  });
  assert.equal(state.approvals.length, 1);
  assert.deepEqual(state.approvals[0], {
    role: "operator",
    action: "slack.postMessage",
    connectionId: "slack-team",
    input: { channel: "C1", text: "deployment complete" },
    approval: classifyConnectorAction("slack.postMessage"),
    data: { read: [], write: ["connector:slack:slack-team"] },
    context: { requestId: "r1" }
  });
  assert.deepEqual(state.calls[0], {
    role: "operator",
    action: "slack.postMessage",
    connectionId: "slack-team",
    input: { channel: "C1", text: "deployment complete" },
    approval: classifyConnectorAction("slack.postMessage"),
    approvalRecord: true,
    data: { read: [], write: ["connector:slack:slack-team"] },
    context: { requestId: "r1" }
  });
  assert.doesNotMatch(JSON.stringify(state.calls[0]), /token|secret/i);

  await assert.rejects(
    state.registry.call({ role: "operator", toolName: "slack.postMessage", input: { channel: "C1", text: "wrong connection", connectionId: "gmail-alice" } }),
    /not allowed to use connection gmail-alice/
  );
  assert.equal(state.calls.length, 1);

  const blocked = registry({ approve: async () => false });
  await assert.rejects(
    blocked.registry.call({ role: "operator", toolName: "gmail.sendDraft", input: { draftId: "draft-1" } }),
    /gmail\.sendDraft requires host approval/
  );
  assert.equal(blocked.calls.length, 0, "a rejected delivery never reaches a provider adapter");
});

test("explicit Gmail-read enablement yields read-only actions without delivery approval", async () => {
  const state = registry({ gmailRead: true, approve: async () => { throw new Error("reads must not request delivery approval"); } });
  assert.deepEqual(state.registry.toolsForRole("viewer"), ["gmail.searchMetadata"]);
  const result = await state.registry.call({
    role: "viewer",
    toolName: "gmail.searchMetadata",
    input: { query: "from:team@example.test", maxResults: 2 }
  });
  assert.deepEqual(result, { ok: true, action: "gmail.searchMetadata" });
  assert.deepEqual(state.calls[0].input, { query: "from:team@example.test", maxResults: 2 });
  assert.equal(state.approvals.length, 0);
  assert.deepEqual(classifyConnectorAction("gmail.searchMetadata"), {
    action: "gmail.searchMetadata",
    provider: "gmail",
    risk: "read",
    requiresApproval: false,
    reason: "This action is read-only."
  });
  assert.equal(classifyConnectorAction("gmail.sendDraft").requiresApproval, true);
});

test("the registry plugs into the existing MCP bridge without exposing credentials", async () => {
  const state = registry();
  const bridge = createMcpBridge(state.registry);
  const handlers = bridge.toolHandlers({ role: "operator", toolContext: { targetRoot: "/project" } });
  assert.ok(handlers.some((handler) => handler.toolName === "slack.postMessage"));
  assert.ok(!handlers.some((handler) => handler.toolName === "gmail.searchMetadata"));
  const post = handlers.find((handler) => handler.toolName === "slack.postMessage");
  const result = await post.invoke({ channel: "C1", text: "bridge post" });
  assert.deepEqual(result.structuredContent, { ok: true, action: "slack.postMessage" });
  assert.deepEqual(state.calls[0].input, { channel: "C1", text: "bridge post" });
  assert.doesNotMatch(JSON.stringify(state.registry.connectionMetadata()), /token|secret/i);
});

test("connector descriptors pass their real impact to role governance", async () => {
  const decisions = [];
  const governance = {
    authorizeAction: async (request) => {
      decisions.push(request);
      return { allowed: true, decision: "allowed" };
    }
  };
  const state = registry({
    governance,
    approve: async () => ({ id: "approval-1", approvedBy: "operator", status: "approved" })
  });
  await state.registry.call({ role: "operator", toolName: "slack.postMessage", input: { channel: "C1", text: "governed post" } });
  assert.equal(decisions.length, 2, "authority is checked before approval and again immediately before delivery");
  for (const decision of decisions) {
    assert.equal(decision.impact, "external-write", "a contract cannot treat Slack delivery as a read");
    assert.deepEqual(decision.data, { read: [], write: ["connector:slack:slack-team"] });
    assert.doesNotMatch(JSON.stringify(decision.input), /token|secret/i);
  }
});

test("a contract-denied connector action never creates an approval request", async () => {
  const governance = createRoleGovernance({
    requireContracts: true,
    contracts: {
      operator: {
        version: 1,
        mandate: "Read only Gmail metadata.",
        authority: {
          tools: [{ name: "gmail.searchMetadata", impact: "read" }],
          data: { read: ["connector:gmail:gmail-alice"] }
        }
      }
    }
  });
  const state = registry({ governance, gmailRead: true });
  await assert.rejects(
    state.registry.call({ role: "operator", toolName: "slack.postMessage", input: { channel: "C1", text: "not authorized" } }),
    /not authorized/
  );
  assert.equal(state.approvals.length, 0);
  assert.equal(state.calls.length, 0);
});

test("a connector claims one locally approved retry under the same reviewed contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crew-connector-approval-"));
  const env = { CREW_HOME: path.join(root, "home") };
  const policy = createActionApprovalPolicy({ targetRoot: root, env });
  const governance = createRoleGovernance({
    requireContracts: true,
    requestApproval: policy.requestApproval,
    contracts: {
      operator: {
        version: 1,
        revision: 3,
        mandate: "Post approved operational notices.",
        authority: {
          tools: [{ name: "slack.postMessage", impact: "external-write" }],
          data: { write: ["connector:slack:slack-team"] }
        }
      }
    }
  });
  try {
    const state = registry({ governance, approve: null });
    const input = { channel: "C1", text: "approve this", connectionId: "slack-team" };
    await assert.rejects(state.registry.call({ role: "operator", toolName: "slack.postMessage", input }), /requires host approval/);
    assert.equal(state.calls.length, 0);
    const pending = policy.list({ status: "pending" });
    assert.equal(pending.length, 1);
    policy.approve({ approvalId: pending[0].id, approvedBy: "operator" });

    await state.registry.call({ role: "operator", toolName: "slack.postMessage", input });
    assert.equal(state.calls.length, 1, "the provider adapter runs only after the exact approval is claimed");
    assert.equal(policy.list()[0].status, "used");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OAuth endpoint metadata builds authorization URLs only", () => {
  assert.equal(connectorProvider("slack").tokenEndpoint, "https://slack.com/api/oauth.v2.access");
  const slack = new URL(connectorAuthorizationUrl({
    provider: "slack",
    clientId: "123.456",
    redirectUri: "https://host.example.test/connect/slack/callback",
    state: "opaque-state",
    scopes: ["chat:write", "app_mentions:read"]
  }));
  assert.equal(slack.origin, "https://slack.com");
  assert.equal(slack.searchParams.get("scope"), "chat:write,app_mentions:read");
  assert.equal(slack.searchParams.get("state"), "opaque-state");

  const google = new URL(connectorAuthorizationUrl({
    provider: "gmail",
    clientId: "client-id",
    redirectUri: "http://localhost:3030/connect/google/callback",
    state: "opaque-state",
    codeChallenge: "pkce-value"
  }));
  assert.equal(google.searchParams.get("access_type"), "offline");
  assert.equal(google.searchParams.get("code_challenge_method"), "S256");
  assert.throws(() => connectorAuthorizationUrl({ provider: "gmail", clientId: "id", redirectUri: "http://host.example.test/callback", state: "s" }), /redirectUri/);
});
