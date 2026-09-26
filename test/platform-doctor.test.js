import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { platformDoctor, formatPlatformDoctor } from "../src/platform-doctor.js";
import { assertKnowledgePlatform } from "../src/platform.js";
import { knowledgeSandboxArgs } from "../src/knowledge-process.js";
import { readKnowledgeSource } from "../src/workspace-knowledge.js";

const available = { sandbox: true, qmd: true, docling: true };
const report = (platform, extra = {}) => platformDoctor({ platform, arch: "x64", node: "24.14.0",
  installation: available, hasDescriptorReads: true, wsl: { detected: false }, ...extra });

test("Windows, macOS and unknown OS cannot report Linux-only capabilities ready", () => {
  for (const platform of ["win32", "darwin", "freebsd"]) {
    const result = report(platform);
    for (const name of ["knowledgeRead", "knowledgeSearch", "officeParsing", "codexBoundary"]) {
      assert.equal(result.capabilities[name].status, "unavailable");
    }
    assert.equal(result.capabilities.desktop.status, "build-verification-required");
  }
});

test("doctor distinguishes prerequisites from actual live verification", () => {
  assert.equal(report("linux").capabilities.knowledgeSearch.status, "prerequisites-present");
  assert.match(formatPlatformDoctor(report("linux")), /does not mean live verified/);
  for (const extra of [{ node: "20.0.0" }, { hasDescriptorReads: false },
    { installation: { ...available, qmd: false } }, { installation: { ...available, sandbox: false } }]) {
    assert.equal(report("linux", extra).capabilities.knowledgeSearch.status, "unavailable");
  }
  assert.equal(report("linux", { installation: { ...available, docling: false } }).capabilities.officeParsing.status, "unavailable");
});

test("knowledge sandbox never falls back to unsandboxed execution", () => {
  assert.throws(() => knowledgeSandboxArgs({ installation: { sandbox: false }, kind: "qmd" }), /No unsandboxed fallback/);
  if (process.platform === "linux") assert.doesNotThrow(assertKnowledgePlatform);
  else {
    assert.throws(assertKnowledgePlatform, /no unsandboxed fallback/);
    // Reject before touching a filesystem path, including on native Windows CI.
    assert.throws(() => readKnowledgeSource("not-a-directory", "file.md"), /no unsandboxed fallback/);
  }
});

test("doctor CLI emits versioned JSON without a workspace or credentials", () => {
  const result = spawnSync(process.execPath,
    [fileURLToPath(new URL("../bin/crewrun.js", import.meta.url)), "doctor", "--json"],
    { encoding: "utf8", timeout: 20000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.platform.platform, process.platform);
  assert.equal(output.capabilities.desktop.status, "build-verification-required");
});
