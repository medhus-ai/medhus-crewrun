import { defineIntegrationPlugin } from "@medhus-ai/crewrun-plugin-sdk";

import { googleWorkspaceActions } from "./actions.js";
import { createGoogleWorkspaceAdapter, googleWorkspaceOAuth } from "./adapter.js";
import { createGoogleOidcVerifier, verifyGoogleOidcToken } from "./oidc.js";
import {
  googleWorkspaceEvents,
  googleWorkspaceSubscription,
  normalizeGoogleWorkspaceEvent,
  verifyGoogleWorkspaceWebhook
} from "./events.js";

export {
  googleWorkspaceActions,
  validateDocumentAppend,
  validateMailDraft,
  validateSearchDrive,
  validateSearchMail,
  validateSheetAppend,
  validateSheetRange,
  validateTitle
} from "./actions.js";
export { createGoogleWorkspaceAdapter, googleWorkspaceOAuth } from "./adapter.js";
export { createGoogleOidcVerifier, GOOGLE_OIDC_ISSUERS, GOOGLE_OIDC_JWKS_URL, verifyGoogleOidcToken } from "./oidc.js";
export {
  googleWorkspaceEvents,
  googleWorkspaceSubscription,
  normalizeGoogleWorkspaceEvent,
  verifyDriveChannelWebhook,
  verifyGmailPubSubWebhook,
  verifyGoogleWorkspaceWebhook
} from "./events.js";

export function createGoogleWorkspacePlugin(options = {}) {
  const adapter = createGoogleWorkspaceAdapter(options);
  const builtInOidcVerifier = typeof options.oidcVerifier === "function"
    ? options.oidcVerifier
    : createGoogleOidcVerifier({
      fetch: options.fetch,
      now: options.now,
      jwksUrl: options.jwksUrl,
      issuers: options.issuers,
      cacheTtlMs: options.oidcCacheTtlMs,
      maxCacheTtlMs: options.oidcMaxCacheTtlMs,
      clockSkewSeconds: options.oidcClockSkewSeconds,
      maxTokenLifetimeSeconds: options.oidcMaxTokenLifetimeSeconds
    });
  return defineIntegrationPlugin({
    id: "google-workspace",
    label: "Google Workspace",
    setup: {
      docsUrl: "https://console.cloud.google.com/apis/credentials",
      instructions: "Create a Web application OAuth client and add the callback URL. Configure the consent screen and test users, then enable Gmail, Drive, Docs and Sheets APIs as needed. Gmail events additionally require authenticated Pub/Sub push setup. Calendar is not included in this plugin.",
      fields: [
        {"key":"clientId","label":"Client ID","type":"text","required":true},
        {"key":"clientSecret","label":"Client secret","type":"secret","required":true},
        {"key":"gmailPubsubTopic","label":"Gmail Pub/Sub topic","type":"text","help":"Optional: projects/PROJECT/topics/TOPIC; grant Gmail permission to publish."},
        {"key":"gmailPushAudience","label":"Gmail push audience","type":"text","help":"Optional: audience configured for authenticated Pub/Sub push."},
        {"key":"gmailPushServiceAccount","label":"Gmail push service account","type":"text","help":"Optional: service account email used to authenticate Pub/Sub push, not a second connected user."}
      ]
    },
    description: "Governed Gmail, Drive, Docs, and Sheets capabilities with verified mail and file-change signals.",
    oauth: googleWorkspaceOAuth,
    capabilities: [
      { id: "gmail-read", label: "Read Gmail metadata", description: "Search mail metadata and receive mailbox-history signals.", direction: "read", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
      { id: "gmail-send", label: "Draft and send Gmail", description: "Create plain-text drafts and deliver approved drafts.", direction: "write", scopes: ["https://www.googleapis.com/auth/gmail.compose"] },
      { id: "drive", label: "Google Drive metadata", description: "Search Drive metadata and receive Drive change-channel signals.", direction: "read", scopes: ["https://www.googleapis.com/auth/drive.metadata.readonly"] },
      { id: "docs-read", label: "Read Google Docs", description: "Read the text of known Google Docs.", direction: "read", scopes: ["https://www.googleapis.com/auth/documents.readonly"] },
      { id: "docs-write", label: "Create and append Google Docs", description: "Create Docs and append plain text through approval-gated actions.", direction: "write", scopes: ["https://www.googleapis.com/auth/documents"] },
      { id: "sheets-read", label: "Read Google Sheets", description: "Read known A1 ranges from Google Sheets.", direction: "read", scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] },
      { id: "sheets-write", label: "Create and append Google Sheets", description: "Create Sheets and append rows through approval-gated actions.", direction: "write", scopes: ["https://www.googleapis.com/auth/spreadsheets"] }
    ],
    actions: googleWorkspaceActions,
    events: googleWorkspaceEvents,
    subscription: googleWorkspaceSubscription,
    adapter: {
      ...adapter,
      verifyWebhook: async (request = {}) => {
        const config = { ...(options.config || {}), ...(request.config || {}) };
        // A programmatic config verifier intentionally wins over the built-in verifier. Normal
        // JSON/env configuration has no function here, so it uses the request-aware default.
        const configuredVerifier = typeof config.verifyOidcToken === "function"
          ? config.verifyOidcToken
          : typeof options.verifyOidcToken === "function"
            ? options.verifyOidcToken
            : typeof request.verifyOidcToken === "function"
              ? request.verifyOidcToken
            : ({ token, audience, serviceAccountEmail }) => builtInOidcVerifier({ token, audience, serviceAccountEmail, fetch: request.fetch });
        return googleWorkspaceWebhookResult(await verifyGoogleWorkspaceWebhook({
          ...request,
          audience: options.audience ?? request.audience,
          verifyOidcToken: configuredVerifier,
          config
        }));
      },
      normalizeEvent: normalizeGoogleWorkspaceEvent
    }
  });
}

// Credential-free, inspectable manifest. The reference host provides OAuth application values,
// encrypted-vault handling, public callback context, and OIDC verification at runtime.
export const googleWorkspacePlugin = createGoogleWorkspacePlugin();

function googleWorkspaceWebhookResult(verified) {
  if (!verified?.ok) return { ...(verified || {}), status: Number(verified?.status) || 401, events: [] };
  const delivery = verified.delivery;
  if (!delivery) return { ok: true, events: [] };
  const event = delivery.connectionId ? normalizeGoogleWorkspaceEvent(delivery) : null;
  if (delivery.kind === "gmail-pubsub") {
    return {
      ok: true,
      events: [{
        ...(event?.connectionId ? { connectionId: event.connectionId } : {}),
        accountId: delivery.emailAddress,
        providerEventId: event?.id || `gmail:${delivery.messageId}`,
        type: "google-workspace.gmailMailboxChanged",
        resource: event?.subject || { id: delivery.emailAddress, label: "Gmail mailbox" },
        summary: event?.metadata || { historyId: delivery.historyId, emailAddress: delivery.emailAddress },
        occurredAt: event?.occurredAt || delivery.publishedAt
      }]
    };
  }
  if (delivery.kind === "drive-channel" && event) {
    return {
      ok: true,
      events: [{
        connectionId: event.connectionId,
        providerEventId: event.id,
        type: event.type,
        resource: event.subject || {},
        summary: event.metadata || {},
        occurredAt: event.occurredAt
      }]
    };
  }
  return { ok: true, events: [] };
}
