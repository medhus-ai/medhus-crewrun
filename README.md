# Crewrun

Run AI agents on your machine using Claude, Codex, or a configured CLI or API provider.
Define their jobs and permissions, schedule work, review outgoing actions, and track results.
Use the local console or embed Crewrun in your application.

## Quick start

From this checkout, with Node.js 20 or newer:

```bash
npm install
node bin/crewrun.js up . --console
```

Open **http://127.0.0.1:4400**, add an agent, select a configured runner, and create a task.
You need a supported vendor sign-in or API key to run agent turns.

For a released version: `npm install -g medhus-crewrun`, then
`crewrun up ./my-project --console`. GitHub main may include changes not yet published to npm.

## What you can do

- Configure agents, permissions, schedules, and Skills as reviewable project files.
- Connect Slack and Gmail and review outgoing actions before they are sent.
- Follow tasks, saved results, delivery receipts, and usage in one console.
- Pause or cancel work and recover queued tasks after a restart.

## Documentation

[Getting started](docs/getting-started.md) · [Agents](docs/agents.md) ·
[Providers](docs/providers.md) · [Integrations](docs/integrations.md) ·
[Tasks and recovery](docs/runtime-recovery.md) · [Skills and context](docs/learning.md)

See the [documentation index](docs/README.md) for scheduling, security, library integration,
and the API reference. [Capabilities and limits](docs/state.md) · [Roadmap](docs/product-direction.md)

## License

[Apache License 2.0](LICENSE) · [NOTICE](NOTICE)
