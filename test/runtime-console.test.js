import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStandaloneRuntime } from "../src/standalone.js";
import { createConsole } from "../src/console/server.js";

test("console tasks persist results, download safely, accept outcomes and show usage", async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "crew-task-console-"));
  const root = path.join(parent, "repo");
  mkdirSync(path.join(root, ".crew/agents"), { recursive: true });
  writeFileSync(path.join(root, ".crew/agents/ops.json"), JSON.stringify({ title: "Operations", contract: { version: 1, authority: { tools: [{ name: "task.saveArtifact", impact: "internal-write" }] } } }));
  const env = { CREW_HOME: path.join(parent, "private") };
  const runtime = createStandaloneRuntime({ targetRoot: root, env, executeTurn: async ({ toolContext }) => {
    await runtime.tools.registry.call({ role: "ops", toolName: "task.saveArtifact", input: { name: "Early result", content: "Saved during execution" }, context: toolContext });
    return { ok: true, text: '<script>alert("escaped")</script>\nCustomer brief ready.', usage: { inputTokens: 100, outputTokens: 200, costUsd: 0.04 }, runnerId: "fixture" };
  } });
  const consoleApp = createConsole({ targetRoot: root, env, operations: runtime.operations, port: 0 });
  try {
    const base = `http://127.0.0.1:${await consoleApp.listen()}`;
    const post = (route, body) => fetch(base + route, { method: "POST", body: new URLSearchParams(body), redirect: "manual" });
    const created = await post("/tasks/create", { agent: "ops", prompt: "Deliver the client brief" });
    assert.equal(created.status, 303);
    const route = created.headers.get("location");
    const id = new URL(base + route).searchParams.get("run");
    await runtime.tick();
    const html = await (await fetch(base + route)).text();
    assert.match(html, /Accept deliverable/); assert.match(html, /Saved during execution/);
    assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>alert/);
    const artifact = runtime.store.snapshot().runs[0].artifacts[0];
    const downloaded = await fetch(base + `/tasks/artifact?id=${artifact.id}`);
    assert.match(downloaded.headers.get("content-disposition"), /attachment/);
    assert.equal(await downloaded.text(), artifact.content);
    assert.equal((await post("/tasks/control", { id, action: "accept" })).status, 303);
    const snapshot = await runtime.operations.getSnapshot();
    assert.equal(snapshot.outcomes.accepted, 1); assert.equal(snapshot.delivery.costPerDelivered, 0.04);
    assert.match(await (await fetch(base + "/usage")).text(), /Accepted deliverables/);
    assert.equal((await post("/tasks/control", { id, action: "accept" })).status, 400);
  } finally { await consoleApp.close(); await runtime.close(); rmSync(parent, { recursive: true, force: true }); }
});
