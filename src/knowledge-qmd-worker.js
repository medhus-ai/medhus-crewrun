// Runs only inside knowledge-process's isolated child, never inside the credential-owning host.
import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { createStore, extractSnippet } from "@tobilu/qmd";

const { query, mode, limit, build = false, indexOnly = false, verify = false, fingerprint = "smoke", rebuild = false } = JSON.parse(readFileSync("/work/request.json", "utf8"));
const model = "/models/embeddinggemma-300M-Q8_0.gguf";
const progress = (completed, total) => process.stdout.write(JSON.stringify({ progress: { completed, total } }) + "\n");
const store = await createStore({ dbPath: "/index/index.sqlite", config: { models: { embed: model }, collections: { sources: { path: "/work/sources", pattern: "*.md" } } } });
try {
  await store.update();
  if (mode === "hybrid" && build) {
    const embedded = await store.embed({ force: rebuild, maxDocsPerBatch: 4, maxBatchBytes: 65536,
      onProgress: (info) => progress(info.chunksEmbedded, info.totalChunks) });
    if (embedded.errors) throw new Error("Incomplete embedding index");
    writeFileSync("/index/embedded.tmp", fingerprint); renameSync("/index/embedded.tmp", "/index/embedded");
  }
  const ready = existsSync("/index/embedded") && readFileSync("/index/embedded", "utf8") === fingerprint;
  if (mode === "hybrid" && !ready) throw new Error("Embedding index not ready");
  // Explicit lex/vec inputs skip query expansion; rerank:false avoids a second model.
  const results = indexOnly ? [] : verify ? await store.searchVector(query, { limit }) : mode === "hybrid"
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
  process.stdout.write(JSON.stringify({ matches }));
} finally { await store.close(); }
