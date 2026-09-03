# Slack reference host

This is a small Slack Events API gateway for a crewrun project. It accepts only signed
`app_mention` events from explicitly configured Slack user IDs, acknowledges Slack before a
role turn begins, and posts the result back into the mentioning thread with `chat.postMessage`.

It is a host example, not a new runtime or an authentication layer. The role's usual runner
profile still decides whether its turn uses a vendor subscription, an API key, OpenRouter, or a
local provider.

> **Subscription boundary.** An operator may use their own local Claude or ChatGPT/Codex
> subscription for their own Slack gateway, just as they can for a local terminal turn. A
> hosted or multi-user Slack product using Claude must use API keys or a supported cloud provider
> for those users; it must not offer or route Claude.ai subscription credentials on their behalf.

## Run it

The target project must already contain its normal `.crew/roles/<role>.md` and
`.crew/memory/ai-runners.json` files, plus a v1 role contract that grants
`slack.replyToMention` and the relevant channel scope (for example
`connector:slack:*`). Configure the Slack gateway with Slack IDs, not display names:

```json
{
  "contract": {
    "version": 1,
    "revision": 1,
    "mandate": "Answer approved Slack mentions in the support channel.",
    "authority": {
      "tools": [{ "name": "slack.replyToMention", "impact": "external-write" }],
      "data": { "write": ["connector:slack:c012abcde"] }
    }
  }
}
```

Use the actual Slack channel ID in lowercase (`C012ABCDE` becomes `c012abcde`), or use
`connector:slack:*` only when that role is deliberately allowed to reply in every channel.

```bash
export CREW_SLACK_SIGNING_SECRET='…'       # Slack app: Basic Information → Signing Secret
export CREW_SLACK_BOT_TOKEN='xoxb-…'       # installed app OAuth token
export CREW_SLACK_TARGET_ROOT=/path/to/project
export CREW_SLACK_ROLE=analyst
export CREW_SLACK_ALLOWED_USERS=U012ABCDEF,U045GHIJKL
# Explicitly choose the reference policy: each valid mention from an allowed user
# authorizes one reply in the same thread. Replace with a queue for per-reply review.
export CREW_SLACK_APPROVE_MENTION_REPLIES=1

node examples/slack/server.mjs
```

It listens at `http://127.0.0.1:3000/slack/events` by default. Set `CREW_SLACK_PORT` or
`CREW_SLACK_BIND` when needed. Slack needs a public HTTPS URL, so put a TLS reverse proxy or
tunnel in front of this local listener; configure its Request URL as
`https://your-host/slack/events`.

The durable duplicate-event state defaults to `<crew home>/slack/event-ids.json` (normally
`~/.crew/slack/event-ids.json`); set `CREW_SLACK_DEDUPE_FILE` to place it elsewhere. This file
contains event IDs and timestamps, not Slack or model credentials. It is a single-gateway-process
store; for horizontal scaling, put one gateway at ingress or replace it with a shared atomic
event queue/deduper.

In the Slack app configuration:

1. Enable Event Subscriptions and enter the Request URL. Slack's signed `url_verification`
   challenge is handled automatically.
2. Subscribe to the bot event `app_mention`.
3. Give the bot `app_mentions:read` and `chat:write`, reinstall the app, and invite it to each
   channel where it should respond.

The example requires an explicit allowed-user list. A valid event from anyone not in that list
is acknowledged so Slack does not retry it, but no model turn or Slack reply is started.

## What happens per mention

```text
Slack → signature + replay check → configured user check → event-id dedupe
      → immediate 200 acknowledgement → asynchronous role turn → host reply policy
      → chat.postMessage in thread
```

The HTTP path never waits for the model. It only performs HMAC verification, JSON parsing,
authorization, and event-id recording before returning its acknowledgement. Duplicated event IDs
are acknowledged without another role turn. Bot-authored events are ignored.

## Reply approval policy

Posting a model response is an external write. `createSlackHost` therefore requires an
`approveReply` callback. The supplied `server.mjs` makes one intentionally narrow policy choice:
a signed mention from an explicitly allowed Slack ID approves one reply in that same thread, and
only when `CREW_SLACK_APPROVE_MENTION_REPLIES=1` confirms that choice. A host that needs a human
decision per response should put an approval record in its own queue and return an approved result
only when it is ready to deliver the saved reply.

The reference `server.mjs` also loads the role’s contract with `requireContracts: true`. Before
each post it checks `slack.replyToMention` and the `connector:slack:<channel-id>` write scope,
then writes a redacted local audit record. The record carries the role, action, authority revision,
approval, and outcome; it hashes the reply instead of retaining its text. A role without that
contract is allowed to receive the inbound mention but cannot send a reply.

## Minimal host API

`host.mjs` has no dependencies beyond Node core modules and Node 20's global `fetch`:

```js
import { createSlackHost } from "./host.mjs";

const gateway = createSlackHost({
  signingSecret: process.env.CREW_SLACK_SIGNING_SECRET,
  botToken: process.env.CREW_SLACK_BOT_TOKEN,
  users: {
    U012ABCDEF: { targetRoot: "/srv/project", role: "analyst" }
  },
  approveReply: ({ eventId, userId }) => ({ id: `slack-event:${eventId}`, status: "approved", approved_by: `slack-mention:${userId}` }),
  runTurn: async ({ text, user }) => ({ text: await runYourRole(text, user) })
});

gateway.listen({ port: 3000 });
```

`runTurn` receives `{ event, envelope, user, userId, text, channel, threadTs, eventId }` and
returns a reply string or `{ text }`. For dynamic authorization, replace `users` with
`resolveUser({ event, envelope, userId })`; return a user config object to allow a caller, or
`null` to reject it. `postMessage`, `dedupe`, `schedule`, and `fetch` (through
`createSlackPoster`) are injectable for tests or a different host transport. `approveReply`
receives the role, action id, exact reply input, Slack event id, and authorized user; return
`true`, `{ allowed: true }`, or `{ status: "approved" }` to permit that one delivery.

`crewrun-adapter.mjs` wires that small contract into an existing role runner:

```js
import { createRoleRunner } from "medhus-crewrun/runner";
import { createCrewrunTurnAdapter } from "./crewrun-adapter.mjs";

const runner = createRoleRunner(); // or: createRoleRunner({ tools: yourMcpBridge })
const runTurn = createCrewrunTurnAdapter({ runner, targetRoot, role });
```

The adapter calls `runner.runRoleCapture` and leaves its configured profile untouched. In
particular, do not add a Slack-specific `auth` override: a profile with `auth: "subscription"`
or normal automatic subscription login continues to work exactly as it does outside Slack.

For host tools, build the same `createToolBroker` and `createMcpBridge` that your other host
uses, then pass the resulting bridge as `tools` to `createRoleRunner`. This keeps the Slack
gateway limited to transport and authorization; role tool allowlists remain enforced by crewrun.

## Test

```bash
node --test test/slack-host.test.js
```

The tests use a fake `fetch` and never contact Slack.
