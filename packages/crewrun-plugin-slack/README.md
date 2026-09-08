# CrewRun Slack integration plugin

A narrow Slack adapter for a governed CrewRun host. It supports OAuth, signed Events API
deliveries, a known-thread read, and approval-gated plain-text channel posts or mention replies.
It deliberately has no raw Slack Web API tool or arbitrary payload surface.

The reference host supplies private `clientId`, `clientSecret`, and `signingSecret` values at
runtime. Its standard Slack Events API URL is plugin-wide and maps a signed Slack `team_id` to one
connected workspace; an ambiguous workspace is not routed. Keep the CrewRun console private and
expose only the provider callback/webhook listener.

Deployment and role-authority guidance: [Hosted integration reference host](https://github.com/medhus-ai/medhus-crewrun/blob/main/docs/reference-host.md).
