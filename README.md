# Crewrun

> A personal assistant or an organization of agents—with work you can inspect and decisions you control.

Crewrun is a local control plane for an AI crew. It turns locally signed-in Claude or Codex
runtimes — or compatible API providers — into focused agents with clear jobs, explicit
authority, durable work, and an operator console.

Instead of one opaque assistant with broad access, Crewrun lets you give each agent a versioned
contract: what it is responsible for, which tools and data it may use, what it may hand off, and
when the configured policy requires a human approval. You can schedule the work, chat with an
individual agent in one resumed thread, inspect the result, and keep the final decision.

## Why Crewrun

- **Make agents accountable.** Roles, instructions, authority, data boundaries, and budgets are
  reviewable project files — not hidden prompt state.
- **Keep work durable.** Tasks, scheduled runs, handoffs, results, receipts, approvals, and usage
  survive restarts in local transactional storage.
- **Let useful work happen safely.** Slack and Gmail actions are narrow and reviewable; high-impact
  actions wait for the approval policy you set.
- **Use the models you already operate.** Run native Claude and Codex through the local
  operator’s signed-in runtime, or configure OpenRouter and other compatible API routes.
- **Operate it from one place.** The dependency-free local console manages agents, Skills,
  scheduled tasks, calendar views, chats, integrations, approvals, audit history, providers, and
  usage.

## Quick start

From this checkout, with Node.js 20 or newer:

```bash
npm install
node bin/crewrun.js init ../my-crew --preset personal
node bin/crewrun.js up ../my-crew --console
```

Open **http://127.0.0.1:4400**, add an agent, select a configured runner, and create a task.
You need a supported vendor sign-in or API key to run agent turns.

Use `--preset organization` for a coordinator-led starting point. The side helper can prepare
editable setup proposals; you approve the changes in **Reviews → Workspace**. All initial
routines and event rules are disabled. Your repository holds knowledge and reviewed configuration;
private SQLite state holds tasks, chats, reviews, and credentials.

**Enforcement matters:** newly initialized workspaces support governed Claude-compatible runners
(including configured compatible API routes) and the verified Codex SDK on Linux. Authorized
actions go through CrewRun's internal bridge; native file access, shell, web, and subagents are
disabled or denied by default. An owner may explicitly select one privileged shell agent using
the red **Allow shell** setting; this exception currently uses direct Claude native auto mode,
with flagged commands in Reviews. It is not an OS isolation boundary. Both vendor subscription sign-ins remain supported. v6 has no legacy CLI or custom-host execution mode.
See [workspaces and limits](docs/workspaces.md) before choosing a runner or budget policy.

Start with one useful role, then add schedules, Skills, and governed integrations as the work
proves itself.

For a released version: `npm install -g medhus-crewrun`, then
`crewrun init ./my-project` followed by `crewrun up ./my-project --console`. GitHub main may include changes not yet published to npm.

## What you can do

- Build a small crew: an operations lead, analyst, writer, reviewer, or any focused role you need.
- Give each role a contract, model, memory pointers, tools, data scope, and budget boundary.
- Create a task now, schedule it with a friendly repeat rule, or run it on demand from the console.
- Chat with any agent in its single durable thread; use the Crew helper to prepare reviewable setup changes.
- Assign outcomes and completion criteria, delegate bounded child tasks, and answer blockers without losing the original task.
- Write scoped drafts freely while reviewing durable knowledge, skills, and agent configuration changes.
- Propose reusable Skills for approval instead of silently rewriting long-term agent behavior.
- Connect Slack or Gmail, then review the exact approved outbound action before it is delivered.
- See task outcomes, artifacts, receipts, approval decisions, audit metadata, and usage in one place.
- Use the bundled one-owner host for browser-based OAuth and signed events across Slack, Google
  Workspace, Microsoft 365, and GitHub App installations. Provider apps and HTTPS ingress still
  require self-host configuration; connecting alone does not enable automation.

## Documentation

[Getting started](docs/getting-started.md) · [Agents](docs/agents.md) ·
[Providers](docs/providers.md) · [Integrations](docs/integrations.md) ·
[Hosted integrations](docs/reference-host.md) ·
[Portable workspaces](docs/workspaces.md) · [v6 migration](docs/v6-migration.md) ·
[Tasks and recovery](docs/runtime-recovery.md) · [Skills and context](docs/learning.md)

See the [documentation index](docs/README.md) for scheduling, security, library integration,
and the API reference. [Capabilities and limits](docs/state.md) · [Roadmap](docs/product-direction.md)

## License

[Apache License 2.0](LICENSE) · [NOTICE](NOTICE)
