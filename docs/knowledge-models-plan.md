# Knowledge models and local AI — deferred plan

Status: discussion draft, implementation explicitly paused by the owner.
Recorded: 2026-09-09.

This document records the requested direction, not released functionality or
authorization to download models, install services, change settings, or restart
CrewRun. Discuss the local AI runtime stack before implementation.

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

The current `workspace.search` defaults to QMD keyword search. Its optional hybrid
mode invokes QMD's local embedding, query-expansion, and reranking pipeline.
Model downloads are operator-managed; the sandbox cannot access the network.
See [current workspace knowledge behavior](workspace-knowledge.md).

The requested independent provider selectors, embedding-only hybrid path,
existing-runner query improvement/reranking, and guided model download are not
implemented. An OpenAI embedding adapter requires investigation of the pinned
QMD interfaces; changing a local model filename is not sufficient. Confirm that
external vectors and provider-specific query embeddings can be supplied safely
before committing to the adapter design.

## Proposed Settings

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

Keep the Crew helper's model selector separate from knowledge search and agent
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
- Index new/changed passages incrementally; do not unnecessarily embed an entire
  corpus after one file edit. Rebuild vectors when model/dimensions/prompt format
  change, with atomic index activation and no mixed-vector searches.
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

## Later implementation sequence

1. Agree on the local-runtime scope and validate QMD adapter feasibility.
2. Add private settings and explicit keyword/fallback behavior using existing UI.
3. Add bounded local model provisioning and incremental embedding-only retrieval.
4. Add API embeddings with credential isolation, consent, and usage accounting.
5. Add optional runner-based improvement/reranking and the helper selector.
6. Verify boundaries, recovery, resource use and UI; update released docs only
   when behavior is actually implemented and tested.

No model download, service installation, implementation, activation, commit, or
push is authorized by this planning document.
