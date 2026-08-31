// Role → tool allowlist enforcement. The host supplies the tables; the broker only decides
// whether a role may call a tool and then invokes the registry implementation.
export function createToolBroker({
  allowlists = {},
  fallbackTools = () => [],
  extraTools = () => [],
  sharedTools = [],
  displayRole = (role) => String(role || "agent")
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

  async function callTool({ role, toolName, input = {}, context = {}, registry, roleOptions = {} }) {
    const name = String(toolName || "");
    if (!canCallTool(role, name, roleOptions)) {
      throw new Error(`${displayRole(role)} is not allowed to call ${name}`);
    }
    const tool = registry?.[name];
    if (typeof tool !== "function") {
      throw new Error(`tool ${name} is not registered`);
    }
    return await tool(input, { role, context });
  }

  return { toolsForRole, canCallTool, callTool };
}
