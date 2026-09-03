// Start the reference Slack gateway. Configuration stays in the environment; runner selection
// and auth stay in the target project's normal .crew/memory/ai-runners.json configuration.
import path from "node:path";

import { crewHome } from "medhus-crewrun/crew-dirs";
import { createRoleRunner } from "medhus-crewrun/runner";
import { createRoleGovernance } from "medhus-crewrun/role-contract";
import { loadRoleSpec } from "medhus-crewrun/role-spec";

import { createCrewrunTurnAdapter } from "./crewrun-adapter.mjs";
import { createEventDedupe, createSlackHost } from "./host.mjs";

const targetRoot = path.resolve(requiredEnv("CREW_SLACK_TARGET_ROOT"));
const role = requiredEnv("CREW_SLACK_ROLE");
const userIds = csvEnv("CREW_SLACK_ALLOWED_USERS");
if (!userIds.length) throw new Error("CREW_SLACK_ALLOWED_USERS must contain one or more Slack user IDs");
if (process.env.CREW_SLACK_APPROVE_MENTION_REPLIES !== "1") {
  throw new Error("set CREW_SLACK_APPROVE_MENTION_REPLIES=1 only if an allowed, signed mention is your reply-approval policy");
}

const runner = createRoleRunner();
const runTurn = createCrewrunTurnAdapter({ runner, targetRoot, role });
const users = Object.fromEntries(userIds.map((userId) => [userId, { targetRoot, role }]));
// The reference gateway is strict: an outbound model reply is not delivered unless the role's
// reviewed v1 contract grants this Slack action and its channel data scope. The audit is local
// to the operator's crew home; no reply text or Slack token is written to it.
const governance = createRoleGovernance({
  targetRoot,
  requireContracts: true,
  getContract: (roleId) => loadRoleSpec(targetRoot, roleId)?.contract
});
const dedupeFile = process.env.CREW_SLACK_DEDUPE_FILE
  || path.join(crewHome(), "slack", "event-ids.json");
const gateway = createSlackHost({
  signingSecret: requiredEnv("CREW_SLACK_SIGNING_SECRET"),
  botToken: requiredEnv("CREW_SLACK_BOT_TOKEN"),
  users,
  runTurn,
  // This reference policy makes one narrow choice: a signed app mention from an explicitly
  // configured Slack user approves one reply in that same thread. Replace it with a queue or
  // your own policy when a human must approve each delivery.
  approveReply: ({ eventId, userId }) => ({ id: `slack-event:${eventId}`, status: "approved", approved_by: `slack-mention:${userId}` }),
  governance,
  dedupe: createEventDedupe({ file: dedupeFile })
});

const port = positivePort(process.env.CREW_SLACK_PORT, 3000);
const bind = process.env.CREW_SLACK_BIND || "127.0.0.1";
const server = gateway.listen({ port, host: bind });
server.on("listening", () => {
  console.log(`crewrun Slack gateway listening on http://${bind}:${port}/slack/events`);
});

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function csvEnv(name) {
  return [...new Set(String(process.env[name] || "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function positivePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : fallback;
}
