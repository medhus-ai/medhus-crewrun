# Migrating to v6-only CrewRun

This is a breaking cleanup, not an automatic migration. Back up your repository
and private state before changing configuration. The cleanup does not delete,
rewrite, or import an existing workspace, queue, credential file, or archive.

1. Stop the old automation before starting a replacement that consumes its events.
2. Create a reviewed workspace manifest with a fresh identity (or use
   `crewrun init` in a new workspace). Fresh identities leave old queues inactive.
3. Move agent definitions to `.crew/agents/<slug>.json`. Convert Markdown
   frontmatter manually; keep prose as explicitly scoped memory pointers.
   Shared defaults cannot declare an agent on their own.
4. Move global schedule entries into their owning agent's `scheduled` array.
   Rename the old `schedules` key and keep routines disabled for verification.
   Move legacy operational files out of the active workspace into your backup.
5. Put runner selections in agent JSON/defaults. Use `claude-agent` or
   `codex-agent` SDK profiles; retire CLI profiles and project runner mappings.
   Runner-level `allow_shell` no longer grants access; use the owner control.
6. Start with `crewrun up <workspace> --console`. Remove `--host`, custom
   directory branding and legacy environment prefixes from service definitions.
7. Configure installed integration plugins and reconnect through browser consent.
   Replace custom host tools/events with governed workspace tools and plugin
   adapters. Enable reviewed routes only after checking authority and delivery.

Removed APIs include standalone runtime/direct connectors, JSON action approvals,
file-based scheduler/pulse execution, arbitrary CLI/container engines, worktree
factories, Markdown role catalogs, and serialized MCP credential-child transport.
The unused custom-host password/viewer auth, Markdown task database, separate handoff queue,
output parsers, template reader and process wrapper APIs are also retired. Plugins put
runtime hooks in `adapter`, not top-level fields.

The Docker live test retired with its removed engine; model SDK, governed boundary,
shell-review and integration live tests remain opt-in. The repository's normal
suite now tests the v6 path and explicit rejection of retired inputs.

Rollback: stop v6 first, restore your backed-up configuration and matching older
CrewRun revision, then start only the old automation. Never run both event
consumers at once. No provider registration, Funnel activation or publishing is
part of this migration.
