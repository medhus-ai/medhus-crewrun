# Agents

[Documentation](README.md) / Agents

An agent has a job, instructions, a runner, and permission to use specific tools.
Create and edit it in **Agents**, or edit `.crew/agents/<agent>.json` in your project.

```json
{
  "title": "Operations assistant",
  "instructions": "Prepare a brief with progress, blockers, and the next decisions.",
  "runner": "claude-agent-sonnet-high",
  "memory_pointers": ["docs/project-context.md"],
  "reflections": false,
  "heartbeat": "off",
  "web": false,
  "scheduled": [],
  "contract": {
    "version": 1,
    "revision": 1,
    "mandate": "Prepare project operations briefs.",
    "authority": {
      "tools": [
        { "name": "skill.read", "impact": "read" },
        { "name": "task.saveArtifact", "impact": "internal-write" }
      ]
    }
  }
}
```

Choose a runner available on your machine. Create any referenced context files before using them.
Agent names are lowercase slugs, such as `operations` or `research-assistant`.

## Instructions and shared defaults

Use `instructions` for the agent's job and `memory_pointers` for project or user context.
Pointers name files inside the project. An optional agent Markdown file is included when a
pointer names it; new JSON specs do not load that file automatically.

`.crew/agents/_defaults.json` supplies shared settings. Its memory pointers come first.
Contract defaults form a permission baseline: tools and scopes merge, while approval requirements
and budget settings can only become stricter. See [Permissions and approvals](governed-operations-v1.md).

Keep reusable procedures in [Skills](learning.md), and recurring work in [Scheduling](scheduling.md).

## Web access

Web access is off by default. Set `"web": true` for open access, or restrict domains:

```json
{ "web": { "allow": ["docs.example.com", "*.example.org"], "search": true, "max_chars": 40000 } }
```

Crewrun uses native web tools when the engine can honor the requested access. Otherwise it
provides `web.fetch` and `web.search`; fetch rejects private addresses and rechecks redirects.
A domain allowlist uses fallback tools for Codex because its native search cannot enforce it.
This setting governs exposed web tools; it is not a network sandbox for arbitrary native commands.

## Existing Roles projects

Existing `.crew/roles` files, `role` fields, role-named library exports, `/roles` bookmarks,
and `crewrun roles check` remain supported. Existing files are edited in place.
If both directories define an agent, the `.crew/agents` definition wins. Shared defaults fall
back to the legacy folder, and duplicate definitions do not produce duplicate schedules.
