import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { containerRuntimeStatus, normalizeExecutionPolicy, readExecutionPolicy, setExecutionPolicy } from "../src/execution-policy.js";
import { buildContainerArgs } from "../src/engines/container.js";

test("execution policy persists bounded container settings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "crew-execution-"));
  const saved = setExecutionPolicy(root, { runtime: "container", image: "node:20", network: "none", cpus: 100, memoryMb: 128, pidsLimit: 9 });
  assert.equal(saved.cpus, 32);
  assert.equal(saved.memoryMb, 256);
  assert.equal(saved.pidsLimit, 32);
  assert.deepEqual(readExecutionPolicy(root), saved);
  assert.throws(() => normalizeExecutionPolicy({ runtime: "vm" }), /unsupported/);
});

test("container runner drops privileges and mounts only repo, git metadata, and worktree", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "crew-container-root-"));
  const workdir = mkdtempSync(path.join(os.tmpdir(), "crew-container-work-"));
  mkdirSync(path.join(root, ".git"));
  const policy = normalizeExecutionPolicy({ runtime: "container", network: "none" });
  const args = buildContainerArgs({
    engineId: "codex-agent",
    policy,
    containerName: "crew-test",
    input: { targetRoot: root, workdir, profile: { provider: "openai" } }
  });
  assert.deepEqual(args.slice(0, 6), ["run", "--rm", "-i", "--init", "--name", "crew-test"]);
  assert.equal(args.includes("--read-only"), true);
  assert.equal(args.includes("no-new-privileges"), true);
  assert.equal(args.includes("ALL"), true);
  assert.equal(args.includes("none"), true);
  assert.equal(args.some((arg) => arg.includes(`src=${workdir},dst=${workdir}`)), true);
  assert.equal(args.some((arg) => arg.includes("/home/bharathc/.crew")), false);
});

test("container runtime preflight verifies the exact repository bind mount", () => {
  const calls = [];
  const targetRoot = mkdtempSync(path.join(os.tmpdir(), "crew-container-probe-"));
  const status = containerRuntimeStatus({
    targetRoot,
    image: "node:20",
    probeMount: true,
    spawn(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: calls.length === 1 ? "27.0.0\n" : "", stderr: "" };
    }
  });
  assert.equal(status.ready, true);
  assert.equal(status.mountReady, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes(`type=bind,src=${path.resolve(targetRoot)},dst=/crew-probe,readonly`));
});
