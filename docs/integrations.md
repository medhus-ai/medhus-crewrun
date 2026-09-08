# Integrations

CrewRun's bundled host uses installable plugins for Slack, Google Workspace,
Microsoft 365, and GitHub. Configure your provider application in the host service,
then use **Integrations → Connect** to select capabilities and complete browser consent.
Disconnect revokes authorization where supported and clears the local credentials.

Tokens remain in encrypted host state. Agents see curated tools and safe connection
metadata, never raw provider APIs or credentials. External writes enter Reviews;
the delivery worker rechecks authority and connection revision before sending.

A connection alone starts no automation. Enable a permitted event rule explicitly.
Verified but unrouted events appear in **Activity → Events**. Rules belong in
Integrations; tasks created by authorized routes appear in Tasks.

See [provider setup, callbacks and plugin authoring](reference-host.md) for exact
scopes, provider limitations, renewal, and explicit HTTPS/Funnel setup.
Manual token forms, the old direct Slack/Gmail adapter, and placeholder Calendar/
WhatsApp gateway cards have been removed. Calendar UI currently projects CrewRun
scheduled tasks; it does not imply an installed calendar-sync plugin.
