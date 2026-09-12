# Workspace knowledge: QMD and Docling

CrewRun uses [QMD](https://github.com/tobi/qmd) for local document search and
[Docling](https://github.com/docling-project/docling) for document conversion.
They are host components behind the existing internal MCP bridge, not separate
agent-accessible MCP servers. No cloud search account or provider key is required.

## Agent tools

Every ordinary agent with the existing `workspace.search` and `workspace.read`
tool grants gets these capabilities. No new file grants are added. The normal
personal/organization presets already include both tools; existing contracts
which deliberately omit them remain restricted. The setup helper is not a
workspace-reading agent and does not gain broad knowledge access.

- `workspace.search({query, mode?, paths?})`: QMD keyword search by default, returning
  up to ten matches, original source paths, content revisions and excerpts.
  `mode: "hybrid"` uses local embeddings, query expansion and reranking after owner
  setup below. `paths` optionally selects 1–50 specific authorized files.
- `workspace.read({path, offset?, limit?})`: existing text reads remain unchanged.
  PDF, DOCX, XLSX, PPTX and CSV are converted with Docling to paginated Markdown.
  Offsets for converted documents are bytes in the extracted Markdown, not the
  original binary file. Results include source revision and available Docling
  element/page references. A changed source invalidates cached extraction.
- `workspace.search({query, mode: "literal"})`: basic scoped Markdown search without
  QMD or Python. This is explicit, never a silent downgrade from hybrid search.

Example: search for `launch budget`, then read `knowledge/budget.xlsx` from a
matching result. Cite its source/revision. Extracted line numbers are **not Excel
cell addresses** or PDF page numbers. Docling extraction does not evaluate formulas
or guarantee current formula results. Use authorized provider range reads for live
spreadsheet calculations. Scanned PDFs needing OCR fail rather than claim a complete
result. This release uses Docling's model-free native PDF pipeline, not OCR/VLM.

Supported sources are local workspace files. This does **not** automatically sync
Google Drive, Docs, Sheets or Microsoft files: existing provider tools remain
separate, and connecting a provider does not start indexing or automation.

## Host setup

Use Linux with Node 22+ for QMD (the core still supports Node 20), Python 3.10+
and `bubblewrap` plus `util-linux` (`flock`, `prlimit`). Install OS packages using
your distribution's package manager. Unprivileged user namespaces must work for
the account running CrewRun. A container may need an explicit operator security
configuration; CrewRun never falls back to unrestricted execution.

From a checkout, `npm install` installs the pinned optional `@tobilu/qmd@2.8.3`.
`npm install --omit=optional` leaves it unavailable and does not prevent core startup.
Create a dedicated Python virtual environment (do not use a credential-containing
application environment):

```sh
python3 -m venv node_modules/.crewrun-docling
node_modules/.crewrun-docling/bin/python -m pip install -r docs/docling-requirements.txt
```

This selects Docling's slim Office/native-PDF components, not the full GPU stack.
Some Linux distributions require their `python3-venv` package first. For a global
CrewRun installation or an environment outside the checkout, set
`CREW_DOCLING_VENV` to that dedicated environment's absolute directory in the host
service environment. Use a system-Python-based venv: the sandbox exposes `/usr`
system libraries, not arbitrary Conda installations or the host home.

Restart the host after dependency/environment changes. Missing components produce
an actionable tool error; ordinary text reads and explicit literal search still work.

### Optional local hybrid search

Keyword search and Office/native-PDF extraction do not download models. For hybrid
search, the **operator** downloads QMD's default models before enabling it. This
requires disk space and local CPU/RAM; model downloads are not performed by agents.

```sh
# Choose a private, dedicated cache directory outside the workspace.
XDG_CACHE_HOME=/absolute/private/crew-knowledge-models ./node_modules/.bin/qmd pull
```

Set these values in the CrewRun service environment and restart:

```ini
CREW_KNOWLEDGE_MODELS=/absolute/private/crew-knowledge-models
CREW_KNOWLEDGE_SEMANTIC=1
```

The directory must contain QMD's `qmd/models/` cache. Models are mounted read-only;
the worker uses CPU mode and cannot fetch missing models. Only the pinned default
model configuration is used; workspace QMD hooks, YAML, custom model URLs, plugins
and ambient provider credentials are not loaded. Missing models cause a failure,
not a network request or silent keyword fallback. Local indexing inference is not
reported as a provider API charge.

## Boundary and private state

1. Check the acting agent's current tool and data grants before reading sources.
2. Read through directory descriptors with no-follow checks; deny traversal,
   symlinks, hard links, devices and other special files.
3. Stage only authorized bytes. QMD never indexes the original workspace or a
   shared cross-agent collection, even when filtering results would appear sufficient.
4. Run subprocesses in Linux bubblewrap with no network, no host credentials or
   workspace mounts, read-only staged inputs and runtime dependencies. Only the
   selected QMD index and temporary sandbox area are writable. Apply CPU, output,
   file-size and wall-clock limits; Docling also has an address-space limit.
5. Recheck the contract, task lease and all source revisions before returning results.
   Reject the whole response after revocation, deletion or a source change. Record
   indexed source references/revisions in task audit events, not just returned hits.

Source content is untrusted data, not instructions or permission grants. Parsed
content/indexes do not rewrite durable knowledge, skills or configuration. Even
the optional shell agent uses this same scoped knowledge bridge; its separately
authorized native-shell exception is unchanged.

Private derived caches live beside the workspace's runtime `state.sqlite`, in
`knowledge/`. Each role/contract/content generation is isolated; unchanged QMD
generations reuse their index/embeddings. OS file locks serialize concurrent
access and release on process exit. Old generations are never selected by new
permissions, but their bytes remain private owner-readable cache until cleanup.
Stop the host before removing that workspace's **knowledge directory only** to
purge cached documents or reclaim space; do not remove `state.sqlite`, credentials,
or the workspace. Sources are unchanged and indexes rebuild on the next call.

Discovery is bounded to 5,000 entries, depth 30, and 100 authorized files; a
`truncated` response explicitly signals partial discovery. Select narrower `paths`
when needed. Other limits: 10 MB per source, 32 MB total source/extracted corpus,
2 MB extracted text per Office/PDF file, 100 PDF pages, ten newly parsed documents
per call, and a 256 MiB per-agent cache admission threshold. Oversized or malformed
inputs fail explicitly. The threshold is checked before each call, not a filesystem
quota. Jobs clean up on completion; an abruptly killed host can leave private
`knowledge/jobs/` snapshots which can be removed with the host stopped.

## Verification

```sh
node --test test/workspace-knowledge.test.js
CREW_LIVE_KNOWLEDGE=1 node --test test/workspace-knowledge.test.js
# Only after downloading the local models:
CREW_LIVE_KNOWLEDGE_HYBRID=1 node --test test/workspace-knowledge.test.js
```

The first command checks authority, staging, invalidation, caching, schemas and MCP
registration with controlled adapters. The opt-in command runs real QMD, Docling,
Word/Excel/CSV/PDF fixtures, concurrent searches and active sandbox-denial probes.
It needs no provider credentials or public HTTPS. Hybrid-model quality/performance
is separate from these keyword/parser checks; do not interpret passing them as
verification of model downloads or semantic retrieval quality.

QMD and Docling code are MIT-licensed; preserve their notices. Model weights have
their own licenses. The npm lockfile pins QMD's dependency resolution; the Docling
requirements pin its top-level release (transitive Python dependencies follow its
declared compatible constraints).
