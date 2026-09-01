import { accessSync, constants as fsConstants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SUPPORTED_PLATFORMS = new Set(["linux", "darwin", "win32"]);
const MIN_NODE_MAJOR = 20;

export function platformInfo({ platform = process.platform, arch = process.arch } = {}) {
  const label = platform === "darwin" ? "macOS"
    : platform === "linux" ? "Linux"
      : platform === "win32" ? "Windows"
        : platform;
  return {
    platform,
    arch,
    label,
    supported: SUPPORTED_PLATFORMS.has(platform),
    experimental: false,
    message: SUPPORTED_PLATFORMS.has(platform)
      ? `${label} ${arch} is supported`
      : `${label} ${arch} is not a supported platform yet`
  };
}

export function wslInfo({ platform = process.platform, env = process.env, kernelRelease = os.release(), procVersion } = {}) {
  const versionText = procVersion === undefined ? readProcVersion() : String(procVersion || "");
  const signature = `${kernelRelease || ""} ${versionText}`.toLowerCase();
  const detected = platform === "linux" && Boolean(
    env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft|wsl/.test(signature)
  );
  const version = !detected ? null
    : /microsoft-standard|wsl2/.test(signature) ? 2
      : /microsoft/.test(signature) ? 1 : null;
  return {
    detected,
    version,
    distro: detected ? String(env.WSL_DISTRO_NAME || "").trim() : "",
    message: !detected
      ? "not running under WSL"
      : version === 2
        ? `WSL2${env.WSL_DISTRO_NAME ? ` (${env.WSL_DISTRO_NAME})` : ""} detected`
        : version === 1
          ? "WSL1 detected; container execution requires WSL2"
          : "WSL detected but its version could not be confirmed"
  };
}

export function wslFilesystemInfo(location, info = wslInfo()) {
  const input = String(location || process.cwd());
  const resolved = info.detected && input.startsWith("/")
    ? path.posix.resolve(input)
    : path.resolve(input);
  const windowsMount = info.detected && /^\/mnt\/[a-z](?:\/|$)/i.test(resolved);
  return {
    path: resolved,
    windowsMount,
    recommended: !windowsMount,
    message: windowsMount
      ? `${resolved} is on a Windows-mounted filesystem; move workspaces under /home/<user> for reliable Git, file events, and container mounts`
      : info.detected
        ? `${resolved} is on the WSL Linux filesystem`
        : `${resolved} is not a WSL Windows-mounted path`
  };
}

function readProcVersion() {
  try { return readFileSync("/proc/version", "utf8"); } catch { return ""; }
}

export function nodeVersionInfo(version = process.versions.node) {
  const major = Number(String(version || "").split(".")[0]);
  const supported = Number.isInteger(major) && major >= MIN_NODE_MAJOR;
  return {
    version,
    major,
    supported,
    message: supported
      ? `Node ${version} satisfies >=${MIN_NODE_MAJOR}`
      : `Node ${version || "(unknown)"} is too old; install Node ${MIN_NODE_MAJOR}+`
  };
}

export function knownToolDirs({ env = process.env, platform = process.platform } = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const home = platform === "win32"
    ? env.USERPROFILE || os.homedir()
    : env.HOME || os.homedir();
  const root = pathApi.parse(home || process.cwd()).root || pathApi.sep;
  const dirs = [];
  const add = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };

  add(path.dirname(process.execPath));
  add(pathApi.join(home, ".local", "bin"));
  add(pathApi.join(home, ".claude", "local"));
  add(pathApi.join(home, "bin"));
  add(pathApi.join(home, ".bun", "bin"));
  add(pathApi.join(home, ".codex", "bin"));
  add(pathApi.join(home, ".npm-global", "bin"));

  const nvmVersions = pathApi.join(home, ".nvm", "versions", "node");
  try {
    for (const version of readdirSync(nvmVersions)) {
      add(pathApi.join(nvmVersions, version, "bin"));
    }
  } catch {
    // nvm is optional.
  }

  if (platform === "darwin") {
    add(pathApi.join(root, "opt", "homebrew", "bin"));
    add(pathApi.join(root, "usr", "local", "bin"));
  } else if (platform === "linux") {
    add(pathApi.join(root, "usr", "local", "bin"));
  } else if (platform === "win32") {
    const appData = env.APPDATA || pathApi.join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA || pathApi.join(home, "AppData", "Local");
    add(pathApi.join(appData, "npm"));
    add(pathApi.join(env.ProgramFiles || "C:\\Program Files", "nodejs"));
    add(pathApi.join(localAppData, "Programs", "nodejs"));
    add(env.NVM_HOME);
    add(pathApi.join(env.SCOOP || pathApi.join(home, "scoop"), "shims"));
    add(pathApi.join(env.ChocolateyInstall || "C:\\ProgramData\\chocolatey", "bin"));
  }

  for (const dir of splitPath(env.CREW_EXTRA_PATH || env.GITCREW_EXTRA_PATH, platform)) add(dir);
  return dirs.filter(Boolean);
}

export function toolEnv(env = process.env) {
  const parts = [];
  const add = (dir) => {
    if (dir && !parts.includes(dir)) parts.push(dir);
  };
  add(path.dirname(process.execPath));
  for (const dir of splitPath(env.PATH)) add(dir);
  for (const dir of knownToolDirs({ env })) add(dir);
  return {
    ...env,
    PATH: parts.join(path.delimiter)
  };
}

export function resolveExecutable(command, { env = process.env, extraDirs = [], platform = process.platform } = {}) {
  const value = String(command || "").trim();
  if (!value) {
    return { command: value, available: false, path: "", via: "", error: "empty command" };
  }

  if (looksLikePath(value, platform)) {
    const match = resolveCandidate(value, { env, platform });
    return match
      ? { command: value, available: true, path: match, via: "path", error: "" }
      : { command: value, available: false, path: "", via: "", error: `${value} is not executable` };
  }

  const pathDirs = splitPath(env.PATH, platform);
  for (const dir of pathDirs) {
    const match = resolveCandidate(path.join(dir, value), { env, platform });
    if (match) return { command: value, available: true, path: match, via: "PATH", error: "" };
  }

  for (const dir of [...extraDirs, ...knownToolDirs({ env, platform })]) {
    if (pathDirs.includes(dir)) continue;
    const match = resolveCandidate(path.join(dir, value), { env, platform });
    if (match) return { command: value, available: true, path: match, via: "known location (not on this process PATH)", error: "" };
  }

  return { command: value, available: false, path: "", via: "", error: `${value} not found` };
}

export function isPidRunning(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function terminatePid(pid, signal = "SIGTERM") {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, signal);
    return true;
  } catch {
    return false;
  }
}

export function terminateProcessGroup(pid, signal = "SIGTERM") {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(-value, signal);
      return true;
    } catch {
      // Fall back to the direct process below.
    }
  }
  return terminatePid(value, signal);
}

function splitPath(value, platform = process.platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  return String(value || "").split(delimiter).map((item) => item.trim()).filter(Boolean);
}

function looksLikePath(value, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.isAbsolute(value) || value.includes(pathApi.sep) || (platform === "win32" && value.includes("/"));
}

function resolveCandidate(candidate, options) {
  for (const file of [...nativeWindowsCliCandidates(candidate, options), ...candidateNames(candidate, options)]) {
    if (isExecutableFile(file, options?.platform)) return actualFileCase(file, options?.platform);
  }
  return "";
}

// npm's .cmd shims for claude/codex wrap a native .exe; spawning the .exe directly avoids the
// cmd.exe hop and its quoting rules.
function nativeWindowsCliCandidates(candidate, { platform = process.platform } = {}) {
  if (platform !== "win32") return [];
  const extension = path.extname(candidate).toLowerCase();
  if (extension && extension !== ".cmd" && extension !== ".bat") return [];
  const stem = extension ? candidate.slice(0, -extension.length) : candidate;
  const command = path.basename(stem).toLowerCase();
  if (command !== "claude" && command !== "codex") return [];

  const binDir = path.dirname(stem);
  const moduleRoots = [path.resolve(binDir, ".."), path.join(binDir, "node_modules")];
  if (command === "claude") {
    return moduleRoots.map((root) => path.join(root, "@anthropic-ai", "claude-code", "bin", "claude.exe"));
  }

  const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const packageName = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  return moduleRoots.map((root) => path.join(
    root, "@openai", packageName, "vendor", target, "bin", "codex.exe"
  ));
}

function actualFileCase(file, platform = process.platform) {
  if (platform !== "win32") return file;
  try {
    const directory = path.dirname(file);
    const name = path.basename(file);
    const actual = readdirSync(directory).find((entry) => entry.toLowerCase() === name.toLowerCase());
    return actual ? path.join(directory, actual) : file;
  } catch {
    return file;
  }
}

function candidateNames(candidate, { env = process.env, platform = process.platform } = {}) {
  if (platform !== "win32") return [candidate];
  const ext = path.extname(candidate);
  if (ext) return [candidate];
  const pathext = String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  // npm installs both POSIX shims and Windows launchers in node_modules/.bin.
  // Prefer PATHEXT launchers so spawn/execFile never selects an extensionless
  // shell script that Windows cannot execute directly. Both suffix cases are
  // tried so the lookup also works on a case-sensitive filesystem.
  const suffixes = [...new Set(pathext.flatMap((suffix) => [suffix.toLowerCase(), suffix]))];
  return [...suffixes.map((suffix) => `${candidate}${suffix}`), candidate];
}

function isExecutableFile(file, platform = process.platform) {
  try {
    const info = statSync(file);
    if (!info.isFile()) return false;
    accessSync(file, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
