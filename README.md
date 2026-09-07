# Crewrun

> Run an AI organization you can inspect, constrain, and change in Git.

Crewrun is a local control plane for an AI crew. It turns locally signed-in Claude or Codex
runtimes — or configured CLI/API providers — into focused agents with clear jobs, explicit
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
  operator’s signed-in runtime, or configure OpenRouter, other API routes, and compatible CLI
  runners.
- **Operate it from one place.** The dependency-free local console manages agents, Skills,
  scheduled tasks, calendar views, chats, integrations, approvals, audit history, providers, and
  usage.

## Quick start

From this checkout, with Node.js 20 or newer:

```bash
npm install
node bin/crewrun.js up . --console
```

Open **http://127.0.0.1:4400**, add an agent, select a configured runner, and create a task.
You need a supported vendor sign-in or API key to run agent turns.

Start with one useful role, then add schedules, Skills, and governed integrations as the work
proves itself.

For a released version: `npm install -g medhus-crewrun`, then
`crewrun up ./my-project --console`. GitHub main may include changes not yet published to npm.

## What you can do

- Build a small crew: an operations lead, analyst, writer, reviewer, or any focused role you need.
- Give each role a contract, model, memory pointers, tools, data scope, and budget boundary.
- Create a task now, schedule it with a friendly repeat rule, or run it on demand from the console.
- Chat with any agent in its single durable thread; use the Crew helper to draft safe setup changes.
- Propose reusable Skills for approval instead of silently rewriting long-term agent behavior.
- Connect Slack or Gmail, then review the exact approved outbound action before it is delivered.
- See task outcomes, artifacts, receipts, approval decisions, audit metadata, and usage in one place.
- Add calendar and messaging gateways through the stable host API without making external services
  a second scheduler or an ungoverned tool surface.

## Documentation

[Getting started](docs/getting-started.md) · [Agents](docs/agents.md) ·
[Providers](docs/providers.md) · [Integrations](docs/integrations.md) ·
[Tasks and recovery](docs/runtime-recovery.md) · [Skills and context](docs/learning.md)

See the [documentation index](docs/README.md) for scheduling, security, library integration,
and the API reference. [Capabilities and limits](docs/state.md) · [Roadmap](docs/product-direction.md)

## License

[Apache License 2.0](LICENSE) · [NOTICE](NOTICE)
