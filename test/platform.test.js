import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isPidRunning,
  knownToolDirs,
  nodeVersionInfo,
  platformInfo,
  resolveExecutable,
  terminatePid,
  terminateProcessGroup,
  toolEnv,
  wslFilesystemInfo,
  wslInfo
} from "../src/platform.js";

test("platformInfo treats Linux, macOS, and native Windows as supported", () => {
  assert.equal(platformInfo({ platform: "linux", arch: "x64" }).supported, true);
  assert.equal(platformInfo({ platform: "darwin", arch: "arm64" }).supported, true);
  assert.equal(platformInfo({ platform: "win32", arch: "x64" }).supported, true);
  assert.equal(platformInfo({ platform: "win32", arch: "x64" }).experimental, false);
});

test("nodeVersionInfo enforces Node 20+", () => {
  assert.equal(nodeVersionInfo("20.0.0").supported, true);
  assert.equal(nodeVersionInfo("18.19.0").supported, false);
});

test("wslInfo distinguishes WSL2 and flags Windows-mounted workspaces", () => {
  const info = wslInfo({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/1_interop" },
    kernelRelease: "5.15.0-microsoft-standard-WSL2",
    procVersion: "Linux version"
  });
  assert.equal(info.detected, true);
  assert.equal(info.version, 2);
  assert.equal(wslFilesystemInfo("/mnt/c/work/repo", info).recommended, false);
  assert.equal(wslFilesystemInfo("/home/user/repo", info).recommended, true);
});

test("wslInfo identifies WSL1 as unsupported for container execution", () => {
  const info = wslInfo({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    kernelRelease: "4.4.0-Microsoft",
    procVersion: "Microsoft"
  });
  assert.equal(info.version, 1);
  assert.match(info.message, /requires WSL2/);
});

test("resolveExecutable scans PATH without invoking a shell", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crew-platform-"));
  const file = await writeFakeExecutable(dir, "demo-tool");

  const result = resolveExecutable("demo-tool", { env: { PATH: dir } });

  assert.equal(result.available, true);
  assert.equal(result.path, file);
  assert.equal(result.via, "PATH");
});

test("resolveExecutable scans known extra tool dirs after PATH", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crew-platform-known-"));
  const file = await writeFakeExecutable(dir, "known-tool");

  const result = resolveExecutable("known-tool", { env: { PATH: "", CREW_EXTRA_PATH: dir } });

  assert.equal(result.available, true);
  assert.equal(result.path, file);
  assert.equal(result.via, "known location (not on this process PATH)");
});

test("resolveExecutable honors Windows PATHEXT without Unix execute bits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crew-platform-win-"));
  const file = path.join(dir, "demo-tool.CMD");
  await writeFile(file, "@echo off\r\nexit /b 0\r\n", "utf8");

  const result = resolveExecutable("demo-tool", {
    env: { PATH: dir, PATHEXT: ".CMD" },
    platform: "win32"
  });

  assert.equal(result.available, true);
  assert.equal(result.path, file);
});

test("knownToolDirs includes standard native Windows package-manager locations", () => {
  const dirs = knownToolDirs({
    platform: "win32",
    env: {
      USERPROFILE: "C:\\Users\\dev",
      APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
      NVM_HOME: "C:\\nvm",
      SCOOP: "C:\\Users\\dev\\scoop",
      ChocolateyInstall: "C:\\ProgramData\\chocolatey"
    }
  });

  assert.ok(dirs.includes("C:\\Users\\dev\\AppData\\Roaming\\npm"));
  assert.ok(dirs.includes("C:\\Program Files\\nodejs"));
  assert.ok(dirs.includes("C:\\nvm"));
  assert.ok(dirs.includes("C:\\Users\\dev\\scoop\\shims"));
  assert.ok(dirs.includes("C:\\ProgramData\\chocolatey\\bin"));
});

test("toolEnv keeps the current Node binary available", () => {
  const env = toolEnv({ PATH: "" });
  assert.ok(env.PATH.split(path.delimiter).includes(path.dirname(process.execPath)));
});

test("process helpers detect live and invalid pids", () => {
  assert.equal(isPidRunning(process.pid), true);
  assert.equal(isPidRunning(2 ** 30), false);
});

test("terminatePid stops a child process", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  try {
    assert.equal(isPidRunning(child.pid), true);
    assert.equal(terminatePid(child.pid), true);
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(isPidRunning(child.pid), false);
  } finally {
    if (isPidRunning(child.pid)) child.kill("SIGKILL");
  }
});

async function writeFakeExecutable(dir, name) {
  const file = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  const content = process.platform === "win32"
    ? "@echo off\r\nexit /b 0\r\n"
    : "#!/usr/bin/env node\n";
  await writeFile(file, content, "utf8");
  if (process.platform !== "win32") await chmod(file, 0o755);
  return file;
}

test("terminateProcessGroup stops a detached child process group", {
  skip: process.platform === "win32" || process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP
    ? "native Windows and WSL do not launch detached Node processes"
    : false
}, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  try {
    assert.equal(isPidRunning(child.pid), true);
    assert.equal(terminateProcessGroup(child.pid), true);
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(isPidRunning(child.pid), false);
  } finally {
    if (isPidRunning(child.pid)) child.kill("SIGKILL");
  }
});
