# CrewRun GitHub integration plugin

A repository-scoped GitHub App adapter for a governed CrewRun host. It provides installation
setup, signed webhooks, and curated repository reads plus approval-gated branches, bounded commits,
pull requests, issues, reviews, comments, and additive labels. It has no personal-access-token,
delete, force-push, membership, settings, or administration operation.

The host supplies `appId`, `appSlug`, `webhookSecret`, and either `privateKey` or
`privateKeyBase64`. The adapter can create its own short-lived RS256 App JWT from that private key;
a vault or HSM host may instead provide `signAppJwt` programmatically. Installation tokens never
leave the adapter.

Deployment and role-authority guidance: [Hosted integration reference host](https://github.com/medhus-ai/medhus-crewrun/blob/main/docs/reference-host.md).
