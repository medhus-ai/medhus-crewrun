import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defineIntegrationPlugin } from "../packages/crewrun-plugin-sdk/index.js";
import { createIntegrationHost } from "../packages/crewrun-reference-host/src/host.js";

const PUBLIC_BASE_URL = "https://arsazmar0smars3.taila9c41d.ts.net";
const VAULT_KEY = "test-only-integration-vault-key-that-is-long-enough";

test("a hosted external write with a lost provider response is uncertain and never auto-retried", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "crew-reference-host-delivery-"));
  const root = path.join(parent, "repo");
  const env = { CREW_HOME: path.join(parent, "crew-home") };
  await mkdir(path.join(root, ".crew", "agents"), { recursive: true });
  await writeFile(path.join(root, ".crew", "agents", "ops.json"), JSON.stringify({
    title: "Operations",
    contract: {
      version: 1,
      revision: 1,
      mandate: "Send the reviewed integration update.",
      authority: {
        tools: [{ name: "fake.send", impact: "external-write" }],
        data: { read: [], write: ["connector:fake:fake-main"] }
      }
    }
  }, null, 2) + "\n", "utf8");

  let providerCalls = 0;
  const plugin = defineIntegrationPlugin({
    id: "fake",
    label: "Fake",
    capabilities: [{ id: "messages", label: "Messages", direction: "both", scopes: ["fake.write"] }],
    events: [],
    actions: [{
      id: "fake.send",
      capability: "messages",
      label: "Send fake message",
      description: "A reviewed outbound fake message.",
      risk: "external-write",
      approval: "required",
      scopes: ["fake.write"],
      inputSchema: (z) => ({ text: z.string().min(1).max(240) }),
      validate: (input) => typeof input?.text === "string" && input.text.trim()
        ? { ok: true, input: { text: input.text.trim() } }
        : { ok: false, error: "text is required" }
    }],
    adapter: {
      async invoke() {
        providerCalls += 1;
        // This models a provider committing a write and the TCP response being lost.
        throw new Error("socket closed after provider accepted the request");
      }
    }
  });
  const host = createIntegrationHost({ targetRoot: root, plugins: [plugin], publicBaseUrl: PUBLIC_BASE_URL, vaultKey: VAULT_KEY, env });
  t.after(async () => { await host.stop(); await rm(parent, { recursive: true, force: true }); });
  host.state.saveConnection({
    id: "fake-main", pluginId: "fake", account: { id: "account-1", label: "Fake account" },
    scopes: ["fake.write"], capabilities: ["messages"], credentials: { accessToken: "private-test-token" }
  });

  const pending = await host.runtime.tools.registry.call({
    role: "ops", toolName: "fake.send", input: { text: "Reviewed update" }, context: {}
  });
  host.runtime.decideApproval(pending.actionId, "approve");

  const uncertain = await host.runtime.deliver(pending.actionId);
  assert.equal(uncertain.status, "uncertain");
  assert.match(uncertain.error, /may have completed.*reconcile/i);
  assert.equal(providerCalls, 1);
  assert.equal(await host.runtime.deliver(pending.actionId), null, "uncertain writes leave the automatic delivery queue");
  assert.equal(providerCalls, 1, "a response-loss case must not create a duplicate external write");
});
