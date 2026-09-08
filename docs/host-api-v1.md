# v6 host and plugin contracts

v6 intentionally breaks the old custom-host API. The bundled reference host is the
execution host; extensions are integration plugins. See [migration](v6-migration.md).

The reference host exposes `operations`, `knownEvents`, `durableRuntime`,
`start()`, `tick()`, and `stop()`. `createUp({ targetRoot, host })` reuses
its durable runtime for transactional scheduling; it does not accept a turn-only
host or an in-memory event bus. Close the console before stopping the host.

Console operations cover task enqueue/control, result and action decisions,
workspace proposals, persistent chats, OAuth connections, and authorized event
rules. Use the supplied operations object; do not compose a parallel approval queue.

Contracts and schemas:

- Workspace: `.crew/workspace.json`, version 1; [format and tools](workspaces.md).
- Agent: `.crew/agents/<slug>.json`, with versioned `contract`; [authority](governed-operations-v1.md).
- Scheduled definitions: only `scheduled` in the agent JSON; [scheduling](scheduling.md).
- Plugin: `crewrun.integration/v1`, from `@medhus-ai/crewrun-plugin-sdk`.
  Runtime hooks live in `adapter`; top-level hook compatibility is rejected.
- Events: verified provider metadata or transactional lifecycle events. Stable IDs
  deduplicate internal delivery; external writes still need uncertain-delivery reconciliation.

See [reference host](reference-host.md) for provider capabilities, encryption,
OAuth/PKCE, webhook verification, subscription renewal and disconnect contracts.
See [library use](library.md) for startup and shutdown.
