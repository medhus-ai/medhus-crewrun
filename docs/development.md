# Development

[Documentation](README.md) / Development

Use Node.js 20 or newer. SQLite is a runtime dependency; see
[native build requirements](security.md#installation) if installation needs a compiler.

```bash
npm install
npm test
npm run pack:check
```

The default suite covers runtime behavior, SQLite claims and recovery, console routes, and
mocked provider calls. `pack:check` dry-runs every publishable workspace package and confirms
that its explicit export, README, license, and notice artifacts are shippable. CI runs on Linux
with Node 20 and 24 and Windows with Node 20. Live-provider tests are opt-in.

## Live tests

These commands make real provider calls. Configure the corresponding credentials
or local vendor sign-in before using them:

```bash
CREW_LIVE_E2E=1 CREW_LIVE_CLAUDE=1 node --test test/live-e2e.test.js
CREW_LIVE_E2E=1 CREW_LIVE_CODEX=1 node --test test/live-e2e.test.js
CREW_LIVE_E2E=1 CREW_LIVE_WORKSPACE=1 CREW_LIVE_CODEX_WORKSPACE=1 node --test test/live-workspace-e2e.test.js
CREW_LIVE_E2E=1 CREW_LIVE_CLAUDE_SHELL=1 node --test test/live-shell-e2e.test.js
CREW_LIVE_E2E=1 CREW_LIVE_OPENROUTER=1 node --test test/live-e2e.test.js

# Requires a running reference host and its explicitly enabled HTTPS/Funnel endpoint.
CREW_LIVE_E2E=1 CREW_LIVE_SLACK=1 CREW_LIVE_INTEGRATIONS_URL=https://arsazmar0smars3.taila9c41d.ts.net node --test test/live-integration-e2e.test.js
CREW_LIVE_E2E=1 CREW_LIVE_GOOGLE=1 CREW_LIVE_MICROSOFT=1 CREW_LIVE_GITHUB=1 CREW_LIVE_FUNNEL=1 CREW_LIVE_INTEGRATIONS_URL=https://arsazmar0smars3.taila9c41d.ts.net node --test test/live-integration-e2e.test.js

# Add only short-lived credentials from separately provisioned test accounts to exercise
# authenticated, read-only provider checks. No live check performs a write.
CREW_LIVE_E2E=1 CREW_LIVE_SLACK=1 CREW_LIVE_SLACK_TOKEN=xoxb-test \
  CREW_LIVE_GOOGLE=1 CREW_LIVE_GOOGLE_ACCESS_TOKEN=google-test \
  CREW_LIVE_MICROSOFT=1 CREW_LIVE_MICROSOFT_ACCESS_TOKEN=microsoft-test \
  CREW_LIVE_GITHUB=1 CREW_LIVE_GITHUB_INSTALLATION_TOKEN=github-test \
  node --test test/live-integration-e2e.test.js
```

OpenRouter uses `OPENROUTER_API_KEY`; `CREW_LIVE_OPENROUTER_MODEL` selects its model.
Claude and Codex subscription checks use
the local signed-in client rather than an ambient API key.

Shell live checks use an eligible Claude subscription (`opus` by default;
`CREW_LIVE_CLAUDE_SHELL_MODEL` overrides it). They create disposable workspaces and write
only temporary probe files: one native auto-mode command, then a forced native permission
prompt followed by a one-time owner-approved retry. The forced prompt tests the real SDK
approval bridge, not the classifier's ability to recognize every unsafe command. No existing
agent is granted shell access. Codex shell review integration is not implemented; ordinary
governed Codex live/boundary checks remain separate.

The integration checks are live boundary probes, not unattended browser-consent workflow tests:
they make an invalid, one-time callback request to each selected provider route, proving the
HTTPS/Funnel-to-loopback boundary reaches CrewRun without exchanging a code. When the corresponding
`CREW_LIVE_*_TOKEN` value is supplied, they also make one authenticated, read-only provider request
with a separate test account. They never perform a provider write. Exercise a real consent,
subscription, webhook, and approved-write workflow only with separately provisioned test accounts
and an explicit operator review.

## Examples and contributions

Use `crewrun init` and the bundled host for a disposable example, or see
[library startup](library.md). Keep domain-specific procedures in workspace
knowledge and skills; provider behavior belongs in integration plugins.

This branch is v6-only. Update tests and [migration notes](v6-migration.md) for
intentional compatibility breaks; keep existing state and archives untouched.
