import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { crewDir } from "./crew-dirs.js";

const DEFAULTS = Object.freeze({
  runtime: "worktree",
  image: "node:20-bookworm",
  network: "bridge",
  cpus: 2,
  memoryMb: 4096,
  pidsLimit: 256
});

export function executionPolicyPath(root) {
  return path.join(path.resolve(root), crewDir(), "memory", "execution.json");
}

export function readExecutionPolicy(root) {
  try {
    return normalizeExecutionPolicy(JSON.parse(readFileSync(executionPolicyPath(root), "utf8")));
  } catch {
    return { ...DEFAULTS };
  }
}

export function setExecutionPolicy(root, input = {}) {
  const policy = normalizeExecutionPolicy(input);
  const file = executionPolicyPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return policy;
}

export function normalizeExecutionPolicy(input = {}) {
  const runtime = String(input.runtime || DEFAULTS.runtime).trim().toLowerCase();
  if (!["worktree", "container"].includes(runtime)) throw new Error(`unsupported execution runtime: ${runtime}`);
  const image = String(input.image || DEFAULTS.image).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/.test(image)) throw new Error("container image is invalid");
  const network = String(input.network || DEFAULTS.network).trim().toLowerCase();
  if (!["none", "bridge"].includes(network)) throw new Error("container network must be none or bridge");
  return {
    runtime,
    image,
    network,
    cpus: boundedNumber(input.cpus, DEFAULTS.cpus, 0.25, 32),
    memoryMb: boundedInteger(input.memoryMb ?? input.memory_mb, DEFAULTS.memoryMb, 256, 65536),
    pidsLimit: boundedInteger(input.pidsLimit ?? input.pids_limit, DEFAULTS.pidsLimit, 32, 4096)
  };
}

export function containerRuntimeStatus({ spawn = spawnSync, targetRoot = "", image = DEFAULTS.image, probeMount = false } = {}) {
  const result = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 8000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    return { ready: false, daemonReady: false, mountReady: null, version: "", error: String(result.stderr || result.error?.message || "Docker daemon is unavailable").trim() };
  }
  const version = String(result.stdout || "").trim();
  if (!probeMount || !targetRoot) {
    return { ready: true, daemonReady: true, mountReady: null, version, error: "" };
  }
  const root = path.resolve(targetRoot);
  const mount = spawn("docker", [
    "run", "--rm",
    "--mount", `type=bind,src=${root},dst=/crew-probe,readonly`,
    image,
    "node", "-e", "require('fs').accessSync('/crew-probe', require('fs').constants.R_OK)"
  ], {
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return mount.status === 0
    ? { ready: true, daemonReady: true, mountReady: true, version, error: "" }
    : {
        ready: false,
        daemonReady: true,
        mountReady: false,
        version,
        error: String(mount.stderr || mount.error?.message || `Docker could not bind-mount ${root}`).trim()
      };
}

function boundedInteger(value, fallback, min, max) {
  return Math.round(boundedNumber(value, fallback, min, max));
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
