# Hosted integration reference host

[Documentation](README.md) / [Integrations](integrations.md) / Hosted integration reference host

The v6 reference host is a small, one-owner deployment for browser consent and provider
webhooks. It keeps Crewrun's local console private, while exposing only the provider callback
and webhook routes through an operator-managed HTTPS endpoint. It is built from installable
workspace packages rather than making provider APIs part of Crewrun's core runtime.

It is a reference implementation, not a hosted Crewrun service: the operator owns provider app
registration, the encryption key, the public endpoint, the project, and the running process.

## What crosses each boundary

```text
private operator + console ── Connect / approve / route ──┐
                                                        reference host
provider consent or webhook ── Funnel ── loopback ingress ┤── encrypted integration state
                                                        └── governed internal MCP bridge ── agent
```

- The public listener accepts only OAuth callbacks and signed/verified webhook deliveries.
- The console is a separate private listener; do not put it behind Funnel.
- OAuth state is one-time and short-lived. PKCE is used for providers that support it; GitHub App
  installation redirects still use a one-time state value even though they are not OAuth code
  exchanges. State is bound to its intended provider callback, and a durable per-provider claim
  serializes reconnect replacement across reference-host processes.
- Connection credentials, PKCE verifiers, and subscription secrets are encrypted and bound to
  their record identity in the host's SQLite state. Console snapshots, agent prompts, MCP
  context, and audit records receive only safe connection metadata.
- A verified delivery is recorded and deduplicated before it is acknowledged. The Event Inbox
  stores a digest plus limited routing metadata, not its raw provider body.
- Inbound events do nothing by default. An operator must create an enabled route and the target
  agent must both subscribe to the event in its `hooks` and have a matching read data scope.
- Provider operations are curated internal MCP tools. They are never a generic provider API or
  remote-MCP proxy. Every external write is subject to the role contract and approval policy,
  then rechecked when it is delivered. If its provider receipt is lost, CrewRun marks the write
  uncertain rather than retrying it automatically.

## Packages

| Package | Responsibility |
|---|---|
| `@medhus-ai/crewrun-plugin-sdk` | Immutable `crewrun.integration/v1` manifest validation and safe public metadata. |
| `@medhus-ai/crewrun-reference-host` | Encrypted state, loopback ingress, Event Inbox/routes, governed bridge, and host lifecycle. |
| `@medhus-ai/crewrun-plugin-slack` | Slack OAuth, narrow thread/message actions, signed Events API deliveries. |
| `@medhus-ai/crewrun-plugin-google-workspace` | Gmail, Drive, Docs, and Sheets OAuth/actions plus mail/file-change signals. |
| `@medhus-ai/crewrun-plugin-microsoft-365` | Delegated Microsoft Graph access for Outlook, OneDrive, Excel, and Teams. |
| `@medhus-ai/crewrun-plugin-github` | GitHub App installation-scoped repository access and signed webhooks. |

The packages are structured for npm publishing, but this branch does not publish them for you.
After a release, install `medhus-crewrun` and `@medhus-ai/crewrun-reference-host` together; the
reference-host package declares the standard provider plugins. Until then, use this workspace
checkout or normal npm `file:`/workspace resolution.

## Public endpoint and ingress

This deployment has one fixed public base URL:

```text
https://arsazmar0smars3.taila9c41d.ts.net
```

Set it as `CREWRUN_PUBLIC_BASE_URL` without a trailing slash. It must be an HTTPS origin (no path,
query, fragment, or user-info); that keeps its deterministic callback paths reachable through the
root-mounted Funnel. The reference ingress then binds only to `127.0.0.1:4411` by default:

```bash
export CREWRUN_PUBLIC_BASE_URL=https://arsazmar0smars3.taila9c41d.ts.net
export CREWRUN_INTEGRATIONS_HOST=127.0.0.1
export CREWRUN_INTEGRATIONS_PORT=4411
# Use a long, random secret held by the service manager, not in the repository.
export CREWRUN_INTEGRATIONS_KEY='replace-with-a-strong-host-secret'
```

Callback paths are deterministic:

| Purpose | Path |
|---|---|
| OAuth callback | `/integrations/oauth/<plugin-id>/callback` |
| Webhook, plugin-wide | `/integrations/webhooks/<plugin-id>` |
| Webhook, connection-specific | `/integrations/webhooks/<plugin-id>/<connection-id>` |

For example, the Slack OAuth callback is
`https://arsazmar0smars3.taila9c41d.ts.net/integrations/oauth/slack/callback`; the standard
Slack Events API endpoint is
`https://arsazmar0smars3.taila9c41d.ts.net/integrations/webhooks/slack`. The host maps its signed
Slack `team_id` to exactly one connected workspace. A connection-specific webhook URL remains
available where a provider or deployment needs an opaque per-connection route.

### Funnel is an explicit operator action

Funnel is not activated by Crewrun. After starting the loopback listener, the operator can expose
only that port with a current Tailscale CLI, for example:

```bash
tailscale funnel --bg 4411
tailscale funnel status
```

This maps the public HTTPS hostname to the loopback service; it does not make the Crewrun console
public. Funnel requires the tailnet policy/permission, MagicDNS, and HTTPS certificate support.
It has public-exposure and bandwidth limits, and a Funnel/Serve configuration on the same port
conflicts. Review the [Tailscale Funnel documentation](https://tailscale.com/docs/features/tailscale-funnel)
and [CLI reference](https://tailscale.com/docs/reference/tailscale-cli/funnel) before enabling it.

To stop exposure, use the matching `tailscale funnel … off` form supported by the installed CLI,
then confirm with `tailscale funnel status`. Stopping Funnel does not revoke provider grants; use
the recovery procedure below as well.

## Operator configuration

The published reference-host package exports the `createHost` entry point understood by CrewRun;
you do not need a custom module for the standard four plugins. From a service directory with
both `medhus-crewrun` and `@medhus-ai/crewrun-reference-host` installed, run:

```bash
crewrun up /path/to/project --console
```

From this source checkout, use `node bin/crewrun.js` in place of `crewrun`. The normal CLI keeps
the console on `127.0.0.1:4400`; do not override that to a public address. The integration ingress
is started by the host on the loopback address and port shown above.

Keep client secrets, webhook signing secrets, and the GitHub App private key in the service
manager or vault that launches CrewRun. Do not put them in agent files, `.crew` files, console
form fields, or source control. The standard host reads these operator-owned environment values:

| Provider | Required configuration | Optional configuration |
|---|---|---|
| Host | `CREWRUN_PUBLIC_BASE_URL`, `CREWRUN_INTEGRATIONS_KEY` | `CREWRUN_INTEGRATIONS_HOST`, `CREWRUN_INTEGRATIONS_PORT` |
| Slack | `CREWRUN_SLACK_CLIENT_ID`, `CREWRUN_SLACK_CLIENT_SECRET`, `CREWRUN_SLACK_SIGNING_SECRET` | — |
| Google Workspace | `CREWRUN_GOOGLE_CLIENT_ID`, `CREWRUN_GOOGLE_CLIENT_SECRET` | For Gmail push: `CREWRUN_GOOGLE_GMAIL_PUBSUB_TOPIC`, `CREWRUN_GOOGLE_GMAIL_PUSH_AUDIENCE`, and `CREWRUN_GOOGLE_GMAIL_PUSH_SERVICE_ACCOUNT` |
| Microsoft 365 | `CREWRUN_MICROSOFT_CLIENT_ID` | `CREWRUN_MICROSOFT_CLIENT_SECRET` |
| GitHub App | `CREWRUN_GITHUB_APP_ID`, `CREWRUN_GITHUB_APP_SLUG`, `CREWRUN_GITHUB_WEBHOOK_SECRET`, and `CREWRUN_GITHUB_PRIVATE_KEY` or `CREWRUN_GITHUB_PRIVATE_KEY_BASE64` | — |

`CREWRUN_INTEGRATION_PLUGIN_CONFIG` may instead carry a JSON object keyed by plugin ID; it merges
with the named values above. It is intended for a service manager, never for a checked-in config
file. `CREWRUN_INTEGRATIONS_KEY` is a durable, high-entropy host secret. Changing it makes existing
encrypted credentials unreadable, so retain the prior value until affected connections have been
deliberately disconnected and recreated.

The Google Workspace plugin has a built-in verifier for Google Pub/Sub OIDC tokens: it validates
the signed RS256 token against Google's published JWKS and requires the exact
`CREWRUN_GOOGLE_GMAIL_PUSH_AUDIENCE` plus the exact verified email from
`CREWRUN_GOOGLE_GMAIL_PUSH_SERVICE_ACCOUNT`. Configure that service account on the Pub/Sub push
subscription; without both values Gmail push is rejected. A programmatic `verifyOidcToken`
override is only for a host with an explicit specialized trust policy; ordinary deployments do
not need to write one.

The GitHub plugin can create short-lived App JWTs itself from the configured PEM (base64 is often
more convenient for a service manager). A programmatic `signAppJwt` hook remains available for a
vault or HSM integration. Do not substitute a personal access token.

For a custom host, call `createIntegrationHost` directly and pass constructed plugins plus private
`pluginConfig`. Governed Codex turns call the live host bridge over an authenticated, turn-scoped
loopback MCP connection; no plugin modules or credentials need to be copied into a child.
Keep ingress, encryption, approvals and public-metadata boundaries in the host; do not move credentials or raw provider APIs into agent context.

## Provider setup

Register provider applications as the one owner of this host. Select the smallest capability set
needed for the role, then give the role the corresponding tool authority and a connection-specific
data scope such as `connector:slack:<connection-id>`.

| Provider | Register and configure | High-level consent/permissions | Inbound setup |
|---|---|---|---|
| Slack | Create an app at [api.slack.com/apps](https://api.slack.com/apps); add the fixed Slack callback. | `chat:write`; add `channels:history` for public-channel thread reads/messages and `app_mentions:read` for mentions. | Set the Events API URL to the plugin-wide Slack webhook path, subscribe only to `app_mention` and/or public-channel message events, and copy the signing secret into the host vault. A signed `team_id` must map to exactly one connected workspace. |
| Google Workspace | Create an OAuth client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials), enable only the Gmail/Drive/Docs/Sheets APIs you use, and add the Google callback. | `gmail.readonly`, `gmail.compose`, `drive.metadata.readonly`, `documents.readonly` or `documents`, `spreadsheets.readonly` or `spreadsheets`, selected by capability. | Gmail change signals use the plugin-wide Google Workspace webhook path and require a configured Gmail watch plus an OIDC-authenticated Pub/Sub push subscription with the exact configured audience and verified service-account email. A verified mailbox email must map to exactly one connected account. The host verifies the OIDC token against Google's published keys. Drive change signals use a connection-specific watch channel with a host-generated channel token. |
| Microsoft 365 | Register an app in [Microsoft Entra](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) and add the Microsoft callback. | Delegated `openid`, `profile`, `offline_access`, `User.Read`, plus only the selected `Mail.*`, `Files.*`, `ChannelMessage.*`, and `Team.ReadBasic.All` permissions. | Create/renew Microsoft Graph subscriptions pointing at the connection-specific Microsoft 365 webhook path. Keep the Graph `clientState` private. |
| GitHub | Create a [GitHub App](https://github.com/settings/apps/new), set its **Setup URL** to the GitHub callback and its signed webhook URL to the host's GitHub webhook endpoint, then install it only on selected repositories. | App permissions: Metadata read; Contents read/write only if required; Pull requests read/write; Issues read/write; webhook event subscription. | Subscribe only to `push`, `pull_request`, `issues`, `issue_comment`, `pull_request_review`, and `repository` as needed; store the webhook secret and App private key in the host vault. The standard adapter signs short-lived App JWTs from that key and is pinned to `api.github.com`; GitHub Enterprise needs a separately reviewed plugin. |

Useful provider guides: [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/),
[Google OAuth for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server),
[Microsoft identity platform authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow),
and [GitHub App creation](https://docs.github.com/apps/creating-github-apps/creating-github-apps/about-creating-github-apps).

The standard Microsoft connection creates Outlook and OneDrive subscriptions only for the
capabilities selected during Connect. A Teams inbound subscription is deliberately not inferred:
it needs an operator-selected concrete Graph resource such as one team/channel path, supplied by
a custom host extension. Merely granting Teams access never creates a broad tenant or all-channel
subscription.

### Curated provider actions

The plugins deliberately omit raw APIs and destructive administration:

- Slack: read a known thread; post a plain-text channel message or mention reply.
- Google Workspace: Gmail metadata search/draft/send; Drive metadata search; read/create/append
  Docs; read/create/append bounded Sheets ranges.
- Microsoft 365: read/draft/send Outlook mail; search/inspect/create bounded OneDrive text files;
  read/update bounded Excel ranges; list/post plain-text Teams channel messages. It uses delegated
  access only—no SharePoint or tenant-wide application permission surface.
- GitHub: installed-repository reads plus new branches, bounded text commits without force pushes
  or deletions, pull requests, issues, comments, reviews, and additive labels. It has no
  repository administration, membership, settings, deletion, or raw request action.

Creation and updates that affect an external provider are `external-write` actions and wait for
operator approval. A role must still be granted the specific action and data scope; connecting a
provider does not grant every agent access to it.

## Integration events and recovery

1. Connect an account from the private console. The browser returns to the fixed callback, which
   consumes its state exactly once.
2. Confirm the safe account label, consented scopes/capabilities, and subscription health in
   **Integrations → service → Connection**.
3. Inspect verified metadata-only receipts in **Activity → Integration events**. Create a rule
   under **Integrations → service → Event rules** only after
   adding the event name to the agent's `hooks` and its connection scope to the contract's read
   data authority.
4. A queued run is deduplicated by connection, provider event, and destination role. It runs
   asynchronously; a provider HTTP request never waits for a model turn.

The reference host keeps one active connection per provider. A successful reconnect holds a
durable provider-replacement claim and replaces every prior non-disconnected local connection
after attempting provider revocation, so its connection-specific role scopes and event routes
stay unambiguous even when two host processes receive callbacks at once. If subscription setup
fails, the attempted connection is revoked/cleared and the browser receives a failure page; the
previous usable connection remains in place. Schedules, subscription renewals, and heartbeats use
durable claims as well, so concurrent reference-host processes do not run the same trigger or
renewal.

For an expired consent, failed renewal, or revoked provider grant:

1. Disable the service's event rule under Integrations and pause any affected work.
2. Use **Disconnect** in the private console to remove encrypted local credentials and stop local
   subscriptions where the provider supports it.
3. Revoke the provider grant/app installation in the provider's own control plane. For GitHub,
   remove the App installation if it is no longer wanted; the reference host intentionally does
   not administer repositories or uninstall the App.
4. Fix the provider configuration, reconnect with a fresh browser flow, confirm the new
   connection ID/scopes, and explicitly recreate routes and role authority if appropriate.

Credential loss and a changed integration key are recovery events, not reasons to bypass OAuth.
Disconnect and reconnect; do not manually paste access or refresh tokens into Crewrun.

## Writing an integration plugin

Plugins declare `apiVersion: "crewrun.integration/v1"` through
`defineIntegrationPlugin(...)`. A manifest has a provider ID, safe label/description, optional
OAuth metadata, capability declarations, curated actions, optional event declarations, optional
subscription metadata, and an adapter. The host receives the private adapter hooks:

```js
adapter: {
  authorizationUrl, exchangeCode, refreshCredentials, identifyAccount,
  invoke, verifyWebhook, normalizeEvent, subscribe, renew, revoke
}
```

Implementation rules:

- Use one `<provider>.<camelCase>` action/event namespace and link every action/event to a
  declared capability.
- Give each action an input validator and a risk. `external-write` is always approval-required.
- Verify exact webhook bytes before parsing; enforce replay/signature/client-state checks;
  normalize to metadata-only events; never return a raw body, headers, OAuth token, API key, or
  private key.
- Keep connection persistence, token encryption, authorization-code state, subscription
  secrets, dedupe, queueing, and approval delivery in the host—not the plugin.
- Implement only narrow provider operations. A generic endpoint, arbitrary URL, raw JSON
  payload, arbitrary Graph/Slack/GitHub method, deletion, or administrative capability is outside
  this contract.
- Write unit tests for manifest validation, OAuth state/PKCE/replay behavior, webhook
  verification, event normalization/deduplication, subscription renewal, authority rechecks, and
  approval delivery. Live checks must be opt-in and use separately provisioned test accounts.

See [Host API reference](host-api-v1.md#integration-plugin-host-boundary) for the stable
boundary and [Integrations](integrations.md) for the installed plugin inventory.

## What this branch does not operate for you

- npm publication of the workspace packages;
- Funnel enablement or Tailscale policy changes;
- provider app registration, consent-screen verification, webhook subscription approval, or
  external provider fees/policies;
- cloud multi-tenant hosting, tenant-wide Microsoft permissions, SharePoint, destructive provider
  operations, or a generic MCP/provider proxy.

Those choices remain explicit operator actions because they define the trust boundary.
