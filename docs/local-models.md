# Local models

[Documentation](README.md) / Local models

Crewrun runs agents on models served from your own computer through one supported runtime per
platform, a short list of tested models, and a recommendation based on your hardware. Prompts and
files sent to a local model stay on the machine that serves it.

| Platform | Runtime | Default address |
|---|---|---|
| macOS on Apple Silicon | [oMLX](https://github.com/jundot/omlx) (MLX, macOS 15+) | `http://127.0.0.1:8000` |
| Linux and Windows | [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` (GGUF) | `http://127.0.0.1:8080` |

Intel Macs cannot run local models but can connect to a llama.cpp or oMLX server on another computer. Both runtimes serve the Anthropic Messages API
(`/v1/messages`) and `/v1/models`, so a connected server becomes an ordinary runner profile on the
Claude engine and uses the same governed tool bridge as cloud models. Other local servers are not
supported.

## Supported models

| Model | Kind | GGUF (llama.cpp) | MLX (oMLX) | Memory needed |
|---|---|---|---|---|
| gpt-oss 120B | Mixture of experts, 5.1B active | `ggml-org/gpt-oss-120b-GGUF` MXFP4, 63.4 GB | `mlx-community/gpt-oss-120b-MXFP4-Q8`, 63.4 GB | 72 GB |
| Qwen3.6 35B-A3B | Mixture of experts, 3B active | `unsloth/Qwen3.6-35B-A3B-GGUF` UD-Q4_K_M, 22.1 GB | `lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit`, 20.4 GB | 28 GB |
| Qwen3.8 27B | Dense | `unsloth/Qwen3.8-27B-GGUF` UD-Q4_K_M, 16.5 GB | `lmstudio-community/Qwen3.8-27B-MLX-4bit`, 16.1 GB | 22 GB |
| Gemma 4 26B-A4B | Mixture of experts, 4B active | `unsloth/gemma-4-26B-A4B-it-GGUF` UD-Q4_K_M, 17.0 GB | `lmstudio-community/gemma-4-26B-A4B-it-MLX-4bit`, 15.6 GB | 22 GB |
| gpt-oss 20B | Mixture of experts, 3.6B active | `ggml-org/gpt-oss-20b-GGUF` MXFP4, 12.1 GB | `mlx-community/gpt-oss-20b-MXFP4-Q8`, 12.1 GB | 16 GB |
| Gemma 4 E4B | Small dense | `ggml-org/gemma-4-E4B-it-GGUF` Q8_0, 8.0 GB | `lmstudio-community/gemma-4-E4B-it-MLX-4bit`, 6.9 GB | 11 GB |

All six are Apache-2.0. "Memory needed" is a conservative working-set estimate for the listed
quantization with a 32k context. The list lives in `src/local-models.js` (`LOCAL_MODEL_CATALOG`).

## How the recommendation works

Crewrun reads total memory, NVIDIA GPU memory (`nvidia-smi`, when present), and free disk, then
rates each model:

| Rating | Rule |
|---|---|
| Fits in memory (Apple Silicon) | Memory needed ≤ 70% of unified memory |
| Fits on the GPU | Memory needed ≤ GPU memory − 1 GB |
| Experts in system memory (slower) | Mixture-of-experts model; fits in GPU memory plus 60% of RAM (`--n-cpu-moe`) |
| Runs on the CPU (slow) | Mixture-of-experts or small model within 60% of RAM |
| Needs a larger GPU | Dense model that would be too slow on the CPU |

A model also needs its download size plus 2 GB of free disk. The recommendation is the strongest
model in the fastest rating class. Nothing is recommended when no model fits; use a cloud profile.

## Set up

Open **Settings → Local models**, or run:

```bash
crewrun models recommend          # hardware, ratings, and exact setup commands
crewrun models recommend --json
```

**llama.cpp (Linux and Windows).** Install once (`winget install llama.cpp` on Windows,
`brew install llama.cpp` or a release archive on Linux), then start the recommended model.
`llama-server` downloads the weights on first start:

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M --alias qwen3.6-35b-a3b --jinja -c 32768 --host 127.0.0.1 --port 8080
```

`--jinja` is required for tool use. `--alias` sets the model name Crewrun uses.

**oMLX (Apple Silicon).** Install with Homebrew, download the MLX weights, and serve the folder:

```bash
brew tap jundot/omlx https://github.com/jundot/omlx && brew install jundot/omlx/omlx
hf download lmstudio-community/Qwen3.8-27B-MLX-4bit --local-dir ~/.crew/models/mlx/Qwen3.8-27B-MLX-4bit
omlx serve --model-dir ~/.crew/models/mlx --port 8000
```

You can also download models from the oMLX dashboard.

## Connect

With the server running, choose **Check and connect** in Settings, or:

```bash
crewrun models connect http://127.0.0.1:8080 --model qwen3.6-35b-a3b
crewrun models list
crewrun models remove local-qwen3.6-35b-a3b
```

The check lists the server's models, sends one short message, and sends one tool-use request.
The first request can take a minute while the model loads. A server without `/v1/messages` is
refused. A model that answers but does not call the tool is saved with a **no tool use**
warning, because agents need tool calls to do governed work. Connected models are saved in
`~/.crew/ai-runners.json` as `local-<model>` runners and appear in each agent's model picker.

Requests to a local server carry the placeholder bearer token `crewrun-local`, never your Claude
login or API keys, so connecting a model on another computer does not expose credentials.

## Limits

- Crewrun does not yet install the runtime, download weights, or start and stop the server.
- One model per server address; run a second server on another port for a second model.
- llama.cpp converts Anthropic requests internally and drops thinking blocks from history.
- Local model quality is below the frontier cloud models on long agent tasks; keep reviews on.
- Hardware detection covers NVIDIA GPUs only; other GPUs are treated as CPU-only.

## Next steps

- Managed setup: install the pinned runtime release, download weights with verified hashes
  (reusing the knowledge-model download pipeline), and start/stop the server with Crewrun.
- Size context and offload flags automatically from measured memory.
- Pair a MacBook with a GPU computer on the private network and route roles to it.
- Evaluate each catalog model on Crewrun's governed agent tasks before it is recommended.
- A large-model mode that streams mixture-of-experts weights from disk for small-memory machines.
