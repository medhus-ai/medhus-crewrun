# Providers and authentication

[Documentation](README.md) / Providers

Open **Settings → Providers & credentials** to check available runtimes and manage API keys, and
select a runner for each agent in **Agents**. Crewrun supports two engines: the Claude Agent SDK
and the Codex SDK. Routed API profiles on the Claude engine support OpenRouter, GLM, Kimi, and
[local models](local-models.md) served by llama.cpp or oMLX.

## Runner profiles

A profile chooses the engine, model, execution mode, and authentication method.
Concrete profiles live in `~/.crew/ai-runners.json`; agents refer to a profile by its `runner` ID.
`CREW_HOME` changes the operator storage directory.

```json
{
  "version": 1,
  "runners": [
    {
      "id": "claude-local",
      "engine": "claude-agent",
      "provider": "anthropic",
      "model": "sonnet",
      "mode": "propose",
      "auth": "subscription"
    }
  ]
}
```

In the agent spec, set `"runner": "claude-local"`.
For all profile fields and CLI argument substitutions, see the [profile schema](host-api-v1.md#runner-mappings-and-profiles).

## Authentication modes

| `auth` | Behavior |
|---|---|
| Omitted | Use the vendor runtime's normal credential resolution |
| `subscription` | Use the local operator's existing Claude or Codex sign-in; remove the relevant API-key override |
| `api-key` | Require the stored or configured provider key |

Subscription mode uses your own signed-in runtime on this computer. Crewrun never uploads,
shares, or shows these logins to agents, and never offers its own vendor sign-in:

- **Claude:** the Claude Agent SDK reads your existing `claude` login. Crewrun does not read or
  copy that credential. For the one owner-selected shell agent it passes the standard
  `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN` environment variables, when set, to that
  local child process.
- **Codex:** governed Codex runs use a private Codex home under
  `~/.crew/provider-runtime/codex…` so your personal Codex configuration (MCP servers, profiles,
  instructions) is not loaded into governed turns. Crewrun **copies your Codex login file**
  (`~/.codex/auth.json`, or `$CODEX_HOME/auth.json`) into that private home with owner-only
  permissions (0600), and refreshes the copy when your login file is newer. Signing out of Codex
  does not delete the copy; delete `~/.crew/provider-runtime/` to remove it.

Applications acting for other users need their own supported API or cloud-provider integration.
Consult the provider's current terms for your deployment.

## Routed providers

Profiles with `base_url` use API authentication at an Anthropic-compatible endpoint.
Crewrun sends a bearer token through `ANTHROPIC_AUTH_TOKEN`, clears `ANTHROPIC_API_KEY`, and
removes `CLAUDE_CODE_OAUTH_TOKEN` for that route. A routed profile never uses your Claude
subscription login: a cloud route without its provider key does not run, and local model
servers receive the fixed placeholder token `crewrun-local`.

- **OpenRouter:** set `OPENROUTER_API_KEY`. The `openrouter-auto` preset uses `openrouter/auto`;
  model discovery filters for tool-calling support.
- **GLM and Kimi:** configure the provider profile and its API key.
- **Local models:** llama.cpp (`llama-server`) on Linux and Windows, oMLX on Apple Silicon.
  Set them up in **Settings → Local models** or with `crewrun models`; see [Local models](local-models.md).

## API keys

Save provider keys in **Settings → Providers & credentials**. The first visit creates an encrypted
key store (AES-256-GCM, key derived from your password with scrypt) at `~/.crew/secrets.json`.
The store locks whenever Crewrun restarts: unlock it from the same page so agents on API-key
profiles can run. A console started without the crew loop (`crewrun console`) can save keys, but
only the console attached to the running crew (`crewrun up --console` or the app) unlocks them
for agents. A provider key set in Crewrun's environment is used when no stored key exists.

Integration credentials (Slack, Google, Microsoft, GitHub) use separate encrypted host storage.
See [Security and storage](security.md).
