import { anthropicRouteEnv } from "../secret-store.js";
import { claudeSubagentDefinitions, claudeSubagentToolRule, roleCapabilityProfile } from "../role-capabilities.js";
import { emitLines } from "./utils.js";

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
// Bash excluded by default: unlike file edits, a shell is not confined to the worktree and runs with the operator's full environment.
const EXECUTE_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write"];

const EFFORT_MAP = {
  low: "low",
  medium: "medium",
  high: "high",
  "very-high": "xhigh",
  xhigh: "xhigh",
  max: "max"
};

export function createClaudeAgentEngine({ loadQuery, loadSdk } = {}) {
  const load = loadSdk || (async () => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return { ...sdk, query: loadQuery ? await loadQuery() : sdk.query };
  });

  // `tools` is a host MCP bridge (createMcpBridge); without one the turn has only file-read tools.
  function buildOptions({ sdk, profile, workdir, systemPrompt, mode, abortController, resumeSessionId, role, capabilities, targetRoot, toolContext, tools, onToolCall, onPartialText }) {
    const effectiveCapabilities = capabilities || roleCapabilityProfile(role, toolContext?.roleOptions || {});
    const baseTools = mode === "execute"
      ? (profile.allow_shell === true ? [...EXECUTE_TOOLS, "Bash"] : EXECUTE_TOOLS)
      : READ_ONLY_TOOLS;
    const subagentRule = claudeSubagentToolRule(effectiveCapabilities);
    const nativeTools = subagentRule ? [...baseTools, "Agent"] : baseTools;
    const mcp = tools && targetRoot ? tools.createClaudeMcp({ sdk, role, targetRoot, toolContext, onToolCall }) : null;
    const nativeAllowedTools = subagentRule ? [...baseTools, subagentRule] : baseTools;
    const allowedTools = mcp ? [...nativeAllowedTools, ...mcp.allowedTools] : nativeAllowedTools;
    const toolInstructions = tools && targetRoot
      ? tools.claudeToolInstructions(role, { ...(toolContext || {}), targetRoot, root: targetRoot })
      : "";
    const effectiveSystemPrompt = [systemPrompt, toolInstructions].filter(Boolean).join("\n\n");
    // Routed profiles (GLM, Kimi, local servers) speak the Anthropic API at profile.base_url.
    // options.env replaces the subprocess env entirely, so spread process.env back in.
    const routeEnv = anthropicRouteEnv(profile);
    return {
      cwd: workdir,
      model: profile.model || "sonnet",
      ...(routeEnv.ANTHROPIC_BASE_URL ? { env: { ...process.env, ...routeEnv } } : {}),
      // Models without effort support (e.g. Haiku) run with the CLI default.
      ...(profile.reasoning_effort ? { effort: EFFORT_MAP[profile.reasoning_effort] || "high" } : {}),
      systemPrompt: effectiveSystemPrompt,
      settingSources: [],
      skills: [],
      tools: nativeTools,
      allowedTools,
      ...(subagentRule ? {
        agents: claudeSubagentDefinitions(effectiveCapabilities, { allowShell: profile.allow_shell === true }),
        forwardSubagentText: true
      } : {}),
      ...(mcp ? { mcpServers: { [mcp.serverName]: mcp.server }, strictMcpConfig: true } : {}),
      // execute auto-accepts edits inside the isolated worktree; propose denies everything else without prompting.
      permissionMode: mode === "execute" ? "acceptEdits" : "dontAsk",
      maxTurns: 50,
      abortController,
      // Partial SDK events are useful for the live UI, but avoid the additional
      // stream traffic when no caller can render them.
      ...(onPartialText ? { includePartialMessages: true } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {})
    };
  }

  return {
    id: "claude-agent",
    label: "Claude",
    capabilities: { agentic: true, streamEvents: true, reportsUsage: true, subscriptionAuth: true },

    startTurn({ targetRoot, profile, workdir, role, mode, capabilities, systemPrompt, prompt, resumeSessionId, toolContext, tools, onLine, onPartialText, onStatus, onClose, onError }) {
      const abortController = new AbortController();
      let closed = false;
      const close = (payload) => {
        if (closed) return;
        closed = true;
        onClose?.(payload);
      };

      (async () => {
        try {
          onStatus?.("thinking…");
          const sdk = await load();
          const query = sdk.query;
          const stream = query({
            prompt,
            options: buildOptions({
              sdk,
              profile,
              workdir,
              systemPrompt,
              mode,
              abortController,
              resumeSessionId,
              role,
              capabilities,
              targetRoot,
              toolContext,
              tools,
              onToolCall: (toolName) => {
                onLine?.(tools?.toolLineMarker || "[tool]");
                onStatus?.(`running ${tools?.label || "tool"} ${toolName}…`);
              },
              onPartialText
            })
          });

          let usage = null;
          let failure = "";
          let engineSessionId = resumeSessionId || null;
          for await (const message of stream) {
            if (message.type === "system") {
              onStatus?.("session ready — waiting for the model…");
            } else if (message.type === "stream_event") {
              const event = message.event;
              // Forward primary-assistant text only. Subagent text has its own
              // lifecycle and must not be appended into the parent live reply.
              if ((message.parent_tool_use_id === null || message.parent_tool_use_id === undefined)
                && event?.type === "content_block_delta"
                && event.delta?.type === "text_delta"
                && event.delta.text) {
                onPartialText?.(event.delta.text);
                onStatus?.("writing…");
              }
            } else if (message.type === "user") {
              onStatus?.("processing tool results…");
            } else if (message.type === "assistant") {
              for (const block of message.message?.content || []) {
                if (block.type === "text" && block.text) {
                  emitLines(onLine, block.text);
                  onStatus?.("writing…");
                } else if (block.type === "thinking") {
                  onStatus?.("thinking…");
                } else if (block.type === "tool_use") {
                  if (block.name === "Agent") {
                    const label = block.input?.subagent_type || block.input?.description || "bounded helper";
                    onLine?.(`[subagent] ${label}`);
                    onStatus?.(`delegating: ${label}…`);
                  } else {
                    onLine?.(`[tool] ${block.name}`);
                    onStatus?.(`running ${block.name}…`);
                  }
                }
              }
            } else if (message.type === "result") {
              usage = {
                inputTokens: message.usage?.input_tokens ?? null,
                outputTokens: message.usage?.output_tokens ?? null,
                costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : null
              };
              if (message.session_id) engineSessionId = message.session_id;
              if (message.subtype !== "success" || message.is_error) {
                failure = message.subtype === "success" ? "runner reported an error" : `runner ended: ${message.subtype}`;
              }
            }
          }
          close({ code: failure ? 1 : 0, stderr: failure, usage, engineSessionId });
        } catch (error) {
          onError?.(error);
          close({ code: 1, stderr: error?.message || String(error), usage: null, engineSessionId: null });
        }
      })();

      return {
        pid: null,
        kill: () => abortController.abort(),
        role
      };
    },

    async healthcheck(profile) {
      try {
        const sdk = await load();
        const query = sdk.query;
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), 120000);
        const routeEnv = anthropicRouteEnv(profile);
        let resultMessage = null;
        try {
          const stream = query({
            prompt: "Respond with the word OK and nothing else.",
            options: {
              model: profile.model || "sonnet",
              ...(routeEnv.ANTHROPIC_BASE_URL ? { env: { ...process.env, ...routeEnv } } : {}),
              tools: [],
              maxTurns: 1,
              permissionMode: "dontAsk",
              abortController
            }
          });
          for await (const message of stream) {
            if (message.type === "result") resultMessage = message;
          }
        } finally {
          clearTimeout(timer);
        }
        const ok = resultMessage?.subtype === "success" && !resultMessage?.is_error;
        return {
          ok,
          status: ok ? "pass" : "fail",
          stdout: resultMessage?.result || "",
          stderr: "",
          message: ok
            ? `runner ${profile.id} healthcheck passed (Claude profile)`
            : `runner ${profile.id} healthcheck failed: ${resultMessage?.subtype || "no result"}`
        };
      } catch (error) {
        const hint = profile.base_url
          ? `Check the ${profile.provider} key in Settings → API Keys and that ${profile.base_url} is reachable.`
          : "Sign in with `claude` (Pro/Max) or set ANTHROPIC_API_KEY.";
        return {
          ok: false,
          status: "fail",
          stdout: "",
          stderr: error?.message || String(error),
          message: `runner ${profile.id} healthcheck failed: ${error?.message || error}. ${hint}`
        };
      }
    }
  };
}
