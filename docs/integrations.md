# Integrations

[Documentation](README.md) / Integrations

Open **Integrations** in the local console to connect an account. Standalone Crewrun provides
outbound Slack and Gmail actions without a custom host application. Provider credentials and
consent are still required, and every outgoing message requires review.

## Slack

1. Install a Slack app with `chat:write` and invite it to the destination channel.
2. Enter its bot or user OAuth token in **Integrations → Slack**.
3. In the agent's permissions, add `slack.postMessage | external-write`.
4. Add `connector:slack:slack` to the data the agent may change.

For thread replies, also grant `slack.replyToMention | external-write` and the
`app_mentions:read` scope. The standalone adapter does not subscribe to incoming mention events;
see the [Slack event gateway example](../examples/slack/README.md) for that workflow.

[Slack token setup](https://docs.slack.dev/authentication/tokens/).

## Gmail

1. Enable the Gmail API in your Google project.
2. Obtain an OAuth client ID, client secret, and refresh token with `gmail.compose`.
3. Enter them in **Integrations → Gmail**. Crewrun refreshes access tokens for unattended work.
4. Grant the agent `gmail.sendDraft | external-write` and the data scope `connector:gmail:gmail`.

Gmail sends an **existing draft**. Draft creation is not included in the standalone adapter.
To enable inbox access, explicitly check that option, grant `gmail.readonly` or a supported
broader scope, and grant the agent `gmail.searchMetadata | read` and/or `gmail.getMessage | read`
with `connector:gmail:gmail` under data it may read.

[Google OAuth setup](https://developers.google.com/identity/protocols/oauth2/native-app) ·
[Gmail draft sending](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send).

## Review and delivery

Outgoing requests appear in **Approvals** with the exact message or draft contents.
Approval queues the action. Before sending, the worker rechecks authority, the connected account,
and the reviewed draft. A changed account, draft, or contract requires a new request.

The task timeline shows the provider receipt or the next action needed. If delivery is uncertain,
reconcile it before resending. Provider acceptance does not prove that a recipient read or
received an email. See [Tasks and recovery](runtime-recovery.md).

## Disconnect and storage

Standalone credentials and reviewed payloads live in the project's private SQLite database under
`CREW_HOME/runtime/`, outside the repository by default. Disconnect removes local credentials;
it preserves task history and receipts. Revoke the grant at the provider to revoke its access.
See [Security and storage](security.md) for locations and protection.

## Calendar and messaging gateways

Crewrun's scheduled tasks can be shown in a calendar, but the task remains the source of truth:
Crewrun runs it from its local schedule and a connected calendar is only a one-way mirror. The
standalone adapter does not currently connect Google Calendar, Outlook/Microsoft 365, Teams, or
WhatsApp. A product host may add those connections through the supported host operations API.

For Google Calendar or Microsoft 365/Outlook, the host should mirror only Crewrun-created task
entries into a selected calendar. It should use a private stable mapping for updates and deletes,
show an explicit timezone, and never import or execute a calendar event as a Crewrun task. Do not
copy an agent's full task prompt, project path, tokens, or other private metadata into the event.

Teams and WhatsApp require a host gateway rather than a local connector form: the host owns the
provider app, OAuth or business-account setup, HTTPS webhook verification, replay/deduplication,
and subscription renewal. It must acknowledge inbound events before model work, route only
authorized events into a durable queue, and make each outbound post a narrow governed external
write. The [Slack event gateway example](../examples/slack/README.md) is the reference shape.

See [Calendar mirrors and gateway-backed integrations](host-api-v1.md#calendar-mirror-operation)
for the `syncCalendarTask` input schema and host responsibilities.
