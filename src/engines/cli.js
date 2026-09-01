import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { crewEnvNames } from "../crew-dirs.js";
import { resolveExecutable, toolEnv } from "../platform.js";
import { anthropicRouteEnv, secretEnvForRunner } from "../secret-store.js";

// Tier-0 universal engine: invokes the runner profile's configured command
// and args directly, substituting {prompt} with the prompt text.
// Works with any vendor that ships a CLI.
export function createCliEngine() {
  return {
    id: "cli",
    label: "Custom CLI",
    capabilities: { agentic: false, streamEvents: false, reportsUsage: false, subscriptionAuth: false },

    startTurn({ targetRoot, runnerId, profile, prompt, onLine, onStatus, onClose, onError }) {
      const tmpdir = mkdtempSync(path.join(os.tmpdir(), "crew-chat-"));
      const promptPath = path.join(tmpdir, "prompt.txt");
      writeFileSync(promptPath, prompt, "utf8");

      const command = profile?.command || "true";
      const rawArgs = Array.isArray(profile?.args) ? profile.args : [];
      const args = rawArgs.map((arg) =>
        typeof arg === "string" ? arg.replace(/\{prompt\}/g, prompt).replace(/\{prompt_file\}/g, promptPath) : arg
      );
      const providerEnv = toolEnv();
      delete providerEnv.GH_TOKEN;
      delete providerEnv.GITHUB_TOKEN;
      providerEnv.GH_CONFIG_DIR = path.join(tmpdir, "no-gh-auth");
      const resolved = resolveExecutable(command, { env: providerEnv });
      const executable = resolved.available ? resolved.path : command;

      onStatus?.("thinking…");
      const child = spawn(executable, args, {
        cwd: targetRoot,
        env: {
          ...providerEnv,
          ...secretEnvForRunner(profile),
          ...anthropicRouteEnv(profile),
          ...Object.fromEntries(crewEnvNames("NODE_BIN").map((name) => [name, process.execPath])),
          ...Object.fromEntries(crewEnvNames("PROMPT_FILE").map((name) => [name, promptPath]))
        }
      });

      let stdoutBuffer = "";
      let stderrBuffer = "";

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        let idx;
        while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, idx);
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          try { onLine?.(line); } catch (error) { onError?.(error); }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderrBuffer += chunk; });

      child.on("error", (error) => { onError?.(error); });

      child.on("close", (code) => {
        if (stdoutBuffer.length > 0) {
          try { onLine?.(stdoutBuffer); } catch (error) { onError?.(error); }
        }
        try {
          onClose?.({ code, stderr: stderrBuffer, usage: null });
        } catch (error) {
          onError?.(error);
        } finally {
          try { rmSync(tmpdir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      });

      return { pid: child.pid, kill: (signal = "SIGTERM") => child.kill(signal) };
    },

    async healthcheck(profile) {
      if (typeof profile.command === "string" && profile.command.startsWith("replace-")) {
        return { ok: false, status: "placeholder", message: `runner ${profile.id} still has a placeholder command` };
      }
      const health = profile.healthcheck || { command: profile.command, args: profile.args || [] };
      const command = health.command || profile.command;
      const args = health.args || profile.args || [];
      const runtimeEnv = toolEnv();
      const resolved = resolveExecutable(command, { env: runtimeEnv });
      const executable = resolved.available ? resolved.path : command;
      const result = spawnSync(executable, args, {
        encoding: "utf8",
        env: runtimeEnv,
        timeout: 60000
      });
      const stdout = String(result.stdout || "").trim();
      const expected = String(health.expect_stdout || "").trim();
      const stdoutOk = expected ? stdout === expected : true;
      const ok = result.status === 0 && stdoutOk;
      return {
        ok,
        status: ok ? "pass" : "fail",
        exitCode: result.status,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        message: ok ? `runner ${profile.id} healthcheck passed` : `runner ${profile.id} healthcheck failed`
      };
    }
  };
}
