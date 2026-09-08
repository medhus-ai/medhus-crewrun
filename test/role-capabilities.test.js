import assert from "node:assert/strict";
import test from "node:test";
import { roleCapabilityProfile, roleCapabilityInstructions } from "../src/role-capabilities.js";
test("titles never grant native subagents; delegation belongs to governed tasks", () => {
  for (const role of ["engineer", "code-reviewer", "assistant", "ceo"]) assert.equal(roleCapabilityProfile(role).subagents.allowed, false);
  assert.match(roleCapabilityInstructions(), /task.delegate/);
});
