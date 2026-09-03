// Role → tool allowlist enforcement. The host supplies the tables; the broker only decides
// whether a role may call a tool and then invokes the registry implementation.
export function createToolBroker({
  allowlists = {},
  fallbackTools = () => [],
  extraTools = () => [],
  sharedTools = [],
  displayRole = (role) => String(role || "agent"),
  // Optional v0.6 policy facade from createRoleGovernance(). Existing hosts retain their
  // allowlist-only behavior until they deliberately supply one.
  governance = null
} = {}) {
  function toolsForRole(role, options = {}) {
    const id = String(role || "").trim();
    if (!id) return [];
    const specific = allowlists[id] || fallbackTools(id, options) || [];
    return [...new Set([...specific, ...(extraTools(id, options) || []), ...sharedTools])];
  }

  function canCallTool(role, toolName, options = {}) {
    return toolsForRole(role, options).includes(String(toolName || ""));
  }

  async function callTool({
    role,
    toolName,
    input = {},
    context = {},
    registry,
    roleOptions = {},
    approval = null,
    data = null,
    impact = "",
    actor = "",
    runner = "",
    model = ""
  }) {
    const name = String(toolName || "");
    if (!canCallTool(role, name, roleOptions)) {
      await recordGovernance({
        role, toolName: name, input, context, approval, data, impact, actor, runner, model,
        outcome: "denied",
        decision: { decision: "denied", reason: `${displayRole(role)} is not allowed to call ${name}` }
      });
      throw new Error(`${displayRole(role)} is not allowed to call ${name}`);
    }
    let effectiveApproval = approval;
    let decision = governance?.authorizeAction
      ? await governance.authorizeAction({ role, toolName: name, input, context, roleOptions, approval, data, impact })
      : null;
    // The host, not the role/model, owns approval creation. A host may return an approved record
    // after a synchronous UI confirmation, or a pending value and let the caller retry later with
    // the approved record. No action is retried automatically unless the host explicitly returns it.
    if (decision?.decision === "approval-required" && governance?.requestApproval) {
      const response = await governance.requestApproval({
        role, toolName: name, input, context, roleOptions, data, impact, actor, runner, model, decision
      });
      effectiveApproval = response?.approval ?? response ?? null;
      if (effectiveApproval) {
        decision = await governance.authorizeAction({
          role, toolName: name, input, context, roleOptions, approval: effectiveApproval, data, impact
        });
      }
    }
    if (decision && !decision.allowed) {
      await recordGovernance({ role, toolName: name, input, context, approval: effectiveApproval, data, impact, actor, runner, model, outcome: decision.decision, decision });
      if (decision.decision === "approval-required") {
        throw new Error(`${displayRole(role)} needs host approval to call ${name}`);
      }
      throw new Error(`${displayRole(role)} is not authorized to call ${name}${decision.reason ? `: ${decision.reason}` : ""}`);
    }
    const tool = registry?.[name];
    if (typeof tool !== "function") {
      throw new Error(`tool ${name} is not registered`);
    }
    // When the host configured an audit sink, write a durable start record before an external
    // action. A failed audit write stops the action; hosts that intentionally omit a sink keep
    // the lightweight policy-only integration.
    const started = await recordGovernance({ role, toolName: name, input, context, approval: effectiveApproval, data, impact, actor, runner, model, outcome: "started", decision });
    try {
      const output = await tool(input, { role, context });
      await recordGovernance({
        role, toolName: name, input, output, context, approval: effectiveApproval, data, impact, actor, runner, model,
        operationId: started?.id || "", outcome: "completed", decision
      });
      return output;
    } catch (error) {
      try {
        await recordGovernance({
          role, toolName: name, input, context, approval: effectiveApproval, data, impact, actor, runner, model,
          operationId: started?.id || "", outcome: "failed", decision, error: error?.message || String(error)
        });
      } catch {
        // The start record already establishes that this action was attempted. Do not replace
        // the tool failure with a secondary audit-write failure.
      }
      throw error;
    }
  }

  async function recordGovernance(record) {
    if (!governance?.recordAction) return null;
    return await governance.recordAction({ action: "tool", ...record });
  }

  return { toolsForRole, canCallTool, callTool };
}
