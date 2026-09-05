import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { z as zod } from "zod";

import { crewToolDefinitions } from "./crew-tools.js";

// Function-call tool names disallow dots: codebase.search_code -> codebase_search_code.
export function sanitizeToolName(toolName) {
  return String(toolName || "").replace(/[^A-Za-z0-9_-]/g, "_");
}

export function mcpToolFullName(serverName, toolName) {
  return `mcp__${serverName}__${sanitizeToolName(toolName)}`;
}

export function toolResult(result) {
  return {
    content: [{ type: "text", text: stringify(result) }],
    structuredContent: makeStructured(result)
  };
}

export function toolError(error) {
  const message = error?.message || String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: message }
  };
}

const DEFAULT_PASSTHROUGH = ["PATH", "HOME"];

// Kernel tools do not have provider descriptors, so their low-risk behavior is explicit before
// a governed role sees them. Host registries may supply actionPolicy() for the same treatment.
const CREW_TOOL_POLICY = Object.freeze({
  "skill.read": { impact: "read" },
  "memory.reflect": { impact: "internal-write" },
  "skill.propose": { impact: "internal-write" },
  "prefs.propose": { impact: "internal-write" },
  "web.fetch": { impact: "read" },
  "web.search": { impact: "read" }
});

// Exposes a host tool registry to Claude (in-process SDK server) and Codex (stdio child server).
// Registry contract — required: serverName, toolsForRole(role, roleOptions), describe(toolName),
// inputSchema(toolName, z), call({ role, toolName, input, context, roleOptions }).
// Optional: label, toolLineMarker, instructions, enabled(toolContext), validate(toolName, input),
// alwaysLoad(toolName), toolInstructions(role, toolContext, toolNames), serializeContext(toolContext),
// serializableContextKeys, childEnvPassthrough, childEnvPrefixes, childAuthEnv, stdioServerEntry,
// governance (createRoleGovernance facade), actionPolicy(toolName, { role, ...toolContext }).
export function createMcpBridge(registry) {
  if (!registry?.serverName) throw new Error("createMcpBridge requires registry.serverName");
  const serverName = registry.serverName;
  const label = registry.label || serverName;
  const toolLineMarker = registry.toolLineMarker || `[${serverName}-tool]`;
  const enabled = (toolContext) => (registry.enabled ? registry.enabled(toolContext || {}) !== false : true);
  const serializeContext = registry.serializeContext
    || ((toolContext) => defaultSerialize(toolContext, registry.serializableContextKeys || []));

  const includeCrewTools = registry.crewTools !== false;

  function toolNamesFor(role, toolContext = {}) {
    const hostNames = registry.toolsForRole(role, toolContext.roleOptions || {}) || [];
    const candidates = !includeCrewTools
      ? hostNames
      // The kernel's built-in tools ride along (the gated ones only when the role's spec enables
      // them); a host tool with the same name wins.
      : [...hostNames, ...crewToolDefinitions.namesFor(role, toolContext).filter((name) => !hostNames.includes(name))];
    return candidates.filter((toolName) => toolVisibleForRole(role, toolName, toolContext, hostNames));
  }

  function isCrewTool(role, toolName, toolContext = {}) {
    if (!includeCrewTools) return false;
    const hostNames = registry.toolsForRole(role, toolContext.roleOptions || {}) || [];
    return !hostNames.includes(toolName) && crewToolDefinitions.namesFor(role, toolContext).includes(toolName);
  }

  function authorityForTool(role, toolName, toolContext = {}) {
    const governance = registry.governance;
    if (!governance?.authorizeAction) return null;
    const policy = isCrewTool(role, toolName, toolContext)
      ? CREW_TOOL_POLICY[toolName] || { impact: "read" }
      : registry.actionPolicy?.(toolName, { ...toolContext, role }) || {};
    return governance.authorizeAction({
      role,
      toolName,
      impact: policy.impact,
      data: policy.data,
      approval: null
    });
  }

  function toolVisibleForRole(role, toolName, toolContext, hostNames) {
    const governance = registry.governance;
    if (!governance?.authorizeAction) return true;
    try {
      const decision = authorityForTool(role, toolName, toolContext, hostNames);
      // Approval-gated actions remain visible so they can produce a host-owned approval
      // request. Fully denied actions are never registered with either MCP transport.
      return !decision || decision.allowed || decision.decision === "approval-required" || decision.decision === "legacy";
    } catch {
      // A malformed policy must not create a new avenue around the governed boundary.
      return false;
    }
  }

  function assertCrewToolAuthority(role, toolName, toolContext = {}) {
    if (!isCrewTool(role, toolName, toolContext)) return;
    const decision = authorityForTool(role, toolName, toolContext);
    if (!decision || decision.allowed || decision.decision === "legacy") return;
    if (decision.decision === "approval-required") throw new Error(`${toolName} requires host approval`);
    throw new Error(decision.reason || `${toolName} is outside this role's authority`);
  }

  function toolHandlers({ role, toolContext = {}, schemaApi = zod, onToolCall } = {}) {
    const roleOptions = toolContext.roleOptions || {};
    return toolNamesFor(role, toolContext).map((toolName) => {
      const crew = isCrewTool(role, toolName, toolContext);
      const source = crew ? crewToolDefinitions : registry;
      return {
        toolName,
        name: sanitizeToolName(toolName),
        description: source.describe(toolName),
        inputSchema: source.inputSchema(toolName, schemaApi),
        alwaysLoad: Boolean(source.alwaysLoad?.(toolName)),
        invoke: async (args = {}) => {
          onToolCall?.(toolName);
          const validation = !crew && registry.validate ? registry.validate(toolName, args) : { ok: true, input: args };
          if (!validation.ok) return toolError(new Error(validation.error));
          try {
            registry.assertContext?.(toolContext);
            // Host tools receive the same enforcement through createToolBroker. Kernel tools do
            // not pass through that broker, so recheck their role contract at invocation too.
            assertCrewToolAuthority(role, toolName, toolContext);
            return toolResult(await source.call({ role, toolName, input: validation.input, context: toolContext, roleOptions }));
          } catch (error) {
            return toolError(error);
          }
        }
      };
    });
  }

  function createClaudeMcp({ sdk, role, targetRoot, toolContext = {}, onToolCall } = {}) {
    if (!targetRoot || !enabled(toolContext)) return null;
    const schemaApi = sdk?.z || zod;
    if (!sdk?.createSdkMcpServer || !sdk?.tool || !schemaApi) return null;
    const handlers = toolHandlers({
      role,
      toolContext: { ...toolContext, targetRoot, root: targetRoot },
      schemaApi,
      onToolCall
    });
    if (handlers.length === 0) return null;
    const tools = handlers.map((handler) => sdk.tool(
      handler.name,
      handler.description,
      handler.inputSchema,
      (args) => handler.invoke(args),
      { alwaysLoad: handler.alwaysLoad }
    ));
    const server = sdk.createSdkMcpServer({
      name: serverName,
      version: "0.6.0",
      instructions: registry.instructions || "",
      tools,
      alwaysLoad: false
    });
    return {
      serverName,
      server,
      toolNames: handlers.map((handler) => handler.toolName),
      allowedTools: handlers.map((handler) => mcpToolFullName(serverName, handler.toolName))
    };
  }

  function claudeToolInstructions(role, toolContext = {}) {
    if (!toolContext?.targetRoot || !enabled(toolContext)) return "";
    const names = toolNamesFor(role, toolContext);
    if (names.length === 0) return "";
    if (registry.toolInstructions) return registry.toolInstructions(role, toolContext, names);
    const describeFor = (name) => (isCrewTool(role, name, toolContext) ? crewToolDefinitions.describe(name) : registry.describe(name));
    return [
      `## ${label} MCP tools`,
      `You have ${label} MCP tools in addition to the built-in Read/Grep/Glob tools. If this section is present, do not claim that only file-read tools are available.`,
      "",
      `Available ${label} tools:`,
      ...names.map((name) => `- ${name} (${mcpToolFullName(serverName, name)}): ${describeFor(name)}`)
    ].join("\n");
  }

  // Codex reaches host tools through a real stdio MCP server (the host's entry script) because the
  // Codex SDK only injects MCP via CodexOptions.config. The child rebuilds the tool context from a
  // serialized file; secrets never enter that file.
  function codexMcpConfig({ role, targetRoot, toolContext = {}, env = process.env, serverEntry = registry.stdioServerEntry } = {}) {
    const unavailable = { available: false, transport: "mcp", mcp: true };
    if (!targetRoot || !enabled(toolContext) || !serverEntry) return unavailable;
    const toolNames = toolNamesFor(role, toolContext);
    if (toolNames.length === 0) return unavailable;

    const contextData = serializeContext({ ...toolContext, targetRoot, root: targetRoot });
    const contextDir = mkdtempSync(path.join(os.tmpdir(), `${serverName}-mcp-ctx-`));
    const contextFile = path.join(contextDir, "context.json");
    writeFileSync(contextFile, JSON.stringify(contextData), "utf8");
    // Auth keys travel in a 0600 file, never in the child environment — even when a host prefix matches them.
    const authKeys = new Set(registry.childAuthEnv || []);
    const auth = Object.fromEntries([...authKeys]
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]));
    const authFile = Object.keys(auth).length ? path.join(contextDir, "auth.json") : "";
    if (authFile) writeFileSync(authFile, JSON.stringify(auth), { encoding: "utf8", mode: 0o600 });
    const cleanup = () => {
      try { rmSync(contextDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    };

    const serverEnv = {
      CREW_MCP_ROLE: role || "",
      CREW_MCP_CONTEXT_FILE: contextFile,
      ...(authFile ? { CREW_MCP_AUTH_FILE: authFile } : {})
    };
    for (const key of [...DEFAULT_PASSTHROUGH, ...(registry.childEnvPassthrough || [])]) {
      if (env[key] !== undefined && !authKeys.has(key)) serverEnv[key] = env[key];
    }
    const prefixes = ["CREW_", ...(registry.childEnvPrefixes || [])];
    for (const key of Object.keys(env)) {
      if (authKeys.has(key) || key in serverEnv) continue;
      if (prefixes.some((prefix) => key.startsWith(prefix))) serverEnv[key] = env[key];
    }

    return {
      available: true,
      transport: "mcp",
      mcp: true,
      serverName,
      toolNames,
      cleanup,
      config: {
        mcp_servers: {
          [serverName]: {
            command: process.execPath,
            args: [serverEntry],
            env: serverEnv,
            // The SDK runs non-interactively, so an approval prompt would be reported as cancelled;
            // the server already exposes only the tools allowed for this role.
            default_tools_approval_mode: "approve"
          }
        }
      }
    };
  }

  return {
    serverName,
    label,
    toolLineMarker,
    enabled,
    toolHandlers,
    createClaudeMcp,
    claudeToolInstructions,
    codexMcpConfig,
    serializeContext,
    registry
  };
}

// Only plain data crosses the process boundary: no closures, and only declared keys.
function defaultSerialize(toolContext = {}, keys = []) {
  const data = {};
  for (const key of ["targetRoot", "root", "role", "workItemId", "roleOptions", "capabilities", ...keys]) {
    const value = toolContext[key];
    if (value !== undefined && typeof value !== "function") data[key] = value;
  }
  if (!data.targetRoot && data.root) data.targetRoot = data.root;
  return data;
}

// MCP structuredContent must be an object; arrays and primitives are wrapped as { value }.
function makeStructured(value) {
  try {
    const plain = JSON.parse(JSON.stringify(value ?? null));
    return plain !== null && typeof plain === "object" && !Array.isArray(plain) ? plain : { value: plain };
  } catch {
    return { value: stringify(value) };
  }
}

function stringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

// The kernel's own bridge: nothing but the built-in crew tools. Used automatically by
// createRoleRunner when a host supplies no bridge of its own.
export function createCrewOnlyBridge() {
  return createMcpBridge({
    serverName: "crew",
    toolsForRole: () => [],
    describe: (toolName) => crewToolDefinitions.describe(toolName),
    inputSchema: (toolName, z) => crewToolDefinitions.inputSchema(toolName, z),
    call: (request) => crewToolDefinitions.call(request)
  });
}
