# CrewRun Microsoft 365 integration plugin

A delegated-permission Microsoft Graph adapter for Outlook, OneDrive, Excel, and Teams. It uses
curated reads and approval-gated writes only; it excludes SharePoint, tenant-wide application
permissions, administration, and raw Graph requests.

The host supplies private `clientId` and optional `clientSecret` values. Graph subscription
`clientState` values are generated per subscription, encrypted by the host, and checked before a
notification reaches the Event Inbox.

Deployment and role-authority guidance: [Hosted integration reference host](https://github.com/medhus-ai/medhus-crewrun/blob/main/docs/reference-host.md).
