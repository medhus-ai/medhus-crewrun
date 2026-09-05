# Providers and authentication

[Documentation](README.md) / Providers

Open **Providers** to check available runtimes and select a runner for each agent in **Agents**.
Crewrun supports the Claude Agent SDK, the Codex SDK, and configured CLI runners.
Routed API profiles support OpenRouter, GLM, Kimi, and compatible local servers.

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

Subscription mode uses an already authenticated local runtime. Crewrun does not copy or forward
subscription credentials. Applications acting for other users need their own supported API or
cloud-provider integration. Consult the provider's current terms for your deployment.

## Routed providers

Profiles with `base_url` use API authentication at an Anthropic-compatible endpoint.
Crewrun sends a bearer token through `ANTHROPIC_AUTH_TOKEN` and clears `ANTHROPIC_API_KEY`
for that route.

- **OpenRouter:** set `OPENROUTER_API_KEY`. The `openrouter-auto` preset uses `openrouter/auto`;
  model discovery filters for tool-calling support.
- **GLM and Kimi:** configure the provider profile and its API key.
- **Local servers:** configure a compatible endpoint, such as an appropriately configured
  Ollama, LM Studio, or llama.cpp server. Compatibility depends on its protocol and tool support.

Stored API keys use the encrypted operator vault. Slack and Gmail credentials use separate
standalone storage. See [Security and storage](security.md).
