import assert from "node:assert/strict";
import { validateIntegrationPlugin } from "./manifest.js";
import { createPluginRegistry } from "./registry.js";

// A small authoring harness, not a security audit or a provider-live test.
export function assertIntegrationPluginContract(raw, fixtures = {}) {
  const plugin = validateIntegrationPlugin(raw);
  const registry = createPluginRegistry({ plugins: [plugin] });
  for (const action of plugin.actions) {
    assert.ok(fixtures[action.id]?.valid?.length, `Provide valid inputs for ${action.id}`);
    assert.ok(fixtures[action.id]?.invalid?.length, `Provide invalid inputs for ${action.id}`);
    for (const input of fixtures[action.id].valid) assert.equal(action.validate(input)?.ok, true, action.id);
    for (const input of fixtures[action.id].invalid) assert.equal(action.validate(input)?.ok, false, action.id);
    if (action.risk === "external-write") assert.equal(action.approval, "required");
    assert.equal(registry.action(action.id).validate, undefined);
  }
  assert.equal(registry.list()[0].adapter, undefined);
  return plugin;
}
