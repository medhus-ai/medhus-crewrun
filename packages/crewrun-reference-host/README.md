# CrewRun reference host

A one-owner host for governed browser OAuth, signed provider webhooks, encrypted integration
state, and metadata-only Event Inbox routing. It bundles the Slack, Google Workspace, Microsoft
365, and GitHub App plugins behind CrewRun's internal MCP bridge; provider writes stay subject to
role authority and approval policy.

After the packages are published, install it beside `medhus-crewrun`, configure the operator-owned
environment variables, then run:

```bash
crewrun up /path/to/project --console
```

The callback listener is loopback-only by default. Keep the console on loopback too; expose only
the callback listener through an explicitly managed HTTPS endpoint such as Tailscale Funnel.

Complete setup, provider callback URLs, recovery, and plugin authoring guidance:
[Hosted integration reference host](https://github.com/medhus-ai/medhus-crewrun/blob/main/docs/reference-host.md).
