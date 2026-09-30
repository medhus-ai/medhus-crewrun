# CrewRun reference host

A one-owner host for governed browser OAuth, signed provider webhooks, encrypted integration
state, and metadata-only Event Inbox routing. It bundles the Slack, Google Workspace, Microsoft
365, and GitHub App plugins behind CrewRun's internal MCP bridge; provider writes stay subject to
role authority and approval policy.

After the packages are published, install it beside `medhus-crewrun`, configure the operator-owned
HTTPS origin, then run:

```bash
crewrun up /path/to/project --console
```

Use Integrations → Set up to save provider-app credentials in encrypted host storage, then choose
capabilities and connect through browser consent. Environment-owned credentials remain supported
and locked in the form. Account checks and event setup are separate; connecting never enables
automation. See [plugin installation and authoring](https://github.com/medhus-ai/medhus-crewrun/blob/main/docs/integration-plugins.md).

The callback listener is loopback-only by default. Keep the console on loopback too; expose only
the callback listener through an explicitly managed HTTPS endpoint such as Tailscale Funnel.

Complete setup, provider callback URLs, recovery, and plugin authoring guidance:
[Hosted integration reference host](https://github.com/medhus-ai/medhus-crewrun/blob/main/docs/reference-host.md).
