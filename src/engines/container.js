import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { anthropicRouteEnv, secretEnvForRunner } from "../secret-store.js";

const PROTOCOL = "@@crew-container@@";
const KERNEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_WORKER = path.join(KERNEL_ROOT, "src", "engines", "container-worker.js");

// Wraps an engine so its turn runs inside a locked-down Docker container. `hostRoot` is the
// host package to mount read-only and `workerEntry` its worker script (which supplies the
// host's tool bridge); both default to the kernel itself, which runs turns without host tools.
export function createContainerEngine(engine, policy, { hostRoot = KERNEL_ROOT, workerEntry = DEFAULT_WORKER, spawnImpl = spawn, spawnSyncImpl = spawnSync } = {}) {
  return {
    ...engine,
    label: `${engine.label} (container)`,
    startTurn(input) {
      return startContainerTurn({ engine, policy, input, hostRoot, workerEntry, spawnImpl, spawnSyncImpl });
    }
  };
}

export function buildContainerArgs({ engineId, policy, input, containerName, hostRoot = KERNEL_ROOT, workerEntry = DEFAULT_WORKER }) {
  const targetRoot = path.resolve(input.targetRoot);
  const workdir = path.resolve(input.workdir);
  const args = [
    "run", "--rm", "-i", "--init", "--name", containerName,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(policy.pidsLimit),
    "--memory", `${policy.memoryMb}m`,
    "--cpus", String(policy.cpus),
    "--network", policy.network,
    "--tmpfs", "/tmp:rw,nosuid,size=1g",
    "--tmpfs", "/home/crew:rw,nosuid,size=256m",
    "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "--env", "HOME=/home/crew",
    "--env", "GIT_CONFIG_NOSYSTEM=1",
    "--mount", `type=bind,src=${targetRoot},dst=${targetRoot},readonly`,
    "--mount", `type=bind,src=${path.join(targetRoot, ".git")},dst=${path.join(targetRoot, ".git")}`,
    "--mount", `type=bind,src=${workdir},dst=${workdir}`,
    "--workdir", workdir
  ];
  // The worker imports host and kernel code, so both packages are visible read-only at their
  // real paths (a symlinked kernel install resolves outside the host package).
  for (const root of codeMounts(hostRoot, targetRoot)) {
    args.push("--mount", `type=bind,src=${root},dst=${root},readonly`);
  }
  for (const name of Object.keys(containerCredentialEnv(input.profile))) args.push("--env", name);
  args.push(policy.image, "node", workerEntry, engineId);
  return args;
}

function codeMounts(hostRoot, targetRoot) {
  const mounts = [];
  for (const candidate of [hostRoot, KERNEL_ROOT]) {
    const root = realpathOr(path.resolve(candidate));
    if (root === targetRoot || isWithin(targetRoot, root) || mounts.some((mount) => isWithin(mount, root))) continue;
    mounts.push(root);
  }
  return mounts;
}

function startContainerTurn({ engine, policy, input, hostRoot, workerEntry, spawnImpl, spawnSyncImpl }) {
  const credentials = containerCredentialEnv(input.profile);
  if (requiresApiCredential(input.profile) && Object.keys(credentials).length === 0) {
    throw new Error(`container execution for ${input.profile?.provider || engine.id} requires a scoped API key; subscription credentials are never mounted`);
  }
  const containerName = `crew-${randomUUID().slice(0, 12)}`;
  const args = buildContainerArgs({ engineId: engine.id, policy, input, containerName, hostRoot, workerEntry });
  const child = spawnImpl("docker", args, {
    env: { PATH: process.env.PATH || "", ...credentials },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let closed = false;

  const finish = (payload) => {
    if (closed) return;
    closed = true;
    input.onClose?.(payload);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let index;
    while ((index = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      handleProtocolLine(line, input, finish);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16000); });
  child.on("error", (error) => input.onError?.(error));
  child.on("close", (code) => {
    if (stdout) handleProtocolLine(stdout, input, finish);
    if (!closed) finish({ code: code || 1, stderr: stderr.trim() || `container runner exited with code ${code}`, usage: null, engineSessionId: null });
  });
  // Callbacks and the tool bridge stay on this side; the worker re-attaches its own.
  const wireInput = { ...input };
  for (const key of ["onLine", "onPartialText", "onStatus", "onClose", "onError", "tools"]) delete wireInput[key];
  child.stdin.end(JSON.stringify(wireInput));
  return {
    pid: child.pid,
    containerName,
    kill(signal = "SIGTERM") {
      spawnSyncImpl("docker", ["kill", "--signal", signal, containerName], { stdio: "ignore", timeout: 10000 });
      child.kill(signal);
    }
  };
}

function handleProtocolLine(line, input, finish) {
  if (!line.startsWith(PROTOCOL)) {
    if (line) input.onLine?.(line);
    return;
  }
  try {
    const event = JSON.parse(line.slice(PROTOCOL.length));
    if (event.type === "line") input.onLine?.(event.value);
    else if (event.type === "partial") input.onPartialText?.(event.value);
    else if (event.type === "status") input.onStatus?.(event.value);
    else if (event.type === "error") input.onError?.(new Error(event.value));
    else if (event.type === "close") finish(event.value);
  } catch (error) {
    input.onError?.(new Error(`invalid container runner event: ${error.message}`));
  }
}

function containerCredentialEnv(profile = {}) {
  const routed = anthropicRouteEnv(profile);
  const stored = secretEnvForRunner(profile);
  const ambientName = profile.provider === "openai" ? "OPENAI_API_KEY"
    : profile.provider === "anthropic" ? "ANTHROPIC_API_KEY"
      : profile.provider === "glm" ? "GLM_API_KEY"
        : profile.provider === "kimi" ? "MOONSHOT_API_KEY"
          : profile.provider === "openrouter" ? "OPENROUTER_API_KEY" : "";
  return {
    ...stored,
    ...routed,
    ...(ambientName && process.env[ambientName] ? { [ambientName]: process.env[ambientName] } : {})
  };
}

function requiresApiCredential(profile = {}) {
  return ["openai", "anthropic", "glm", "kimi", "openrouter"].includes(String(profile.provider || ""));
}

function realpathOr(file) {
  try { return realpathSync(file); } catch { return file; }
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export { PROTOCOL };
