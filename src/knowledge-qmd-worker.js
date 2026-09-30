// Runs only inside knowledge-process's isolated child, never inside the credential-owning host.
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { createStore, extractSnippet, Maintenance } from "@tobilu/qmd";

const { query, mode, limit, build = false, indexOnly = false, verify = false, fingerprint = "smoke", rebuild = false,
  incremental = false, generation = "", cleanup = false } = JSON.parse(readFileSync("/work/request.json", "utf8"));
if (incremental && !/^[0-9a-f]{64}$/.test(generation)) throw new Error("Invalid index generation");
// Incremental indexes are content-addressed: update() deactivates files outside this request,
// search returns only active documents, and embed() skips passages that already have vectors.
const marker = incremental ? `/index/ready/${generation}` : "/index/embedded";
const model = "/models/embeddinggemma-300M-Q8_0.gguf";
const progress = (completed, total) => process.stdout.write(JSON.stringify({ progress: { completed, total } }) + "\n");
const store = await createStore({ dbPath: "/index/index.sqlite", config: { models: { embed: model }, collections: { sources: { path: "/work/sources", pattern: "*.md" } } } });
try {
  await store.update();
  if (incremental && build && cleanup) {
    // A full-corpus build drops removed files' passages and vectors; markers for other source
    // sets are cleared because their vectors may be gone.
    const maintenance = new Maintenance(store.internal);
    maintenance.deleteInactiveDocs(); maintenance.cleanupOrphanedContent(); maintenance.cleanupOrphanedVectors();
    rmSync("/index/ready", { recursive: true, force: true });
  }
  if (mode === "hybrid" && build) {
    const embedded = await store.embed({ force: rebuild, maxDocsPerBatch: 4, maxBatchBytes: 65536,
      onProgress: (info) => progress(info.chunksEmbedded, info.totalChunks) });
    if (embedded.errors || (incremental && store.internal.getHashesNeedingEmbedding() > 0)) throw new Error("Incomplete embedding index");
    if (incremental) mkdirSync("/index/ready", { recursive: true });
    writeFileSync(`${marker}.tmp`, fingerprint); renameSync(`${marker}.tmp`, marker);
  }
  const ready = existsSync(marker) && readFileSync(marker, "utf8") === fingerprint
    && (!incremental || store.internal.getHashesNeedingEmbedding() === 0);
  const stale = incremental && mode === "hybrid" && !build && !ready;
  if (stale) rmSync(marker, { force: true });
  else if (mode === "hybrid" && !ready) throw new Error("Embedding index not ready");
  // Explicit lex/vec inputs skip query expansion; rerank:false avoids a second model.
  const results = indexOnly || stale ? [] : verify ? await store.searchVector(query, { limit }) : mode === "hybrid"
    ? await store.search({ queries: [{ type: "lex", query }, { type: "vec", query }], rerank: false, limit })
    : await store.searchLex(query, { limit });
  const matches = [];
  for (const row of results) {
    const file = row.filepath || row.file;
    const body = await store.getDocumentBody(file);
    if (typeof body !== "string") continue;
    const snippet = extractSnippet(body, query, 1200, row.chunkPos ?? row.bestChunkPos);
    matches.push({ id: file.split("/").at(-1), score: row.score, excerpt: snippet.snippet.slice(0, 1600), line: snippet.line });
  }
  process.stdout.write(JSON.stringify(stale ? { matches, pending: true } : { matches }));
} finally { await store.close(); }
