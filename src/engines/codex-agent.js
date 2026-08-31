import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { crewHome } from "../crew-dirs.js";
import { secretValueForRunner } from "../secret-store.js";
import { emitLines } from "./utils.js";

const EFFORT_MAP = {
  low: "low",
  medium: "medium",
  high: "high",
  "very-high": "xhigh",
  xhigh: "xhigh",
  max: "xhigh"
};

const NO_TOOLS = Object.freeze({ available: false, transport: "mcp", mcp: true });

// Routed profiles target an OpenAI-compatible endpoint (e.g. vLLM) with their own
// key; without base_url the ambient subscription/env auth stays untouched.
function codexClientOptions(profile, mcpConfig = {}, capabilities = null) {
  const apiKey = profile?.base_url ? secretValueForRunner(profile) : "";
  const allowSubagents = capabilities?.subagents?.allowed === true;
  return {
    ...(profile?.base_url ? { baseUrl: profile.base_url } : {}),
    ...(apiKey ? { apiKey } : {}),
    env: codexRuntimeEnv(),
    config: {
      features: {
        hooks: false,
        memories: false,
        multi_agent: allowSubagents,
        plugins: false,
        remote_plugin: false
      },
      agents: { max_depth: 1, max_threads: allowSubagents ? 4 : 1 },
      memories: { use_memories: false, generate_memories: false },
      project_doc_max_bytes: 0,
      project_doc_fallback_filenames: [],
      ...mcpConfig
    }
  };
}

function codexRuntimeEnv(env = process.env) {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP",
    "LANG", "TERM", "CODEX_HOME", "OPENAI_API_KEY", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"
  ];
  const out = {};
  for (const key of allowed) if (env[key] !== undefined) out[key] = env[key];
  for (const key of Object.keys(env)) if (key.startsWith("LC_")) out[key] = env[key];
  const ghConfig = path.join(os.tmpdir(), "crew-provider-no-gh-auth");
  try { mkdirSync(ghConfig, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  out.GH_CONFIG_DIR = ghConfig;
  out.CODEX_HOME = isolatedCodexHome(env);
  return out;
}

function isolatedCodexHome(env) {
  // Codex creates trusted helper aliases (including codex-linux-sandbox) under
  // CODEX_HOME. It intentionally refuses to create them below a temporary
  // directory, so keep the isolated runtime under the crew's secured home.
  const managed = path.join(crewHome(env), "provider-runtime", "codex");
  const source = path.resolve(env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"));
  try {
    mkdirSync(managed, { recursive: true, mode: 0o700 });
    chmodSync(managed, 0o700);
    const sourceAuth = path.join(source, "auth.json");
    const managedAuth = path.join(managed, "auth.json");
    if (existsSync(sourceAuth) && (!existsSync(managedAuth) || statSync(sourceAuth).mtimeMs > statSync(managedAuth).mtimeMs)) {
      copyFileSync(sourceAuth, managedAuth);
      chmodSync(managedAuth, 0o600);
    }
    return managed;
  } catch {
    // API-key profiles remain usable even when the isolated home cannot be prepared.
    return managed;
  }
}

export function createCodexAgentEngine({ loadCodex } = {}) {
  const load = loadCodex || (async () => (await import("@openai/codex-sdk")).Codex);

  function threadOptions({ profile, workdir, mode }) {
    return {
      workingDirectory: workdir,
      skipGitRepoCheck: true,
      // propose: sandbox blocks all writes; execute: writes allowed inside the isolated worktree only.
      sandboxMode: mode === "execute" ? "workspace-write" : "read-only",
      ...(profile.model ? { model: profile.model } : {}),
      ...(EFFORT_MAP[profile.reasoning_effort]
        ? { modelReasoningEffort: EFFORT_MAP[profile.reasoning_effort] }
        : {})
    };
  }

  return {
    id: "codex-agent",
    label: "Codex",
    capabilities: { agentic: true, streamEvents: true, reportsUsage: true, subscriptionAuth: true },

    // `tools` is a host MCP bridge; it is served to Codex through the host's stdio entry script.
    startTurn({ targetRoot, profile, workdir, role, mode, capabilities, systemPrompt, prompt, resumeSessionId, toolContext, tools, onLine, onPartialText, onStatus, onClose, onError }) {
      const abortController = new AbortController();
      const effectiveTargetRoot = toolContext?.targetRoot || targetRoot || null;
      const effectiveToolContext = effectiveTargetRoot
        ? { ...(toolContext || {}), targetRoot: effectiveTargetRoot, root: effectiveTargetRoot, role }
        : (toolContext || {});
      const mcp = tools && effectiveTargetRoot
        ? tools.codexMcpConfig({ role, targetRoot: effectiveTargetRoot, toolContext: effectiveToolContext })
        : NO_TOOLS;
      let closed = false;
      const close = (payload) => {
        if (closed) return;
        closed = true;
        mcp.cleanup?.();
        onClose?.({ ...payload, tools: { available: mcp.available, transport: mcp.transport, mcp: mcp.mcp } });
      };

      (async () => {
        try {
          onStatus?.("thinking…");
          const Codex = await load();
          const codex = new Codex(codexClientOptions(profile, mcp.available ? mcp.config : {}, capabilities));
          const options = threadOptions({ profile, workdir, mode });
          const thread = resumeSessionId ? codex.resumeThread(resumeSessionId, options) : codex.startThread(options);
          // Codex has no separate system-prompt channel; prepend it on the first turn only.
          const turnPrompt = [
            systemPrompt && !resumeSessionId ? systemPrompt : "",
            prompt
          ].filter(Boolean).join("\n\n");

          let usage = null;
          let failure = "";
          let engineSessionId = resumeSessionId || null;
          const partialAgentText = new Map();

          const emitPartialAgentText = (item) => {
            if (!onPartialText || item?.type !== "agent_message" || !item.id || typeof item.text !== "string") return;
            const itemId = String(item.id);
            const previous = partialAgentText.get(itemId) || "";
            if (item.text === previous) return;
            partialAgentText.set(itemId, item.text);
            // Codex item updates contain the complete text so far. Emit only the
            // new suffix; a non-prefix rewrite is left for the final message.
            if (item.text.startsWith(previous)) {
              const delta = item.text.slice(previous.length);
              if (delta) onPartialText(delta);
            }
          };

          const { events } = await thread.runStreamed(turnPrompt, { signal: abortController.signal });
          for await (const event of events) {
            if (event.type === "thread.started") {
              if (event.thread_id) engineSessionId = event.thread_id;
            } else if (event.type === "turn.started") {
              onStatus?.("working…");
            } else if (event.type === "item.started" || event.type === "item.updated") {
              const item = event.item;
              if (item?.type === "agent_message") {
                emitPartialAgentText(item);
                onStatus?.("writing…");
              } else if (item?.type === "reasoning") onStatus?.("thinking…");
              else if (item?.type === "command_execution") onStatus?.(`running: ${item.command}`);
              else if (item?.type === "mcp_tool_call") onStatus?.(`running ${item.server}.${item.tool}…`);
              else if (item?.type === "web_search") onStatus?.(`searching: ${item.query}`);
            } else if (event.type === "item.completed") {
              const item = event.item;
              if (item.type === "agent_message") {
                partialAgentText.delete(String(item.id));
                if (item.text) emitLines(onLine, item.text);
              }
              else if (item.type === "command_execution") onLine?.(`[cmd] ${item.command}`);
              else if (item.type === "file_change") onLine?.(`[edit] ${(item.changes || []).length} file change(s) (${item.status})`);
              else if (item.type === "mcp_tool_call") {
                const detail = item.status === "failed" && item.error?.message ? `: ${item.error.message}` : "";
                onLine?.(`[mcp] ${item.server}.${item.tool} (${item.status})${detail}`);
              }
              else if (item.type === "web_search") onLine?.(`[search] ${item.query}`);
              else if (item.type === "error") failure = item.message || "codex reported an error";
            } else if (event.type === "turn.completed") {
              usage = addUsage(usage, event.usage);
            } else if (event.type === "turn.failed") {
              failure = event.error?.message || "codex turn failed";
            } else if (event.type === "error") {
              failure = event.message || "codex stream error";
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
        const Codex = await load();
        const codex = new Codex(codexClientOptions(profile));
        const thread = codex.startThread({
          skipGitRepoCheck: true,
          sandboxMode: "read-only",
          ...(profile.model ? { model: profile.model } : {})
        });
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), 120000);
        let turn;
        try {
          turn = await thread.run("Respond with the word OK and nothing else.", { signal: abortController.signal });
        } finally {
          clearTimeout(timer);
        }
        const ok = typeof turn?.finalResponse === "string" && turn.finalResponse.trim().length > 0;
        return {
          ok,
          status: ok ? "pass" : "fail",
          stdout: turn?.finalResponse || "",
          stderr: "",
          message: ok
            ? `runner ${profile.id} healthcheck passed (Codex profile)`
            : `runner ${profile.id} healthcheck failed: empty response`
        };
      } catch (error) {
        return {
          ok: false,
          status: "fail",
          stdout: "",
          stderr: error?.message || String(error),
          message: `runner ${profile.id} healthcheck failed: ${error?.message || error}. Sign in with \`codex login\` (ChatGPT) or set OPENAI_API_KEY.`
        };
      }
    }
  };
}

function addUsage(current, usage) {
  const input = usage?.input_tokens ?? null;
  const output = usage?.output_tokens ?? null;
  if (input === null && output === null) return current;
  return {
    inputTokens: addNullable(current?.inputTokens, input),
    outputTokens: addNullable(current?.outputTokens, output),
    costUsd: null
  };
}

function addNullable(left, right) {
  if (left === null || left === undefined) return right ?? null;
  if (right === null || right === undefined) return left ?? null;
  return left + right;
}
