# CrewRun Google Workspace integration plugin

A governed Gmail, Drive, Docs, and Sheets adapter for a CrewRun integration host. Reads are
narrow and writes are curated, approval-gated operations; it does not expose a generic Google API.

The reference host supplies private OAuth client values and optional Gmail Pub/Sub configuration:
`gmailPubsubTopic`, the exact `gmailPushAudience`, and the exact
`gmailPushServiceAccount`. Gmail push OIDC tokens are verified against Google's published signing
keys by default; their verified `email` claim must match that configured service account, and the
signed mailbox email must resolve to one connected account. A custom verifier is only for a host
with an explicit specialized trust policy. Drive watch channel secrets remain encrypted in host
state.

Deployment and role-authority guidance: [Hosted integration reference host](https://github.com/medhus-ai/medhus-crewrun/blob/main/docs/reference-host.md).
