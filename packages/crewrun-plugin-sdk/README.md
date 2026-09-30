# CrewRun integration plugin SDK

The versioned `crewrun.integration/v1` contract for CrewRun integration plugins and hosts.

It provides `defineIntegrationPlugin`, public manifest validation, OAuth URL helpers, safe
metadata shaping, and a registry that never exposes private adapter hooks. It does not persist
credentials, receive webhooks, or grant provider access; those responsibilities remain with a
host such as `@medhus-ai/crewrun-reference-host`.

See the [plugin-host boundary](https://github.com/medhus-ai/medhus-crewrun/blob/main/docs/host-api-v1.md#integration-plugin-host-boundary)
before publishing a plugin.
