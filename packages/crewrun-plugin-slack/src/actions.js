// The plugin requests only public-channel history. Accepting G-prefixed private-channel IDs
// would create a misleading tool that cannot work with the consent it deliberately requests.
const CHANNEL_ID = /^C[A-Z0-9]{1,63}$/;
const TIMESTAMP = /^\d{1,16}\.\d{1,9}$/;
const MAX_TEXT_LENGTH = 39_000;

// Each descriptor is intentionally a small, reviewable Slack operation. There is no generic
// Web API escape hatch, block-kit input, arbitrary endpoint, or caller-provided token.
export const slackActions = Object.freeze([
  Object.freeze({
    id: "slack.getThread",
    capability: "messages",
    label: "Read Slack thread",
    description: "Read one channel thread by opaque channel and message timestamp.",
    risk: "read",
    scopes: ["channels:history"],
    scopeSets: [["channels:history"]],
    inputSchema: (z) => ({ channel: z.string(), threadTs: z.string(), maxMessages: z.number().int().min(1).max(100).optional() }),
    validate: validateSlackGetThread
  }),
  Object.freeze({
    id: "slack.postMessage",
    capability: "messages",
    label: "Post Slack message",
    description: "Post plain text to one Slack channel. Delivery requires host approval.",
    risk: "external-write",
    approval: "required",
    scopes: ["chat:write"],
    inputSchema: (z) => ({ channel: z.string(), text: z.string() }),
    validate: validateSlackPostMessage
  }),
  Object.freeze({
    id: "slack.replyToMention",
    capability: "mentions",
    label: "Reply to Slack mention",
    description: "Reply with plain text in a known Slack thread. Delivery requires host approval.",
    risk: "external-write",
    approval: "required",
    scopes: ["chat:write", "app_mentions:read"],
    inputSchema: (z) => ({ channel: z.string(), threadTs: z.string(), text: z.string() }),
    validate: validateSlackReplyToMention
  })
]);

export function validateSlackGetThread(input = {}) {
  const channel = slackChannel(input.channel);
  if (!channel.ok) return channel;
  const threadTs = slackTimestamp(input.threadTs, "threadTs");
  if (!threadTs.ok) return threadTs;
  const maxMessages = input.maxMessages == null ? 25 : Number(input.maxMessages);
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) {
    return { ok: false, error: "maxMessages must be an integer from 1 through 100" };
  }
  return { ok: true, input: { channel: channel.value, threadTs: threadTs.value, maxMessages } };
}

export function validateSlackPostMessage(input = {}) {
  const channel = slackChannel(input.channel);
  if (!channel.ok) return channel;
  const text = slackText(input.text);
  return text.ok ? { ok: true, input: { channel: channel.value, text: text.value } } : text;
}

export function validateSlackReplyToMention(input = {}) {
  const post = validateSlackPostMessage(input);
  if (!post.ok) return post;
  const threadTs = slackTimestamp(input.threadTs, "threadTs");
  return threadTs.ok ? { ok: true, input: { ...post.input, threadTs: threadTs.value } } : threadTs;
}

function slackChannel(value) {
  const channel = String(value || "").trim();
  return CHANNEL_ID.test(channel)
    ? { ok: true, value: channel }
    : { ok: false, error: "channel must be a public Slack channel id" };
}

function slackTimestamp(value, name) {
  const timestamp = String(value || "").trim();
  return TIMESTAMP.test(timestamp)
    ? { ok: true, value: timestamp }
    : { ok: false, error: `${name} must be a Slack message timestamp` };
}

function slackText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return { ok: false, error: "text is required" };
  if (text.length > MAX_TEXT_LENGTH) return { ok: false, error: `text must not exceed ${MAX_TEXT_LENGTH} characters` };
  return { ok: true, value: text };
}
