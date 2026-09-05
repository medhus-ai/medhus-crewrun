# Skills and saved context

[Documentation](README.md) / Skills and context

Save information that makes future work more reliable: user preferences, application facts,
and repeatable procedures specific to your work. Crewrun installs no generic Skills by default.
Keep a general procedure only when there is evidence that it improves reliability.

## Choose where information belongs

| Information | Store it as |
|---|---|
| Project facts, conventions, or background | A file in the agent's `memory_pointers` |
| A short working preference | A reviewed preference |
| A repeatable procedure with a trigger and acceptance checks | A Skill |
| A suggested improvement discovered during work | An optional reflection proposal |

Prefer updating an existing entry over adding another. Current user instructions take precedence
when they conflict with saved context.

## Skills

Skills use `.crew/skills/<id>.md` or `.crew/skills/<id>/SKILL.md`. A procedure should state when
it applies, its inputs, steps, approval points, and how to judge the result.

```markdown
---
name: client-brief
description: Prepare this team's Monday client brief.
---

Read the active project notes. For each client, list progress, the current blocker,
and the next decision. Use the team's client names and status definitions.
Ask for review before sending the brief outside the project.
```

Skills are scoped to user, workspace, or repository; the more specific scope wins for the same ID.
Agents receive an index and load applicable content with `skill.read`.
`skill.propose` requires evidence and operator approval before installation.

```bash
crewrun skills index ./my-project --write
crewrun proposals list ./my-project
crewrun proposals approve ./my-project <proposal-id>
crewrun proposals reject ./my-project <proposal-id>
```

The console's **Approvals** page provides the same review flow.

## Preferences and reflections

Agent-inferred preferences use `prefs.propose` and require review. A trusted application can use
`saveUserPreference` to persist an explicit user instruction, including that instruction as evidence.
Preference precedence is repository, then workspace, then user.

Reflections are off by default. Enable `"reflections": true` only when occasional improvement
proposals are useful. `memory.reflect` requires a destination (`preference` or `skill`), a stable
`key`, proposed `text`, and `evidence`; a Skill destination also needs a `description`.

Pending duplicates are reused, and proposals expire after 30 days. Approval promotes the update
to its destination instead of appending a journal. Do not generate a reflection after every action.
Existing journals remain on disk for manual review and are not automatically added to prompts.
Legacy proposals without a destination can be completed through the console.
