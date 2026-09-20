# Knowledge models and local AI — release plan

Status: guided local embedding setup implemented for the verified Linux host; installer packaging remains separate.
Recorded: 2026-09-09. Decision updated: 2026-09-20.

The owner approved implementation of local knowledge setup after recording this
plan. Settings now provisions a pinned local model and bounded indexes. This does
not choose a chat server, activate a production workspace or ship desktop installers.

## Agreed built-in embedding experience

CrewRun's free core must include a first-class local knowledge setup using
**EmbeddingGemma 300M Q8_0**, matching the existing pinned QMD dependency's default.
Bundle inference support, not model weights in the installer: download weights
after install through owner-approved setup. No API key, paid subscription, separate
Ollama service or hosted account is required for document embeddings.

Why this default: reuse QMD/node-llama-cpp already present, a relatively small local
artifact and multilingual retrieval. Google describes the model as trained on over
100 languages; usefulness on our documents still requires measured evaluation.
[Model overview](https://ai.google.dev/gemma/docs/embeddinggemma).

Download only the embedding model for the baseline. The worker now uses explicit
lexical/vector queries and disables reranking, avoiding QMD's separate generation
and reranking weights. Both QMD's store and tokenizer resolve the fixed local model.

Settings shows Download and set up, terms, size, progress/cancel/retry, ready/degraded
status and index rebuild controls. Skipping setup keeps keyword search usable;
embedding failure must be visible and never trigger cloud upload. The pinned artifact
revision, checksum and maximum download size are recorded in `src/knowledge-models.js`;
do not rely on a mutable upstream branch or add model binaries to Git.

Docling extracts supported PDF/Office content; embeddings find relevant passages;
workspace.read returns authorized source text for the agent to interpret. Embeddings
do not add OCR, spreadsheet calculation, unsupported parsing or new file permissions.
Do not promise correct reading from retrieval alone.

First release targets Windows/Linux with independently verified runtime boundaries;
macOS is deferred. Initial chat choices are the separate local-model project or
OpenRouter. The embedding worker does not depend on either. Earlier Claude/Codex
optional-reranker ideas below are future design options, not bundled launch clients.

## Requested search pipeline

1. An embedding model indexes authorized document passages and embeds search queries.
2. QMD combines vector similarity with keyword retrieval.
3. An optional selected existing Claude, Codex, or compatible runner improves
   queries before retrieval and/or reranks bounded results afterward.

The embedding model and the reasoning/chat model have distinct jobs. Embeddings
must not be simulated by asking a chat model to print numeric vectors. Neither
query improvement nor reranking is required for basic hybrid retrieval.

Reuse Docling extraction, the QMD integration, runtime state, runner profiles,
usage reporting, and the existing scoped internal tool bridge. Do not introduce
a second task runtime, a separate agent-accessible search server, or a QMD fork
without first discussing a concrete upstream limitation.

## Current implementation versus proposed work

The current `workspace.search` defaults to QMD keyword search until owner setup,
then lexical/vector retrieval with visible keyword fallback. Model setup is an
owner-only, host-managed download followed by sandboxed inference verification.
New index generations build in a bounded background job; the sandbox has no network.
See [current workspace knowledge behavior](workspace-knowledge.md).

Independent cloud providers and existing-runner query improvement/reranking remain
deferred. Embedding-only hybrid retrieval and guided local provisioning are implemented.
An OpenAI embedding adapter requires investigation of the pinned
QMD interfaces; changing a local model filename is not sufficient. Confirm that
external vectors and provider-specific query embeddings can be supplied safely
before committing to the adapter design.

## Proposed Settings

Local EmbeddingGemma and None/keyword-only are the initial release choices. The
OpenAI API option and runner-based improvement below remain deferred; they are not
required to ship built-in local search.

### Knowledge search

- Embeddings: **None (keyword only)** / **Local EmbeddingGemma** /
  **OpenAI API embeddings**.
- Local setup: model identity, license/source, download size, installation and
  health status, **Download and set up**, retry/cancel, and **Build/rebuild index**.
- API setup: safe credential reference and embedding model selection; credentials
  remain in private host settings, never workspace files, chat, or tool arguments.
- Optional query improvement and reranking: independently enabled, using a
  selected existing compatible runner profile. Default both off.
- Fallback: explicit choice to return keyword-only results on embedding failure,
  or fail the request. Report degraded mode and reason in tool results and UI.
  Never silently switch from local to cloud processing.

Keep the future Crew helper's model selector separate from knowledge search and agent
models. Reuse existing profile configuration and persistent helper conversations;
model changes must not accidentally reuse an incompatible engine session.

### Local model provisioning

1. Owner initiates setup and sees the source, applicable terms, disk requirement,
   CPU/RAM guidance, and that initial indexing consumes local resources.
2. A bounded host-owned job downloads a pinned model from an approved source.
   Validate redirects, maximum size, checksum, and final file location; no
   arbitrary URLs, executables, or shell commands supplied by agents.
3. Support progress, cancellation, retry/restart recovery, partial-file cleanup,
   and atomic publication. Never mark partial downloads ready.
4. Run a real embedding smoke test in the restricted worker before showing ready.
5. Build authorized indexes in bounded background jobs with progress and recovery.
   Do not run an unbounded first-time indexing job inside a search request.

Downloads may access the network; inference workers must retain their existing
filesystem isolation. Share immutable model weights across agents, not document
indexes or authorization-sensitive caches. Downloading is an owner action, not an
agent tool or an automatic side effect of receiving a document.

## EmbeddingGemma impact

QMD's default Q8 model artifact is approximately **334 MB**. The local embedding
option would download this model only, not QMD's separate query-expansion and
reranking models. QMD uses node-llama-cpp, so **Ollama is not required** for this
embedded inference path. [QMD model setup](https://github.com/tobi/qmd/blob/main/README.md),
[model artifact](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/blob/main/embeddinggemma-300M-Q8_0.gguf).

- CPU execution is already configured in CrewRun; a GPU is not required for this
  path. Benchmark initial indexing and warm/cold query latency before promises.
- Provision roughly 1–2 GB of headroom per active indexing worker as a preliminary
  engineering allowance, not a measured minimum or guaranteed maximum. Bound
  concurrency and measure total process/native memory, not just the JS heap.
- Disk use includes model weights, extracted content, vectors, and SQLite indexes.
  Keep cache cleanup bounded and separate from canonical runtime state.
- Unchanged source/contract generations reuse vectors. Cross-generation incremental
  passage reuse is deferred: a changed bounded corpus currently rebuilds in the
  background to preserve strict source isolation. Model/pipeline fingerprints isolate
  index generations and completion markers activate only fully embedded indexes.
- Local embeddings have no provider inference charge. Electricity and hardware
  remain costs. Optional cloud improvement/reranking sends queries or authorized
  excerpts to its provider and needs explicit disclosure and consent.
- Gemma model terms are separate from QMD's software license. Surface the
  applicable model terms; do not imply unrestricted redistribution rights.
  [Google model card](https://huggingface.co/google/embeddinggemma-300m).

## Local AI stack discussion — no selection committed

A model requires an inference engine, but not necessarily a separate server.
EmbeddingGemma can run inside CrewRun's existing QMD worker. Local chat/helper
models may instead use an operator-managed inference endpoint.

| Candidate | Proposed fit | Tradeoff / verification needed |
| --- | --- | --- |
| Embedded QMD / node-llama-cpp | Minimal local document embeddings | Existing dependency; keep model download and worker lifecycle in CrewRun |
| Ollama | Friendly first documented local chat setup | Separate service and model management; verify the specific API and model capabilities |
| llama.cpp server | Lean, directly managed CPU/GPU inference | More operator configuration; native server tools must remain disabled |
| LM Studio / llmster | Desktop-first users or an existing headless installation | Additional application/daemon; verify endpoint and deployment requirements |
| vLLM | Dedicated inference server and higher concurrency | More hardware/deployment tuning; not necessary just for this embedding model |

Ollama documents compatible chat and embedding endpoints; compatibility is a
subset, not a guarantee of every protocol feature. [Ollama API](https://docs.ollama.com/api/openai-compatibility).
llama.cpp serves quantized models on CPU/GPU with chat and embedding routes.
Its optional built-in tools are not part of the proposed CrewRun integration.
[llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
LM Studio offers desktop operation and the GUI-independent llmster daemon.
[LM Studio headless setup](https://lmstudio.ai/docs/developer/core/headless).
vLLM supports hardware-specific GPU and CPU deployments; it is not GPU-only.
[vLLM GPU setup](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/),
[vLLM CPU setup](https://docs.vllm.ai/en/latest/getting_started/installation/cpu/).

Provisional recommendation: keep embedded local embeddings, offer Ollama as the
first friendly local-chat setup guide, and reuse one capability-tested endpoint
adapter for alternatives. Do not build four separate execution engines or
automatically install/manage every server. This recommendation needs discussion.

Decide before coding:

- Should CrewRun only connect to an installed local-chat server, or also own its
  installation, startup, upgrades, and model downloads?
- Is the initial target this Linux host, common personal desktops, or a shared
  inference server? Inspect GPU/VRAM before choosing chat models or vLLM settings.
- Which runtimes are tested/supported versus best-effort compatible endpoints?
- Should an existing Ollama embedding installation be reusable immediately, or
  remain later work beyond the three requested initial embedding choices?

## Boundaries and acceptance criteria

- Recheck tool grants, authorized paths, source revisions, and task lease before
  indexing and returning results. Test revocation, cross-agent access, symlinks,
  stale content, and concurrent indexing. Apply context limits before model calls.
- Keep keys out of the QMD worker. Any API adapter must be a narrowly scoped host
  service, not broad worker network access. Endpoint configuration is owner-only;
  constrain destinations, redirects, and credential forwarding.
- For local servers, prefer loopback/private authenticated ingress. Never expose
  model APIs through public Funnel as part of integration callback setup.
- Endpoint/model capability tests cover embeddings, dimensions, streaming,
  structured output and tool calls where used. “Compatible” does not mean verified
  agent execution. Unsupported capabilities stay disabled.
- Query improvement/reranking receives only bounded authorized text and has no
  tools or authority to change configuration. Treat document instructions as data.
- All agent tool execution remains in CrewRun's bridge. Do not enable a server's
  native shell/filesystem tools. Preserve the existing explicit single-shell-agent
  exception without expanding it through local inference.
- Account for auxiliary model calls, cancellation, and supported budgets. Report
  measured usage, estimates, and unavailable subscription costs distinctly.
- Tests cover download failure/recovery/checksum, keyword fallback visibility,
  provider/model switching and atomic rebuild, partial writes, scoped retrieval,
  mocked API failures, settings validation and secrets redaction.
- Run opt-in real local embedding and model-runtime checks after owner-approved
  installation. Report skipped cloud/provider tests explicitly.

## Remaining work

1. Package inference/parser prerequisites into the desktop/headless installers;
   validate Windows isolation separately. Current verified execution is Linux-only.
2. Evaluate safe incremental passage reuse across changed generations, cache cleanup,
   larger corpora and hardware-specific resource budgets; do not share role indexes.
3. Decide local chat runtime independently from the embedded retrieval worker.
4. Optional later API embeddings, query improvement/reranking and helper selector.
5. Broaden relevance/performance fixtures beyond the initial document and synonym tests.

Unit tests exercise consent, hashes, redirects, recovery, concurrent claims, console
controls and authority rechecks. Opt-in tests perform a real pinned model download,
sandbox embedding verification and scoped hybrid retrieval over document fixtures.
No production workspace activation, service restart, commit or push is implied.
