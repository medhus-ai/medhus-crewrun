// Runs only inside knowledge-process's isolated child, never inside the credential-owning host.
import { readFileSync } from "node:fs";
import { createStore, extractSnippet } from "@tobilu/qmd";

const { query, mode, limit } = JSON.parse(readFileSync("/work/request.json", "utf8"));
const store = await createStore({ dbPath: "/index/index.sqlite", config: { collections: { sources: { path: "/work/sources", pattern: "*.md" } } } });
try {
  await store.update();
  if (mode === "hybrid") await store.embed();
  const results = mode === "hybrid" ? await store.search({ query, limit }) : await store.searchLex(query, { limit });
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
