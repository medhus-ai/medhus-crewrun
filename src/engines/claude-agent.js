import { anthropicRouteEnv, secretValueForRunner } from "../secret-store.js";
import { emitLines } from "./utils.js";
import { claudeShellOptions, claudeShellEnv } from "./claude-shell.js";

const EFFORT_MAP = {
  low: "low",
  medium: "medium",
  high: "high",
  "very-high": "xhigh",
  xhigh: "xhigh",
  max: "max"
};

const HEALTHCHECK_TIMEOUT_MS = 60_000;

// Subprocess env for the SDK. Routed profiles (base_url) speak the Anthropic protocol with a
// Bearer token; otherwise `auth` forces subscription (strip ambient keys so CLI login is used)
// or API-key (inject the stored key, failing loudly when none exists).
function claudeAuthEnv(profile) {
  const routeEnv = anthropicRouteEnv(profile);
  if (routeEnv.ANTHROPIC_BASE_URL) return { env: { ...process.env, ...routeEnv } };
  if (profile.auth === "subscription") {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return { env };
  }
  if (profile.auth === "api-key") {
    const key = secretValueForRunner(profile) || process.env.ANTHROPIC_API_KEY || "";
    if (!key) throw new Error(`runner ${profile.id} is set to API-key auth but no Anthropic API key is available; store one or switch the profile to subscription auth`);
    return { env: { ...process.env, ANTHROPIC_API_KEY: key } };
  }
  return {};
}

export function createClaudeAgentEngine({ loadQuery, loadSdk } = {}) {
  const load = loadSdk || (async () => {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return { ...sdk, query: loadQuery ? await loadQuery() : sdk.query };
  });

  // Without an authorized host bridge, a turn has no tools.
  function buildOptions({ sdk, profile, workdir, systemPrompt, mode, abortController, resumeSessionId, role, capabilities, targetRoot, toolContext, tools, onToolCall, onPartialText, nativeShell }) {
    const shell = toolContext?.shell;
    shell?.check({ role, targetRoot });
    const nativeTools = shell ? ["Bash"] : [];
    const mcp = tools && targetRoot ? tools.createClaudeMcp({ sdk, role, targetRoot, toolContext, onToolCall }) : null;
    const allowedTools = mcp?.allowedTools || [];
    const toolInstructions = tools && targetRoot
      ? tools.claudeToolInstructions(role, { ...(toolContext || {}), targetRoot, root: targetRoot })
      : "";
    const effectiveSystemPrompt = [systemPrompt, toolInstructions].filter(Boolean).join("\n\n");
    const authOptions = claudeAuthEnv(profile);
    // options.env replaces the subprocess env entirely, so claudeAuthEnv spreads process.env back in.
    return {
      cwd: workdir,
      model: profile.model || "sonnet",
      ...authOptions,
      ...(shell ? { env: claudeShellEnv(authOptions.env || process.env) } : {}),
      // Models without effort support (e.g. Haiku) run with the CLI default.
      ...(profile.reasoning_effort ? { effort: EFFORT_MAP[profile.reasoning_effort] || "high" } : {}),
      systemPrompt: effectiveSystemPrompt,
      settingSources: [],
      skills: [],
      tools: nativeTools,
      allowedTools,
      ...(mcp ? { mcpServers: { [mcp.serverName]: mcp.server }, strictMcpConfig: true } : {}),
      permissionMode: "dontAsk",
      ...(nativeShell?.options || {}),
      maxTurns: 50,
      ...(toolContext?.maxBudgetUsd != null ? { maxBudgetUsd: toolContext.maxBudgetUsd } : {}),
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
    capabilities: { agentic: true, streamEvents: true, reportsUsage: true, subscriptionAuth: true, governedToolsOnly: true },

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
          const nativeShell = toolContext?.shell ? claudeShellOptions(toolContext.shell, workdir) : null;
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
              nativeShell,
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
              if (toolContext?.shell && message.subtype === "init" && message.permissionMode !== "auto") {
                abortController.abort();
                throw new Error("Claude native auto mode is unavailable for this runner/account. Shell access has not fallen back to another permission mode.");
              }
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
              if (nativeShell) for (const denial of message.permission_denials || []) nativeShell.recordDenial(denial);
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

    async healthcheck(profile, { timeoutMs = HEALTHCHECK_TIMEOUT_MS } = {}) {
      try {
        const sdk = await load();
        const query = sdk.query;
        const abortController = new AbortController();
        // Keep this shorter than callers' test/UI deadlines so an unreachable
        // provider reports a failed check instead of consuming the whole turn.
        const timer = setTimeout(() => abortController.abort(), timeoutMs);
        let resultMessage = null;
        try {
          const stream = query({
            prompt: "Respond with the word OK and nothing else.",
            options: {
              model: profile.model || "sonnet",
              ...claudeAuthEnv(profile),
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
