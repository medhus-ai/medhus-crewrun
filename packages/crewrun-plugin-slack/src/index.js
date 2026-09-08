import { defineIntegrationPlugin } from "@medhus-ai/crewrun-plugin-sdk";

import { slackActions } from "./actions.js";
import { createSlackAdapter, slackOAuth } from "./adapter.js";
import { normalizeSlackEvent, slackEvents, slackSubscription, slackWebhookResponse, verifySlackWebhook } from "./events.js";

export { slackActions, validateSlackGetThread, validateSlackPostMessage, validateSlackReplyToMention } from "./actions.js";
export { createSlackAdapter, slackOAuth } from "./adapter.js";
export { normalizeSlackEvent, slackEvents, slackSubscription, slackWebhookResponse, verifySlackWebhook } from "./events.js";

export function createSlackPlugin(options = {}) {
  const adapter = createSlackAdapter(options);
  return defineIntegrationPlugin({
    id: "slack",
    label: "Slack",
    description: "Governed Slack messages and signed Events API deliveries.",
    oauth: slackOAuth,
    capabilities: [
      { id: "messages", label: "Channel messages", description: "Read a permitted channel thread and post plain-text messages.", direction: "both", scopes: ["channels:history", "chat:write"] },
      { id: "mentions", label: "App mentions", description: "Receive signed app mentions and reply in their thread.", direction: "both", scopes: ["app_mentions:read", "chat:write"] }
    ],
    actions: slackActions,
    events: slackEvents,
    subscription: slackSubscription,
    adapter: {
      ...adapter,
      verifyWebhook: (request = {}) => slackWebhookResult({
        ...request,
        signingSecret: options.signingSecret ?? request.signingSecret ?? request.config?.signingSecret
      }),
      normalizeEvent: normalizeSlackEvent
    }
  });
}

// A manifest can be inspected without credentials. A host may supply a signing secret at plugin
// construction time, or pass it as private runtime context to verifyWebhook.
export const slackPlugin = createSlackPlugin();

function slackWebhookResult(request) {
  const verified = verifySlackWebhook(request);
  if (!verified.ok) return { ...verified, status: 401, events: [] };
  const handshake = slackWebhookResponse(request.rawBody);
  if (!handshake.ok) return { ...handshake, status: 400, events: [] };
  if (handshake.response) {
    return { ok: true, challenge: handshake.response.body, contentType: handshake.response.contentType, events: [] };
  }
  const event = normalizeSlackEvent({ rawBody: request.rawBody, connectionId: request.connectionId, receivedAt: new Date().toISOString() });
  return {
    ok: true,
    events: event ? [{
      ...(event.connectionId ? { connectionId: event.connectionId } : {}),
      ...(event.accountId ? { accountId: event.accountId } : {}),
      providerEventId: event.id,
      type: event.type,
      resource: event.subject || {},
      summary: event.metadata || {},
      occurredAt: event.occurredAt
    }] : []
  };
}
