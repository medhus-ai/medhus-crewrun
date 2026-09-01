import os from "node:os";
import path from "node:path";

// Host configuration. Defaults are neutral (`.crew`, `CREW_*` env); a host calls configureCrew()
// once, before its first use of the runtime, to brand the state directory and accept its own
// legacy environment prefix. CREW_DIR_NAME still seeds the default for hosts that prefer env.
const config = {
  dirName: process.env.CREW_DIR_NAME || ".crew",
  legacyEnvPrefix: ""
};

export function configureCrew({ dirName, legacyEnvPrefix } = {}) {
  if (dirName !== undefined) {
    const name = String(dirName || "").trim();
    if (!/^\.?[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error(`invalid crew directory name: ${dirName}`);
    config.dirName = name;
  }
  if (legacyEnvPrefix !== undefined) config.legacyEnvPrefix = String(legacyEnvPrefix || "").replace(/_+$/, "");
  return { ...config };
}

// Directory name for per-project crew state (roles/, memory/, skills/).
export function crewDir() {
  return config.dirName;
}

// Host-neutral env lookup: CREW_<name> first, then the host's legacy prefix if it configured one.
export function crewEnv(name, env = process.env) {
  const value = env[`CREW_${name}`];
  if (value !== undefined) return value;
  return config.legacyEnvPrefix ? env[`${config.legacyEnvPrefix}_${name}`] : undefined;
}

// Env names to publish for a value: CREW_<name>, plus the host's legacy name when configured,
// so wrapper scripts written against a host's older prefix keep working.
export function crewEnvNames(name) {
  return config.legacyEnvPrefix ? [`CREW_${name}`, `${config.legacyEnvPrefix}_${name}`] : [`CREW_${name}`];
}

// Per-file env overrides (CREW_SECRETS_FILE, CREW_RUNNERS_FILE, ...) take precedence over this base.
export function crewHome(env = process.env) {
  return path.resolve(crewEnv("HOME", env) || path.join(os.homedir(), crewDir()));
}
