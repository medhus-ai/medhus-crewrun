import assert from "node:assert/strict";
import test from "node:test";
import { slackPlugin } from "@medhus-ai/crewrun-plugin-slack";
import { createMcpBridge } from "../src/mcp.js";
import { createRoleGovernance } from "../src/role-contract.js";
import { connectionMetadata, createConnectionCatalog, createConnectorRegistry, connectorActions, classifyConnectorAction } from "../src/connectors.js";

const connection = {
  id: "slack-team", provider: "slack", status: "connected",
  account: { id: "T1", label: "Team", accessToken: "private" },
  scopes: ["chat:write", "channels:history", "app_mentions:read"],
  capabilities: ["messages", "mentions"],
  accessToken: "xoxb-private", refreshToken: "private"
};
function fixture(overrides = {}) {
  const calls = [], approvals = [];
  const registry = createConnectorRegistry({
    actions: slackPlugin.actions, connections: [connection],
    governance: createRoleGovernance({ getContract: (role) => ({ version: 1, revision: 1, mandate: "Test scoped Slack actions.", authority: { tools: (role === "ops" ? ["slack.postMessage", "slack.getThread"] : ["slack.getThread"]).map((name) => ({ name, impact: name === "slack.postMessage" ? "external-write" : "read" })), data: { read: ["connector:slack:slack-team"], write: ["connector:slack:slack-team"] } } }) }),
    roleActions: { ops: ["slack.postMessage", "slack.getThread"], viewer: ["slack.getThread"] },
    roleConnections: { ops: ["slack-team"], viewer: ["slack-team"] },
    approve: async (request) => { approvals.push(request); return { id: "owner-review", approved_by: "operator", status: "approved" }; },
    invoke: async (request) => { calls.push(request); return { ok: true }; },
    ...overrides
  });
  return { registry, calls, approvals };
}
test("v6 has no implicit providers and metadata never carries credentials", () => {
  assert.deepEqual(connectorActions(), []);
  assert.deepEqual(createConnectorRegistry().toolsForRole("ops"), []);
  assert.doesNotMatch(JSON.stringify(connectionMetadata(connection)), /private|token/i);
  const catalog = createConnectionCatalog([connection]);
  catalog.get("slack-team").account.label = "changed";
  assert.equal(catalog.get("slack-team").account.label, "Team");
});
test("plugin tools enforce role, connection, OAuth scope, and capability boundaries", async () => {
  const { registry, calls } = fixture();
  await assert.rejects(registry.call({ role: "viewer", toolName: "slack.postMessage", input: { channel: "C1", text: "No" } }), /not allowed/);
  await assert.rejects(registry.call({ role: "ops", toolName: "slack.postMessage", input: { channel: "C1", text: "No", connectionId: "other" } }), /not allowed/);
  assert.equal(calls.length, 0);
  assert.deepEqual(fixture({ connections: [{ ...connection, scopes: [] }] }).registry.toolsForRole("ops"), []);
  assert.deepEqual(fixture({ connections: [{ ...connection, capabilities: ["mentions"] }] }).registry.toolsForRole("ops"), []);
});
test("writes require host approval and drop raw API-shaped inputs", async () => {
  const { registry, calls, approvals } = fixture();
  const input = { channel: "C1", text: " hello ", approved: true, token: "private", blocks: [] };
  await registry.call({ role: "ops", toolName: "slack.postMessage", input });
  assert.equal(approvals.length, 1);
  assert.deepEqual(calls[0].input, { channel: "C1", text: "hello" });
  assert.equal(classifyConnectorAction(slackPlugin.actions.find((a) => a.id === "slack.postMessage")).requiresApproval, true);
  assert.deepEqual(registry.actionPolicy("slack.postMessage", { role: "ops" }).data, { read: [], write: ["connector:slack:slack-team"] });
  const denied = fixture({ approve: async () => false });
  await assert.rejects(denied.registry.call({ role: "ops", toolName: "slack.postMessage", input }), /requires host approval/);
  assert.equal(denied.calls.length, 0);
});
test("reads use the existing MCP bridge and cannot receive tokens", async () => {
  const { registry, calls, approvals } = fixture();
  const handler = createMcpBridge(registry).toolHandlers({ role: "viewer", toolContext: {} }).find((tool) => tool.toolName === "slack.getThread");
  assert.ok(handler);
  await handler.invoke({ channel: "C1", threadTs: "12.1" });
  assert.equal(calls.length, 1);
  assert.equal(approvals.length, 0);
  assert.doesNotMatch(JSON.stringify(registry.connectionMetadata()), /private|token/i);
});

test("missing authority cannot create an approval or invoke a provider", async () => {
  const { registry, calls, approvals } = fixture({ governance: null });
  await assert.rejects(registry.call({ role: "ops", toolName: "slack.postMessage", input: { channel: "C1", text: "Blocked" } }), /authority policy/);
  assert.equal(calls.length, 0);
  assert.equal(approvals.length, 0);
});
