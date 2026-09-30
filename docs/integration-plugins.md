# Self-hosted integration plugins

CrewRun connects directly to provider APIs. There is no shared CrewRun OAuth service, managed
connector broker, or imported Hermes/OpenClaw runtime. One workspace has one owner and one current
account per provider (a Slack workspace or a GitHub App installation counts as that account).

Self-hosting is the current release direction. An optional managed **Easy Connect** service
is recorded only as a [future direction](product-direction.md#integration-hosting-direction);
it is not available or required for this setup.

## Connect a service

1. Follow the [recommended Tailscale HTTPS setup](tailscale-setup.md), also shown inside each
   integration’s setup page. Configure `CREWRUN_PUBLIC_BASE_URL` as the operator-owned HTTPS origin and restart the host.
   Publish only the loopback callback listener; keep the console private. See
   [reference-host deployment](reference-host.md#public-endpoint-and-ingress).
2. Open **Integrations → Set up**. The plugin supplies app-registration instructions, exact
   callback/webhook URLs and its required configuration fields. Register the provider app yourself.
3. Save its app configuration in the private form. Values are encrypted in the existing host
   SQLite vault; saved values are never returned to the UI, chat, MCP, or workspace files.
   Blank fields keep saved values. Environment configuration takes precedence and is marked locked.
4. Select only the capabilities needed and click **Connect**. Complete provider consent, then
   return to the private console and reload. Use **Check account** for a current identity/token check.
5. Configure event delivery separately. Google/Microsoft expose **Set up event delivery** when
   the selected capabilities have events. Slack/GitHub webhooks are enabled in the provider app.
   Check subscription health separately from account health.
6. Add an event rule and explicitly enable it only after giving the agent the event hook, tool
   permissions and connection data scope. Receiving a verified event alone does not run an agent.

**Reconnect** replaces the current account and retires its local credentials. It also lets you
change consent. Old connection-specific rules and pending write approvals do not silently move to
the replacement account. App credentials can only be edited after disconnecting. Changing them
invalidates pending consent callbacks; app setup and OAuth replacement share a durable provider lock.

Disconnect clears local connection tokens even if remote revocation fails. In that case, revoke
the grant in the provider's settings too. GitHub disconnect does not uninstall the App or change
repository administration; uninstall or revoke it yourself if desired. App-registration credentials
remain encrypted for the next connection. Back up private host state and its encryption key together.

An interrupted/failed event setup may have created subscriptions remotely. CrewRun records the
attempt, leaves ordinary account access connected, and blocks another setup attempt. Reconcile
provider subscriptions before disconnecting and reconnecting. No universal exactly-once provider
delivery is promised. Account checks are point-in-time checks, not proof that every API capability
or webhook is healthy.

## Current capabilities

| Plugin | Curated tools | Events and limits |
|---|---|---|
| Slack | Read threads; post messages and replies | Signed public-channel messages and app mentions; app/workspace membership still matters |
| Google Workspace | Gmail metadata, drafts/send; Drive metadata; Docs read/create/append; Sheets read/create/append | Gmail mailbox signals require authenticated Pub/Sub; Drive change signals require a watch. No Google Calendar or arbitrary Drive uploads |
| Microsoft 365 | Outlook read/draft/send; OneDrive metadata/create text; Excel read/update ranges; Teams read/post channel messages | Delegated permissions only. Teams requires work/school access; account/workbook and tenant policy limit Excel/Teams availability. No SharePoint, application-wide admin scopes, or calendar |
| GitHub | Repository/file reads, branches, bounded text commits, PRs, issues, reviews, comments, additive labels | Signed repository events for a selected-repository App installation; no PAT, delete, force-push, membership or repository administration |

Every external write remains approval-gated and authority is rechecked at delivery.
The connection page derives its detailed tool inventory from the installed manifest.

## Develop a plugin

From a released installation, or using `node bin/crewrun.js` in this checkout:

```bash
crewrun plugins create ./my-plugin --id example
cd my-plugin
npm install
npm test
```

The small generated package includes an ESM default export, a read-only example tool, and a
contract test. The SDK must be available from npm or your local workspace; these commands do not
publish unreleased packages. For local development against this checkout, install the SDK directory
explicitly instead of assuming the v0.6 package has been published.

Use `defineIntegrationPlugin` from `@medhus-ai/crewrun-plugin-sdk` with
`apiVersion: "crewrun.integration/v1"`:

- `capabilities`: user-facing permissions and provider scopes.
- `actions`: named, bounded tools with `inputSchema`, safe `validate` projection, capability,
  risk and scopes. External writes always require approval. No raw provider request tool.
- `events`: declared event types, capability, verification delivery type and retention policy.
- `setup`: HTTPS `docsUrl`, instructions, and fields containing `key`, `label`, `type`
  (`text`, `secret`, `pem`), `required` and optional help. These are descriptions, never values.
  Optional `alternatives` names allow an operator-owned environment/vault source.
- `oauth`: fixed authorization/token endpoints, PKCE mode and scope formatting.
- `adapter`: authorization URL, code exchange, account identity, credential refresh, tool
  invocation, webhook verification/normalization, subscription creation/renewal and revocation.
  These hooks receive private credentials only inside the host.

Use the four bundled plugins as working examples. Pin provider hosts before sending credentials;
verify signed webhook bytes before normalization; project results to safe fields. The host owns
encryption, state replay protection, dedupe, routing, authority and approval delivery.

`assertIntegrationPluginContract(plugin, fixtures)` checks valid/invalid input fixtures, manifest
validation, required write approvals and public adapter stripping. Supply fixtures for every action.
Also test provider protocols with injected fetch mocks, credential redaction and failure/recovery.
The harness is not a security audit and cannot prove a plugin implementation safe.

## Install reviewed host code

```bash
crewrun plugins install @your-org/crewrun-plugin-example@1.2.3 --trust
# Or snapshot a local package:
crewrun plugins install ./my-plugin --trust
crewrun plugins list
```

Only exact npm versions and explicit local paths are accepted. npm lifecycle scripts are disabled.
The private installation includes a lockfile and a digest of the package/dependency tree. Local
packages are packed, not linked to mutable workspace code. The host verifies the digest before
loading the default export; tampering fails startup. Plugins cannot replace bundled provider IDs.

**Trust matters:** importing a plugin executes JavaScript with host privileges, including access
to private credentials. Pinning and integrity checks are not sandboxing. Review its code and
dependencies before `--trust`. Plugins are never installed by an agent or the setup helper.
Agent authority and event routes remain unchanged by installation.

Installed packages and the active inventory live in `CREW_HOME/plugins`, outside workspace
configuration. They apply to hosts launched with that private home, not to an agent's repo.
Restart the host to load an installation. `crewrun up`, `crewrun console`, and
`crewrun agents check` use the same inventory. Programmatic callers can use
`loadReferencePlugins(env)` and pass its result into `createHost({ plugins, ... })`;
`startReferenceHost` does this by default.

Replacement keeps older private snapshots for manual rollback; it does not migrate connections
or permissions automatically. Stop the host before restoring a reviewed previous inventory/snapshot.
If an installer crashes, check that it is no longer running before removing only
`CREW_HOME/plugins/.install-lock`. Do not delete the host home or its state to resolve a lock.

## Verification and operator rollout

Offline tests cover setup secrecy/persistence, CSRF, required fields, environment ownership,
OAuth cancellation/replay/replacement, failed event setup, account checks, local installation,
script suppression, tamper detection, and existing provider/governance boundaries.

Before production, use separate test accounts to complete consent and cancellation in a browser
for all four providers. Verify selected scopes, reconnect, one allowed read, one reviewed write,
signed inbound delivery, disabled-route inertness, renewal and disconnect. This requires registered
apps and reachable ingress; mocked tests are not a substitute.

Existing opt-in tests in `test/live-integration-e2e.test.js` probe real provider identity/read
access and Funnel callbacks, not full interactive consent or approved-write workflows. Their
`CREW_LIVE_*` flags must be set explicitly. Claude, Codex, OpenRouter and isolation tests remain
separate. No publishing, provider registration, real-account writes or Funnel activation occurs
as part of the normal suite.
