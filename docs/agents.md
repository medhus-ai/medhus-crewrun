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

## Collaboration

`crew.roster` is a read-only, governed agent directory. It reports each agent's reviewed responsibility, applicable Skills, high-level tool capabilities, and whether a two-way handoff is eligible. Use `task.delegate` only for an eligible peer; the child task is auditable and does not inherit authority. Agents must complete work only within their own contract.

## Web access

New workspaces and agents receive free, best-effort DuckDuckGo search and public-page fetching by default. Existing agents keep their current setting until their versioned contract explicitly grants the tools. Set `"web": false` to turn it off, or restrict domains:

```json
{ "web": { "allow": ["docs.example.com", "*.example.org"], "search": true, "max_chars": 40000 } }
```

Web tools use the governed MCP bridge: `web.search` returns DuckDuckGo results and `web.fetch` reads a selected public page. Fetch rejects private addresses and rechecks redirects; grant the relevant tools and data authority in the agent contract as well as enabling web. Future paid search providers will be host-configured and return the same bounded result format—agent contracts never hold provider credentials.
This setting does not constrain the privileged shell agent's native commands.

Agent definitions must be JSON in `.crew/agents`. Markdown is context, not a
definition; old role folders and schedule keys need [explicit migration](v6-migration.md).
