import assert from "node:assert/strict";
import { test } from "node:test";

import { createToolBroker } from "../src/tool-broker.js";
import { createRoleGovernance } from "../src/role-contract.js";

const broker = createToolBroker({
  governance: createRoleGovernance({ getContract: () => ({ version: 1, revision: 1, mandate: "Test document tools.", authority: { tools: ["doc.write", "doc.read"].map((name) => ({ name, impact: "internal-write" })) } }) }),
  allowlists: { writer: ["doc.write", "doc.read"], reader: ["doc.read"] },
  fallbackTools: (role, { reviewOnly = false } = {}) => (reviewOnly ? ["doc.read"] : ["doc.read", "doc.comment"]),
  extraTools: (role, { setup = false } = {}) => (role === "writer" && setup ? ["doc.configure"] : []),
  sharedTools: ["skill.list"],
  displayRole: (role) => (role === "writer" ? "Lead Writer" : role)
});

test("allowlists, fallbacks, extras, and shared tools compose per role", () => {
  assert.deepEqual(broker.toolsForRole("writer"), ["doc.write", "doc.read", "skill.list"]);
  assert.deepEqual(broker.toolsForRole("writer", { setup: true }), ["doc.write", "doc.read", "doc.configure", "skill.list"]);
  assert.deepEqual(broker.toolsForRole("guest"), ["doc.read", "doc.comment", "skill.list"]);
  assert.deepEqual(broker.toolsForRole("guest", { reviewOnly: true }), ["doc.read", "skill.list"]);
  assert.deepEqual(broker.toolsForRole(""), []);
  assert.equal(broker.canCallTool("reader", "doc.write"), false);
});

test("callTool enforces the allowlist before invoking the registry implementation", async () => {
  let called = false;
  const registry = {
    "doc.write": async (input, ctx) => {
      called = true;
      return { input, role: ctx.role };
    }
  };
  assert.deepEqual(
    await broker.callTool({ role: "writer", toolName: "doc.write", input: { file: "a.md" }, registry }),
    { input: { file: "a.md" }, role: "writer" }
  );
  assert.equal(called, true);
  await assert.rejects(
    broker.callTool({ role: "reader", toolName: "doc.write", input: {}, registry }),
    /reader is not allowed to call doc\.write/
  );
  await assert.rejects(
    broker.callTool({ role: "writer", toolName: "doc.write", input: {}, registry: {} }),
    /tool doc\.write is not registered/
  );
  await assert.rejects(
    broker.callTool({ role: "writer", toolName: "doc.configure", input: {}, registry }),
    /Lead Writer is not allowed to call doc\.configure/
  );
});

test("an allowlist alone never authorizes tool execution", async () => {
  let called = false;
  const bare = createToolBroker({ allowlists: { writer: ["doc.write"] } });
  await assert.rejects(bare.callTool({ role: "writer", toolName: "doc.write", registry: {
    "doc.write": () => { called = true; }
  } }), /authority policy/);
  assert.equal(called, false);
});
