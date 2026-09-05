import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createStandaloneRuntime } from "../src/standalone.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function fixture(t) {
  const parent = mkdtempSync(path.join(os.tmpdir(), "crew-standalone-"));

  const root = path.join(parent, "repo");
  const env = { CREW_HOME: path.join(parent, "private") };
  mkdirSync(path.join(root, ".crew/agents"), { recursive: true });
  const specFile = path.join(root, ".crew/agents/ops.json");
  const spec = { title: "Operations", contract: { version: 1, revision: 1, authority: { tools: [{ name: "slack.postMessage", impact: "external-write" }, { name: "gmail.sendDraft", impact: "external-write" }, { name: "gmail.getMessage", impact: "read" }], data: { write: ["connector:slack:slack", "connector:gmail:gmail"], read: ["connector:gmail:gmail"] } } } };
  writeFileSync(specFile, JSON.stringify(spec));
  const requests = [];
  let draft = Buffer.from("To: customer@example.test\r\nSubject: Approved update\r\n\r\nProject complete.").toString("base64url");
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("auth.test")) return Response.json({ ok: true, team: "Test workspace" }, { headers: { "x-oauth-scopes": "chat:write,app_mentions:read" } });
    if (url.endsWith("chat.postMessage")) return Response.json({ ok: true, channel: "C123", ts: "100.1" });
    if (url.endsWith("/token")) return Response.json({ access_token: "google-access-private", scope: "https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly" });
    if (url.includes("?format=raw")) return Response.json({ message: { raw: draft } });
    if (url.endsWith("/drafts/send")) return Response.json({ id: "sent123", threadId: "thread123" });
    throw new Error(`Unexpected request: ${url}`);
  };
  const runtime = createStandaloneRuntime({ targetRoot: root, env, fetchImpl });
  t.after(async () => { await runtime.close(); rmSync(parent, { recursive: true, force: true }); });
  const call = (toolName, input) => runtime.tools.registry.call({ role: "ops", toolName, input });
  return { root, env, spec, specFile, runtime, requests, call, setDraft: (value) => { draft = Buffer.from(value).toString("base64url"); } };
}

test("standalone Slack verifies credentials, survives restart, reviews exact payload and delivers once", async (t) => {
  const f = fixture(t);
  await f.runtime.operations.connect({ connectorId: "slack", credentials: { access_token: "xoxb-this-is-private" } });
  const snapshot = await f.runtime.operations.getSnapshot();
  assert.equal(snapshot.connectors[0].status, "connected");
  assert.doesNotMatch(JSON.stringify(snapshot), /xoxb-this-is-private/);
  if (process.platform !== "win32") assert.equal(statSync(f.runtime.store.file).mode & 0o777, 0o600);
  const restarted = createStandaloneRuntime({ targetRoot: f.root, env: f.env });
  assert.equal((await restarted.operations.getSnapshot()).connectors[0].status, "connected");
  await restarted.close();
  assert.equal((await f.call("slack.postMessage", { channel: "C123", text: "Exact reviewed update" })).status, "awaiting_approval");
  const approval = (await f.runtime.operations.getSnapshot()).approvals[0];
  assert.match(approval.summary, /Exact reviewed update/);
  assert.equal(f.requests.filter((r) => r.url.endsWith("chat.postMessage")).length, 0);
  await f.runtime.operations.decideApproval({ id: approval.id, action: "approve" });
  await f.runtime.operations.afterApproval({ id: approval.id, action: "approve" });
  await f.runtime.operations.afterApproval({ id: approval.id, action: "approve" });
  assert.equal(f.requests.filter((r) => r.url.endsWith("chat.postMessage")).length, 1);
  assert.equal(f.runtime.store.getAction(approval.id).status, "delivered");
  assert.equal(f.runtime.store.getAction(approval.id).receipt.ts, "100.1");
});

test("standalone rechecks agent authority and hides disconnected accounts", async (t) => {
  const f = fixture(t);
  await f.runtime.operations.connect({ connectorId: "slack", credentials: { access_token: "xoxb-this-is-private" } });
  assert.ok(f.runtime.tools.toolHandlers({ role: "ops" }).some((tool) => tool.toolName === "slack.postMessage"));
  assert.equal((await f.call("slack.postMessage", { channel: "C123", text: "Review me" })).status, "awaiting_approval");
  const approval = (await f.runtime.operations.getSnapshot()).approvals[0];
  await f.runtime.operations.decideApproval({ id: approval.id, action: "approve" });
  f.spec.contract.authority.tools = [];
  f.spec.contract.revision++;
  writeFileSync(f.specFile, JSON.stringify(f.spec));
  assert.match((await f.runtime.operations.afterApproval({ id: approval.id, action: "approve" })).error, /not allowed/);
  assert.equal(f.requests.filter((r) => r.url.endsWith("chat.postMessage")).length, 0);
  f.runtime.operations.disconnect({ connectorId: "slack" });
  assert.ok(!f.runtime.tools.toolHandlers({ role: "ops" }).some((tool) => tool.toolName.startsWith("slack.")));
});

test("the standalone Codex stdio server rebuilds authorized tools without serializing credentials", async (t) => {
  const f = fixture(t);
  await f.runtime.operations.connect({ connectorId: "slack", credentials: { access_token: "xoxb-this-is-private" } });
  const config = f.runtime.tools.codexMcpConfig({ role: "ops", targetRoot: f.root, env: f.env });
  t.after(config.cleanup);
  const server = config.config.mcp_servers.crewrun;
  assert.doesNotMatch(readFileSync(server.env.CREW_MCP_CONTEXT_FILE, "utf8"), /xoxb|accessToken/);
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: server.env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  const client = new Client({ name: "crewrun-regression", version: "1.0" });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    assert.ok(result.tools.some((tool) => tool.name === "slack_postMessage"));
    assert.ok(!result.tools.some((tool) => tool.name.startsWith("gmail_")));
  } catch (error) { throw new Error(`${error.message}\n${stderr}`); }
  finally { await client.close(); }
});

test("Gmail refreshes credentials, keeps reads opt-in, and pins the reviewed draft body", async (t) => {
  const f = fixture(t);
  await f.runtime.operations.connect({ connectorId: "gmail", credentials: { client_id: "client", client_secret: "secret", refresh_token: "refresh" } });
  const names = f.runtime.tools.toolHandlers({ role: "ops" }).map((tool) => tool.toolName);
  assert.ok(names.includes("gmail.sendDraft"));
  assert.ok(!names.includes("gmail.getMessage"));
  assert.equal((await f.call("gmail.sendDraft", { draftId: "draft123" })).status, "awaiting_approval");
  const approval = (await f.runtime.operations.getSnapshot()).approvals[0];
  assert.match(approval.summary, /customer@example.test/);
  await f.runtime.operations.decideApproval({ id: approval.id, action: "approve" });
  await f.runtime.operations.afterApproval({ id: approval.id, action: "approve" });
  const send = f.requests.find((r) => r.url.endsWith("/drafts/send"));
  assert.match(Buffer.from(JSON.parse(send.options.body).message.raw, "base64url").toString(), /Project complete/);
  assert.ok(f.requests.filter((r) => r.url.endsWith("/token")).length >= 2);
  assert.match(f.requests.find((r) => r.url.endsWith("/token")).options.body, /grant_type=refresh_token/);
});

test("Gmail draft edits require a new review and invalid credentials are never saved", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.runtime.operations.connect({ connectorId: "gmail", credentials: {} }), /refresh token/);
  await f.runtime.operations.connect({ connectorId: "gmail", credentials: { client_id: "client", client_secret: "secret", refresh_token: "refresh" } });
  assert.equal((await f.call("gmail.sendDraft", { draftId: "draft123" })).status, "awaiting_approval");
  const approval = (await f.runtime.operations.getSnapshot()).approvals[0];
  await f.runtime.operations.decideApproval({ id: approval.id, action: "approve" });
  f.setDraft("To: someone-else@example.test\r\n\r\nChanged");
  assert.match((await f.runtime.operations.afterApproval({ id: approval.id, action: "approve" })).error, /draft changed/);
  assert.equal(f.requests.filter((r) => r.url.endsWith("/drafts/send")).length, 0);
});
