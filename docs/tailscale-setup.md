# Tailscale HTTPS setup

Tailscale Funnel is CrewRun’s recommended default for self-hosted integration HTTPS.
The same guide is available inside **Integrations → Set up → Tailscale HTTPS**.
“Default” means the recommended setup path, not automatic public exposure.
An existing HTTPS reverse proxy remains supported.

## What becomes public

Only the dedicated callback listener, normally `127.0.0.1:4411`, is published.
It accepts provider OAuth callbacks and verified webhooks; it does not serve the dashboard,
credentials, approvals, tasks, chats or workspace files. Both local listeners stay on loopback.
Anyone can reach the public listener, so OAuth state and provider verification remain essential.
Publishing callbacks does not enable event routes or authorize agent actions.

## Set up once per host

1. [Install Tailscale](https://tailscale.com/download) on the host running CrewRun and sign in.
   Enable MagicDNS, HTTPS certificates and the appropriate Funnel permission in your tailnet.
   Use your own account and device hostname; no CrewRun-owned Tailscale account is involved.
2. Find the host’s full `machine.tailnet.ts.net` name in Tailscale.
3. Set the following in the environment that actually launches CrewRun. For a managed service,
   use its environment file, then restart that service; exporting in a separate terminal does
   not update an already running service.

   ```text
   CREWRUN_PUBLIC_BASE_URL=https://YOUR-MACHINE.YOUR-TAILNET.ts.net
   CREWRUN_INTEGRATIONS_HOST=127.0.0.1
   CREWRUN_INTEGRATIONS_PORT=4411
   ```

4. Start/restart CrewRun. Keep its console on localhost. Inspect existing Tailscale mappings:

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

5. If public HTTPS port 443 is unused, explicitly publish the callback listener:

   ```bash
   tailscale funnel --bg --https=443 http://127.0.0.1:4411
   tailscale funnel status
   ```

   Complete any permission prompt. `--bg` keeps the mapping in Tailscale’s background
   configuration. Match the target to your configured integration port, not the dashboard port.
   Do not reset existing Serve/Funnel configuration to resolve a conflict. If using another
   supported external HTTPS port, include it in the configured public origin and provider URLs.

   If Linux reports `Access denied: serve config denied`, an administrator can run the same
   scoped command with `sudo`. Enter the password only in your terminal, never in CrewRun/chat.
   Do not grant the CrewRun service broad passwordless sudo or Tailscale operator privileges.
   Disabling the mapping may likewise require `sudo`.

6. Open **Integrations → Set up**. It displays the exact URLs for this host and provider:

   ```text
   https://YOUR-MACHINE.YOUR-TAILNET.ts.net/integrations/oauth/slack/callback
   https://YOUR-MACHINE.YOUR-TAILNET.ts.net/integrations/webhooks/slack
   ```

   Register the app, save credentials privately, choose capabilities and connect.
   Test provider event delivery separately before explicitly enabling any event rules.

## Verify the boundary

From a device outside your tailnet, check that HTTPS reaches the callback listener:

- `/`, `/integrations`, `/reviews` and `/settings` should return 404, never console HTML.
- An OAuth callback with missing/invalid state should return 400.
- An unsigned webhook should be rejected.
- Provider consent and signed events still need their own live tests; an HTTP response alone
  does not prove a provider integration is working.

Never route Funnel to the console (normally 4400; the Medhus deployment uses 4402).
Tailscale Serve is private to the tailnet, but the current console rejects non-local browser
origins. Keep using localhost or an SSH local port forward until explicit trusted-proxy/origin
support is configured. Do not disable CSRF checks. Never share the same external port between
a private Serve console and public Funnel.

## Stop exposure and recover

After confirming HTTPS 443 still belongs exclusively to this CrewRun callback mapping:

```bash
tailscale funnel --https=443 off
tailscale funnel status
```

This stops public access, not the local host or existing provider grants. Disable event routes
and disconnect/revoke accounts separately when retiring integrations. If the hostname changes,
update the service origin and registered provider callback URLs before reconnecting.

For an existing reverse proxy, preserve the same separation: public HTTPS routes to the
callback listener only, not the console. Keep the host and Tailscale updated; monitor failed
requests and apply ingress rate/time limits appropriate to the deployment.

Official references: [Funnel prerequisites](https://tailscale.com/docs/features/tailscale-funnel),
[Funnel commands](https://tailscale.com/docs/reference/tailscale-cli/funnel).
