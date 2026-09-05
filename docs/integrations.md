# Slack and Gmail

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
