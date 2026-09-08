// All roles use durable, governed task delegation. Titles never grant native tools.
export function roleCapabilityProfile(role) {
  return { role: String(role || "").trim(), kind: "agent", subagents: { allowed: false } };
}
export function roleCapabilityInstructions() {
  return [
    "## Control boundary",
    "The host owns task state, external actions, authority, and durable memory review.",
    "Use governed tools and task.delegate for authorized handoffs. Do not spawn native subagents.",
    "Do not modify provider configuration, hooks, MCP servers, or authority through native tools."
  ].join("\n");
}
