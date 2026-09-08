// No permission bypass and no Bash allow rule: the native classifier remains the
// first reviewer. A denied exact command can be retried once after owner approval.
export function claudeShellEnv(env) {
  const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "TERM", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key) || key.startsWith("LC_")));
}

export function claudeShellOptions(shell, workdir) {
  const calls = new Map();
  const inputFor = (input, cwd = workdir) => ({ command: String(input?.command || ""), timeout: input?.timeout ?? null, cwd });
  const deny = (message) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } });
  function request(name, input, reason, id, cwd) {
    if (name !== "Bash") return;
    shell.request("Bash", calls.get(id) || inputFor(input, cwd), reason);
  }
  const options = {
    permissionMode: "auto",
    canUseTool: async (name, input, options) => {
      if (name === "Bash" && shell.approved(options.toolUseID, name, inputFor(input, calls.get(options.toolUseID)?.cwd))) return { behavior: "allow", updatedInput: input };
      request(name, input, options.decisionReason || "Native permissions require human approval.", options.toolUseID);
      return { behavior: "deny", message: "Saved for owner review in CrewRun Reviews. Stop; do not retry or work around this action." };
    },
    hooks: {
      PreToolUse: [{ hooks: [async (input, toolUseId) => {
        try {
          shell.check();
          if (input.tool_name !== "Bash") return {};
          if (input.tool_input?.run_in_background) return deny("Use foreground commands so cancellation and review remain attached to this turn.");
          const command = inputFor(input.tool_input, input.cwd || workdir);
          calls.set(toolUseId, command);
          const decision = shell.before("Bash", command, toolUseId);
          if (decision === "deny") return deny("This exact command is pending, rejected, already used, or uncertain. Resolve its existing review; do not retry.");
          shell.record("tool_requested", { tool: "Bash", callId: toolUseId, command, reviewer: decision === "approved" ? "owner" : "native-auto" });
          return decision === "approved" ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Owner approved this exact command once in CrewRun Reviews." } } : {};
        } catch (error) { return deny(error.message); }
      }] }],
      PermissionDenied: [{ hooks: [async (input) => { request(input.tool_name, input.tool_input, input.reason, input.tool_use_id, input.cwd); return {}; }] }],
      PostToolUse: [{ matcher: "Bash", hooks: [async (_input, id) => { shell.finish(id); return {}; }] }],
      PostToolUseFailure: [{ matcher: "Bash", hooks: [async (_input, id) => { shell.finish(id, { ok: false }); return {}; }] }]
    }
  };
  return { options, recordDenial: (denial) => request(denial.tool_name, denial.tool_input, "Native Claude denied this command. Owner review is required.", denial.tool_use_id) };
}
