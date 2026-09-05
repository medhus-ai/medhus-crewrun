const SLACK_CHANNEL = /^[CGD][A-Z0-9]{1,63}$/;
const SLACK_TIMESTAMP = /^\d{1,16}\.\d{1,9}$/;
const MAX_MESSAGE_LENGTH = 39_000;

// These descriptors intentionally expose only the two message shapes the reference Slack host
// needs. There is no generic Slack API action, raw request body, blocks, or token field for a
// role to use as an escape hatch.
export const slackConnectorActions = Object.freeze([
  Object.freeze({
    id: "slack.postMessage",
    provider: "slack",
    label: "Post Slack message",
    description: "Post plain text to a Slack channel. Delivery requires operator approval.",
    scopes: ["chat:write"],
    scopeSets: [["chat:write"]],
    risk: "external-write",
    approval: "required",
    inputSchema: (z) => ({ channel: z.string(), text: z.string() }),
    validate: validateSlackPostMessage
  }),
  Object.freeze({
    id: "slack.replyToMention",
    provider: "slack",
    label: "Reply to Slack mention",
    description: "Reply with plain text in the thread of an existing Slack app mention. Delivery requires operator approval.",
    scopes: ["chat:write", "app_mentions:read"],
    scopeSets: [["chat:write", "app_mentions:read"]],
    risk: "external-write",
    approval: "required",
    inputSchema: (z) => ({ channel: z.string(), threadTs: z.string(), text: z.string() }),
    validate: validateSlackReplyToMention
  })
]);

export function validateSlackPostMessage(input = {}) {
  const channel = slackChannel(input.channel);
  const text = slackText(input.text);
  if (!channel.ok) return channel;
  if (!text.ok) return text;
  return { ok: true, input: { channel: channel.value, text: text.value } };
}

export function validateSlackReplyToMention(input = {}) {
  const post = validateSlackPostMessage(input);
  if (!post.ok) return post;
  const threadTs = String(input.threadTs || "").trim();
  if (!SLACK_TIMESTAMP.test(threadTs)) {
    return { ok: false, error: "threadTs must be a Slack message timestamp" };
  }
  return { ok: true, input: { ...post.input, threadTs } };
}

function slackChannel(value) {
  const channel = String(value || "").trim();
  if (!SLACK_CHANNEL.test(channel)) {
    return { ok: false, error: "channel must be a Slack channel, group, or direct-message id" };
  }
  return { ok: true, value: channel };
}

function slackText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return { ok: false, error: "text is required" };
  if (text.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `text must not exceed ${MAX_MESSAGE_LENGTH} characters` };
  }
  return { ok: true, value: text };
}
