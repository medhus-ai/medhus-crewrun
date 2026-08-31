import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeSubagentDefinitions,
  claudeSubagentToolRule,
  roleCapabilityInstructions,
  roleCapabilityProfile
} from "../src/role-capabilities.js";

test("only implementation and review roles receive bounded subagents", () => {
  assert.equal(roleCapabilityProfile("planner").subagents.allowed, false);
  assert.equal(roleCapabilityProfile("engineer").subagents.writable, true);
  assert.equal(roleCapabilityProfile("code-reviewer").subagents.writable, false);
  assert.equal(roleCapabilityProfile("security-reviewer", { reviewOnly: true }).subagents.allowed, true);
  assert.equal(roleCapabilityProfile("ceo").kind, "coordination");
});

test("Claude subagent definitions keep reviews read-only, prevent nesting, and carry the host prefix", () => {
  const review = roleCapabilityProfile("code-reviewer");
  const agents = claudeSubagentDefinitions(review);
  assert.deepEqual(Object.keys(agents), ["crew-investigator"]);
  assert.ok(agents["crew-investigator"].disallowedTools.includes("Agent"));
  assert.ok(!agents["crew-investigator"].tools.includes("Edit"));
  assert.equal(claudeSubagentToolRule(review), "Agent(crew-investigator)");

  const engineer = roleCapabilityProfile("engineer", { subagentPrefix: "acme" });
  assert.ok(claudeSubagentDefinitions(engineer)["acme-implementation-worker"].tools.includes("Edit"));
  assert.equal(claudeSubagentToolRule(engineer), "Agent(acme-investigator,acme-implementation-worker)");
  assert.match(roleCapabilityInstructions(engineer), /at most one writing subagent/i);
});

test("instructions use the neutral boundary unless the host supplies one, plus per-role notes", () => {
  const planner = roleCapabilityProfile("planner");
  assert.match(roleCapabilityInstructions(planner), /^## Control boundary/);
  assert.match(roleCapabilityInstructions(planner), /Do not spawn provider subagents/);
  const hosted = roleCapabilityInstructions(planner, {
    boundary: ["## Acme boundary", "Acme owns the ledger."],
    notes: { planner: ["Plans go to the ledger."] }
  });
  assert.match(hosted, /^## Acme boundary\nAcme owns the ledger\.\nPlans go to the ledger\./);
  assert.doesNotMatch(hosted, /Control boundary/);
});
