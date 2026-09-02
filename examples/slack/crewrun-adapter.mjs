// Adapts a Slack app_mention to crewrun's existing headless role runner. It intentionally does
// not choose authentication: the role's normal runner profile (including subscription auth) is
// resolved by createRoleRunner exactly as it is for every other host.

export function createCrewrunTurnAdapter({
  runner,
  targetRoot,
  role,
  timeoutMs = 120_000,
  targetRootFor = ({ user }) => user?.targetRoot || targetRoot,
  roleFor = ({ user }) => user?.role || role,
  toolContextFor = () => ({}),
  contextFor = defaultContext,
  onStatus,
  log = console.error
} = {}) {
  if (!runner || typeof runner.runRoleCapture !== "function") {
    throw new Error("createCrewrunTurnAdapter requires runner.runRoleCapture");
  }
  if (typeof targetRootFor !== "function" || typeof roleFor !== "function") {
    throw new Error("targetRootFor and roleFor must be functions");
  }

  return async function runSlackTurn(input) {
    const root = String(targetRootFor(input) || "").trim();
    const selectedRole = String(roleFor(input) || "").trim();
    if (!root || !selectedRole) {
      throw new Error("Slack user is not configured with a targetRoot and role");
    }
    const result = await runner.runRoleCapture({
      root,
      role: selectedRole,
      prompt: String(input.text || "").trim() || "Please help with this request.",
      timeoutMs: Math.max(1_000, Number(timeoutMs) || 120_000),
      toolContext: toolContextFor({ ...input, targetRoot: root, role: selectedRole }) || {},
      context: contextFor({ ...input, targetRoot: root, role: selectedRole }) || "",
      onStatus,
      log,
      error: log
    });
    if (!result?.ok) throw new Error(result?.reason || "runner failed");
    return { text: result.text };
  };
}

function defaultContext({ userId, channel, threadTs, eventId }) {
  return [
    "## Slack request metadata",
    `- Slack user: ${userId || "unknown"}`,
    `- Channel: ${channel || "unknown"}`,
    `- Thread: ${threadTs || "unknown"}`,
    `- Event: ${eventId || "unknown"}`
  ].join("\n");
}
