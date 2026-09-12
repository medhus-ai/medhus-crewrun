import assert from "node:assert/strict";
import nodeTest from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, linkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initializeWorkspace } from "../src/workspace-setup.js";
import { createRuntimeStore } from "../src/runtime-store.js";
import { createRoleGovernance } from "../src/role-contract.js";
import { loadRoleSpec } from "../src/role-spec.js";
import { createWorkspaceTools, WORK_TOOLS, workToolSchema } from "../src/workspace-tools.js";
import { createMcpBridge } from "../src/mcp.js";
import { knowledgeInstallation, knowledgeSandboxArgs } from "../src/knowledge-process.js";
import { readKnowledgeSource } from "../src/workspace-knowledge.js";
import { z } from "zod";

// Descriptor-relative reads and the verified parser sandbox are Linux-only.
const test = (name, options, fn) => typeof options === "function"
  ? nodeTest(name, { skip: process.platform !== "linux" }, options)
  : nodeTest(name, { ...options, skip: process.platform !== "linux" }, fn);

function fixture(t, processRunner, extraEnv = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "crew-knowledge-test-"));
  const root = path.join(directory, "workspace");
  const env = { CREW_HOME: path.join(directory, "private"), ...extraEnv };
  initializeWorkspace(root);
  const contracts = {};
  for (const role of ["assistant", "peer"]) {
    const spec = loadRoleSpec(root, "assistant");
    contracts[role] = structuredClone(spec.contract);
    contracts[role].authority.data.read = [`workspace:knowledge/${role}/*`];
    mkdirSync(path.join(root, "knowledge", role), { recursive: true });
    writeFileSync(path.join(root, "knowledge", role, "note.md"), `# ${role}\nThe ${role} budget is confidential.`);
  }
  const store = createRuntimeStore({ targetRoot: root, env });
  const governance = createRoleGovernance({ targetRoot: root, env, requireContracts: true, getContract: (role) => contracts[role] });
  const calls = [];
  const mock = async (options) => {
    calls.push(options);
    assert.equal(store.db.inTransaction, false, "subprocess must not hold runtime transaction");
    if (processRunner) return processRunner(options, { contracts, root, calls });
    if (options.kind === "docling") return { content: "# Extracted\nOffice budget", references: [{ ref: "#/tables/0", pages: [1] }] };
    return { matches: readdirSync(path.join(options.job, "sources")).slice(0, 10).map((id) => ({ id, excerpt: readFileSync(path.join(options.job, "sources", id), "utf8"), line: 1, score: 1 })) };
  };
  const workspace = createWorkspaceTools({ targetRoot: root, store, governance, env, knowledgeProcess: processRunner === null ? undefined : mock });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (toolName, input, role = "assistant", context = {}) => workspace.call({ role, toolName, input, context });
  return { directory, root, store, governance, contracts, workspace, calls, call };
}

test("QMD stages only the acting agent's sources before indexing and maps citations back", async (t) => {
  const f = fixture(t);
  const a = await f.call("workspace.search", { query: "budget" });
  const b = await f.call("workspace.search", { query: "budget" }, "peer");
  assert.equal(a.engine, "qmd");
  assert.equal(a.indexedFiles, 1);
  assert.equal(a.matches[0].path, "knowledge/assistant/note.md");
  assert.match(a.matches[0].excerpt, /assistant/);
  assert.doesNotMatch(JSON.stringify(a), /peer/);
  assert.equal(b.matches[0].path, "knowledge/peer/note.md");
  assert.notEqual(f.calls[0].cache, f.calls[1].cache);
  assert.deepEqual(readdirSync(path.join(path.dirname(f.store.file), "knowledge/jobs")), []);
});

test("explicit forbidden paths, traversal, symlinks and hard links fail before parsing", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.call("workspace.search", { query: "budget", paths: ["knowledge/peer/note.md"] }), /authority/);
  await assert.rejects(f.call("workspace.search", { query: "budget", paths: ["knowledge/assistant/../../secret.md"] }), /relative/);
  symlinkSync(path.join(f.root, "knowledge/peer/note.md"), path.join(f.root, "knowledge/assistant/escape.md"));
  await assert.rejects(f.call("workspace.search", { query: "budget", paths: ["knowledge/assistant/escape.md"] }), /ELOOP/);
  symlinkSync(path.join(f.root, "knowledge/peer"), path.join(f.root, "knowledge/assistant/linked"));
  assert.throws(() => readKnowledgeSource(f.root, "knowledge/assistant/linked/note.md"));
  linkSync(path.join(f.root, "knowledge/peer/note.md"), path.join(f.root, "knowledge/assistant/hard.md"));
  assert.throws(() => readKnowledgeSource(f.root, "knowledge/assistant/hard.md"), /unlinked/);
  assert.equal(f.calls.length, 0);
});

test("authority revocation, deletion and changed bytes during retrieval invalidate the whole response", async (t) => {
  for (const change of ["authority", "delete", "content"]) {
    const f = fixture(t, async (options, { contracts, root }) => {
      if (change === "authority") contracts.assistant.authority.data.read = [];
      if (change === "delete") rmSync(path.join(root, "knowledge/assistant/note.md"));
      if (change === "content") writeFileSync(path.join(root, "knowledge/assistant/note.md"), "Changed");
      return { matches: [] };
    });
    await assert.rejects(f.call("workspace.search", { query: "budget" }), /authority changed|removed|ENOENT/);
  }
});

test("old knowledge generations are never reused after contract or source changes", async (t) => {
  const f = fixture(t);
  await f.call("workspace.search", { query: "budget" });
  await f.call("workspace.search", { query: "budget" });
  assert.equal(f.calls[0].cache, f.calls[1].cache);
  f.contracts.assistant.revision++;
  await f.call("workspace.search", { query: "budget" });
  assert.notEqual(f.calls[1].cache, f.calls[2].cache);
  writeFileSync(path.join(f.root, "knowledge/assistant/note.md"), "New budget");
  await f.call("workspace.search", { query: "budget" });
  assert.notEqual(f.calls[2].cache, f.calls[3].cache);
});

test("Docling reads are paginated, cached, scoped and audited with source revisions", async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, "knowledge/assistant/budget.xlsx"), "fake office fixture");
  await assert.rejects(f.call("workspace.read", { path: "knowledge/peer/budget.xlsx" }), /authority/);
  const run = f.store.enqueue({ agent: "assistant", prompt: "Read the budget" });
  const claim = f.store.claimRun(run.id);
  const ctx = { runId: run.id, runLease: claim.lease };
  const first = await f.call("workspace.read", { path: "knowledge/assistant/budget.xlsx", limit: 4 }, "assistant", ctx);
  const next = await f.call("workspace.read", { path: first.path, offset: first.nextOffset });
  assert.equal(first.content, "# Ex");
  assert.equal(next.content, "tracted\nOffice budget");
  assert.equal(first.engine, "docling");
  assert.equal(f.calls.length, 1);
  assert.ok(f.store.db.prepare("SELECT data FROM runtime_events WHERE type='tool.completed'").all().some((r) => r.data.includes(first.revision)));
});

test("ordinary Office filenames with spaces and Unicode preserve exact and folder authority", async (t) => {
  const f = fixture(t);
  const file = "knowledge/assistant/Launch Budget (été) 2026.xlsx";
  writeFileSync(path.join(f.root, file), "fixture");
  const result = await f.call("workspace.read", { path: file });
  assert.equal(result.path, file);
  assert.ok(f.governance.audit.list().some((entry) => entry.data.read.includes(`workspace:${file.toLowerCase()}`)));
  f.contracts.assistant.authority.data.read = [`workspace:${file.toLowerCase()}`];
  assert.equal((await f.call("workspace.read", { path: file })).engine, "docling");
  await assert.rejects(f.call("workspace.read", { path: "knowledge/assistant/Other Budget.xlsx" }), /authority/);
  await assert.rejects(f.call("workspace.read", { path: file }, "peer"), /authority/);
});

test("MCP exposes the existing scoped tools to both roles and rechecks tool revocation", async (t) => {
  const f = fixture(t);
  const bridge = createMcpBridge({ serverName: "knowledge", crewTools: false, governance: f.governance, toolsForRole: () => ["workspace.search", "workspace.read"], describe: (n) => WORK_TOOLS[n], inputSchema: workToolSchema, actionPolicy: () => ({ impact: "read" }), call: f.workspace.call });
  // Use the real Claude MCP registration surface; the common bridge also backs Codex.
  const sdk = { z, tool: (name, description, schema, invoke) => ({ name, invoke }), createSdkMcpServer: (s) => s };
  for (const role of ["assistant", "peer"]) {
    const mcp = bridge.createClaudeMcp({ sdk, role, targetRoot: f.root });
    assert.equal(mcp.server.tools.length, 2);
    const handler = mcp.server.tools.find((h) => h.name === "workspace_search");
    const result = await handler.invoke({ query: "budget" });
    assert.equal(result.structuredContent.matches[0].path, `knowledge/${role}/note.md`);
    f.contracts[role].authority.tools = [];
    assert.equal((await handler.invoke({ query: "budget" })).isError, true);
  }
});

test("invalid backend references, excessive input and unconfigured semantic search fail closed", async (t) => {
  const f = fixture(t, async () => ({ matches: [{ id: "outside.md", excerpt: "private", line: 1 }] }));
  await assert.rejects(f.call("workspace.search", { query: "budget" }), /outside this request/);
  await assert.rejects(f.call("workspace.search", { query: "x".repeat(501) }), /1–500/);
  await assert.rejects(f.call("workspace.search", { query: "budget", mode: "hybrid" }), /owner-installed/);
  assert.equal((await f.call("workspace.search", { query: "budget", mode: "literal" })).engine, "literal");
});

test("hybrid search uses the same scoped staging and honors task lease rechecks", async (t) => {
  const f = fixture(t, async (options, { root }) => {
    assert.equal(JSON.parse(readFileSync(path.join(options.job, "request.json"))).mode, "hybrid");
    const files = readdirSync(path.join(options.job, "sources"));
    assert.equal(files.length, 1);
    assert.doesNotMatch(readFileSync(path.join(options.job, "sources", files[0]), "utf8"), /peer/);
    f.store.controlRun(run.id, "cancel");
    return { matches: [] };
  }, { CREW_KNOWLEDGE_SEMANTIC: "1" });
  const run = f.store.enqueue({ agent: "assistant", prompt: "Find relevant knowledge" });
  const claim = f.store.claimRun(run.id);
  await assert.rejects(f.call("workspace.search", { query: "budget", mode: "hybrid" }, "assistant", { runId: run.id, runLease: claim.lease }), /lease|active|cancel|context/);
});

test("sandbox mounts only staged data, one index and code; no ambient credentials or network", () => {
  const args = knowledgeSandboxArgs({ kind: "qmd", job: "/tmp/staged", cache: "/tmp/index", installation: { sandbox: true, qmd: true, modules: "/trusted/node_modules" } });
  assert.ok(args.includes("--unshare-all"));
  assert.ok(args.includes("--clearenv"));
  assert.ok(args.includes("/usr/bin/flock"));
  assert.ok(args.includes("/tmp/staged"));
  assert.ok(!args.includes(process.env.HOME));
  assert.ok(!args.includes("--share-net"));
  assert.throws(() => knowledgeSandboxArgs({ kind: "qmd", installation: { sandbox: false } }), /No unsandboxed fallback/);
});

test("live local QMD and Docling: real Markdown, Word, Excel and PDF through the governed bridge", { timeout: 180000 }, async (t) => {
  if (process.env.CREW_LIVE_KNOWLEDGE !== "1") return t.skip("set CREW_LIVE_KNOWLEDGE=1 after installing local QMD, Docling and bubblewrap");
  const f = fixture(t, null);
  const installation = knowledgeInstallation();
  const generated = spawnSync(path.join(installation.venv, "bin/python"), ["-c", "from docx import Document; from openpyxl import Workbook; from pptx import Presentation; import sys; from pathlib import Path; p=Path(sys.argv[1]); d=Document(); d.add_heading('Launch plan',0); d.add_paragraph('The approved launch budget is 2400 dollars.'); d.save(p/'plan.docx'); w=Workbook(); w.active.title='Forecast'; w.active.append(['Item','Budget']); w.active.append(['Launch',2400]); w.save(p/'budget.xlsx'); slides=Presentation(); slide=slides.slides.add_slide(slides.slide_layouts[0]); slide.shapes.title.text='Launch budget 2400'; slides.save(p/'budget.pptx')", path.join(f.root, "knowledge/assistant")], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  writeFileSync(path.join(f.root, "knowledge/assistant/budget.csv"), "Item,Budget\nLaunch,2400\n");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const stream = "BT /F1 12 Tf 72 720 Td (Launch budget 2400 dollars) Tj ET";
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  writeFileSync(path.join(f.root, "knowledge/assistant/budget.pdf"), pdf);
  const qmd = await f.call("workspace.search", { query: "budget", paths: ["knowledge/assistant/note.md"] });
  assert.equal(qmd.matches[0].path, "knowledge/assistant/note.md");
  for (const file of ["plan.docx", "budget.xlsx", "budget.pptx", "budget.csv", "budget.pdf"]) {
    const read = await f.call("workspace.read", { path: `knowledge/assistant/${file}` });
    assert.match(read.content, /2400/);
    assert.equal(read.engine, "docling");
  }
  const combined = await f.call("workspace.search", { query: "budget" });
  assert.ok(combined.matches.some((m) => m.path.endsWith("plan.docx")));
  assert.ok(combined.matches.some((m) => m.path.endsWith("budget.xlsx")));
  assert.doesNotMatch(JSON.stringify(combined), /peer/);
  const [one, two] = await Promise.all([f.call("workspace.search", { query: "budget" }), f.call("workspace.search", { query: "budget" })]);
  assert.deepEqual(one.matches, two.matches);
});

test("live parser sandbox denies host files, host secrets, writes to sources and network", { timeout: 20000 }, async (t) => {
  if (process.env.CREW_LIVE_KNOWLEDGE !== "1") return t.skip("set CREW_LIVE_KNOWLEDGE=1 to exercise real Linux isolation");
  const f = fixture(t);
  const job = path.join(f.directory, "staged");
  const cache = path.join(f.directory, "index");
  mkdirSync(job); mkdirSync(cache);
  writeFileSync(path.join(job, "source.md"), "Authorized fixture");
  const args = knowledgeSandboxArgs({ kind: "qmd", job, cache, installation: knowledgeInstallation() });
  args.splice(args.indexOf("/usr/bin/flock"));
  args.push("/runtime/node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import net from 'node:net';
    assert.equal(process.env.TEST_HOST_SECRET, undefined);
    assert.equal(fs.existsSync(${JSON.stringify(f.root)}), false);
    assert.equal(fs.existsSync('/etc/passwd'), false);
    assert.equal(fs.readFileSync('/work/source.md','utf8'), 'Authorized fixture');
    assert.throws(()=>fs.writeFileSync('/work/source.md','overwrite'));
    await new Promise((resolve,reject)=>{ const socket=net.connect(443,'1.1.1.1'); socket.on('connect',()=>{socket.destroy();reject(new Error('Network allowed'));}); socket.on('error',resolve); socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('Network probe timed out'));}); });
    console.log('isolated');
  `);
  const result = spawnSync("/usr/bin/bwrap", args, { env: { TEST_HOST_SECRET: "must-not-inherit" }, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /isolated/);
  assert.equal(readFileSync(path.join(job, "source.md"), "utf8"), "Authorized fixture");
});

test("live QMD hybrid retrieval with owner-provisioned local models", { timeout: 190000 }, async (t) => {
  if (process.env.CREW_LIVE_KNOWLEDGE_HYBRID !== "1") return t.skip("set CREW_LIVE_KNOWLEDGE_HYBRID=1 and CREW_KNOWLEDGE_MODELS after downloading QMD models");
  const f = fixture(t, null, { CREW_KNOWLEDGE_SEMANTIC: "1", ...(process.env.CREW_KNOWLEDGE_MODELS ? { CREW_KNOWLEDGE_MODELS: process.env.CREW_KNOWLEDGE_MODELS } : {}) });
  const result = await f.call("workspace.search", { query: "budget", mode: "hybrid" });
  assert.equal(result.mode, "hybrid");
  assert.equal(result.matches[0].path, "knowledge/assistant/note.md");
  assert.doesNotMatch(JSON.stringify(result), /peer/);
});
