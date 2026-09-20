import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync, rmSync, readdirSync, lstatSync } from "node:fs";
import { open, statfs } from "node:fs/promises";
import path from "node:path";
import { knowledgeInstallation, runKnowledgeProcess } from "./knowledge-process.js";

// Owner-only provisioning. Neither URLs nor model paths come from workspace/agent input.
export const EMBEDDING_MODEL = Object.freeze({
  name: "EmbeddingGemma 300M Q8_0", file: "embeddinggemma-300M-Q8_0.gguf",
  revision: "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12", bytes: 333590944,
  sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
  url: "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/0f741b5a6585bd53aeb15cd1372c56f2a0f65e12/embeddinggemma-300M-Q8_0.gguf",
  terms: "https://ai.google.dev/gemma/terms"
});
const LEASE_MS = 60000;
export async function verifyModel(file, model = EMBEDDING_MODEL) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size !== model.bytes) throw new Error("Model size or file type is invalid.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== model.sha256) throw new Error("Model checksum failed. Retry the download.");
}

export async function downloadModel({ file, model = EMBEDDING_MODEL, signal, progress = () => {}, fetchImpl = fetch }) {
  let url = new URL(model.url), response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !["huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs-us-1.huggingface.co", "cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co"].includes(url.hostname)) throw new Error("Unapproved model download destination.");
    response = await fetchImpl(url, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    url = new URL(response.headers.get("location"), url);
    if (redirects === 5) throw new Error("Too many model redirects.");
  }
  if (!response.ok || !response.body) throw new Error("Model download failed. Check connectivity and retry.");
  const size = response.headers.get("content-length");
  if (size && Number(size) !== model.bytes) { await response.body.cancel(); throw new Error("Unexpected model download size."); }
  const handle = await open(file, "wx", 0o600);
  const hash = createHash("sha256");
  let received = 0;
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted(); received += chunk.length;
      if (received > model.bytes) throw new Error("Model download exceeds its size limit.");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) offset += (await handle.write(chunk, offset)).bytesWritten;
      progress(received, model.bytes);
    }
    if (received !== model.bytes || hash.digest("hex") !== model.sha256) throw new Error("Model checksum or size failed. Retry the download.");
    await handle.sync();
  } finally { await handle.close(); }
}

export function createKnowledgeModels({ store, env = process.env, processRunner = runKnowledgeProcess, fetchImpl = fetch, model = EMBEDDING_MODEL, now = Date.now }) {
  const directory = path.join(path.dirname(store.file), "knowledge-models");
  const file = path.join(directory, model.file);
  const installation = knowledgeInstallation(env);
  const { db } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_setup (
    id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
    fallback INTEGER NOT NULL DEFAULT 1, ready TEXT, token TEXT, lease INTEGER,
    status TEXT NOT NULL DEFAULT 'not installed', completed INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0, error TEXT, agent TEXT
  ); INSERT OR IGNORE INTO knowledge_setup(id) VALUES(1)`);
  let active = null;
  function snapshot() {
    const row = db.prepare("SELECT * FROM knowledge_setup WHERE id=1").get();
    const busy = !!row.token && row.lease > now();
    const ready = row.ready === model.sha256 && existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() && statSync(file).size === model.bytes;
    return { model: model.name, bytes: model.bytes, terms: model.terms, ready, enabled: !!row.enabled,
      fallback: !!row.fallback, busy, status: row.token && !busy ? "interrupted — retry" : row.status,
      completed: row.completed, total: row.total, error: row.error, agent: row.agent,
      supported: installation.sandbox && installation.qmd, docling: installation.docling };
  }
  function configure({ enabled, fallback = true }) {
    if (snapshot().busy) throw new Error("Wait for the knowledge job or cancel it before changing preferences.");
    if (enabled && !snapshot().ready) throw new Error("Download and verify the embedding model first.");
    db.prepare("UPDATE knowledge_setup SET enabled=?,fallback=? WHERE id=1").run(enabled ? 1 : 0, fallback ? 1 : 0);
  }
  function start(status, work, agent = null) {
    if (active) throw new Error("A knowledge job is still stopping or running. Retry shortly.");
    if (!installation.sandbox || !installation.qmd) throw new Error("Local embeddings require QMD, Node 22+ and the Linux bubblewrap boundary.");
    const token = randomUUID();
    const claimed = db.prepare("UPDATE knowledge_setup SET token=?,lease=?,status=?,completed=0,total=0,error=NULL,agent=? WHERE id=1 AND (token IS NULL OR lease<=?)").run(token, now() + LEASE_MS, status, agent, now());
    if (!claimed.changes) throw new Error("A knowledge setup/index job is already running.");
    const controller = new AbortController();
    const check = () => {
      controller.signal.throwIfAborted();
      if (!db.prepare("SELECT 1 FROM knowledge_setup WHERE token=? AND lease>?").get(token, now())) throw new Error("Knowledge job cancelled or lease expired.");
    };
    const update = (status, completed = 0, total = 0) => {
      check();
      db.prepare("UPDATE knowledge_setup SET status=?,completed=?,total=? WHERE token=?").run(status, Math.max(0, Number(completed) || 0), Math.max(0, Number(total) || 0), token);
    };
    const timer = setInterval(() => {
      if (!db.prepare("UPDATE knowledge_setup SET lease=? WHERE token=? AND lease>?").run(now() + LEASE_MS, token, now()).changes) controller.abort();
    }, 10000);
    const promise = Promise.resolve().then(() => work({ token, check, update, signal: controller.signal })).then(() => {
      check();
      db.prepare("UPDATE knowledge_setup SET status=? WHERE token=?").run(status === "downloading" ? "ready" : "indexed", token);
    }).catch((error) => {
      db.prepare("UPDATE knowledge_setup SET status=?,error=? WHERE token=?").run(controller.signal.aborted ? "cancelled" : "failed", controller.signal.aborted ? null : safeError(error), token);
    }).finally(() => {
      clearInterval(timer);
      db.prepare("UPDATE knowledge_setup SET token=NULL,lease=NULL WHERE token=?").run(token);
      if (active?.token === token) active = null;
    });
    active = { token, controller, promise };
    return snapshot();
  }
  function install({ consent = false } = {}) {
    if (!consent) throw new Error("Confirm the model terms and local download before setup.");
    return start("downloading", async ({ token, check, update, signal }) => {
      db.prepare("UPDATE knowledge_setup SET ready=NULL WHERE token=?").run(token);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (lstatSync(directory).isSymbolicLink()) throw new Error("Model storage must not be a symlink.");
      for (const name of readdirSync(directory)) {
        if (/^[a-f0-9-]{36}\.part$/.test(name)) rmSync(path.join(directory, name));
        if (/^[a-f0-9-]{36}\.smoke$/.test(name)) rmSync(path.join(directory, name), { recursive: true, force: true });
      }
      const partial = path.join(directory, `${token}.part`);
      const smoke = path.join(directory, `${token}.smoke`);
      try {
        let valid = false;
        try { await verifyModel(file, model); valid = true; } catch { /* replace only after a verified download */ }
        if (!valid) {
          const disk = await statfs(directory);
          if (disk.bavail * disk.bsize < model.bytes + 128 * 1024 * 1024) throw new Error("Not enough disk space for the model and verification.");
          let last = 0;
          await downloadModel({ file: partial, model, signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60000)]), fetchImpl,
            progress: (bytes, total) => { if (now() - last > 250 || bytes === total) { update("downloading", bytes, total); last = now(); } } });
          check(); renameSync(partial, file);
        }
        check(); update("verifying");
        mkdirSync(path.join(smoke, "sources"), { recursive: true, mode: 0o700 });
        mkdirSync(path.join(smoke, "index"), { mode: 0o700 });
        writeFileSync(path.join(smoke, "sources", "smoke.md"), "# Travel\nThe railway station is near the airport.");
        writeFileSync(path.join(smoke, "request.json"), JSON.stringify({ mode: "hybrid", query: "train travel", limit: 1, build: true, verify: true }));
        const result = await processRunner({ kind: "qmd", job: smoke, cache: path.join(smoke, "index"), models: directory, installation, signal });
        if (!result.matches?.length || !Number.isFinite(result.matches[0].score)) throw new Error("Embedding verification failed.");
        check();
        db.prepare("UPDATE knowledge_setup SET ready=?,enabled=1 WHERE token=?").run(model.sha256, token);
      } finally { rmSync(partial, { force: true }); rmSync(smoke, { recursive: true, force: true }); }
    });
  }
  function cancel() {
    // The owning process sees this through its lease check even across consoles.
    db.prepare("UPDATE knowledge_setup SET token=NULL,lease=NULL,status='cancelled' WHERE token IS NOT NULL").run();
    active?.controller.abort();
  }
  return { directory, snapshot, configure, install, cancel, start,
    idle: async () => { await active?.promise; },
    close: async () => { if (active) { active.controller.abort(); await active.promise; } } };
}

function safeError(error) {
  // Never expose provider response bodies, signed download URLs or parsed document text.
  const text = String(error?.message || "");
  return /^(Model |Not enough disk|Embedding verification|Unapproved model|Unexpected model|Too many model|Knowledge job)/.test(text)
    ? text.slice(0, 180) : "Local knowledge job failed. Check installation, connectivity or source limits, then retry.";
}
