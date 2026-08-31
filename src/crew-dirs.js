import os from "node:os";
import path from "node:path";

// Directory name for per-project crew state. The first consumer (GitCrew) fixed it as
// `.gitcrew`; another host sets CREW_DIR_NAME before its first import to use its own name.
export const CREW_DIR = process.env.CREW_DIR_NAME || ".gitcrew";

// Host-neutral env lookup: CREW_<name> wins; GITCREW_<name> keeps existing installs working.
export function crewEnv(name, env = process.env) {
  return env[`CREW_${name}`] ?? env[`GITCREW_${name}`];
}

// Per-file env overrides (CREW_SECRETS_FILE, CREW_RUNNERS_FILE, ...) take precedence over this base.
export function crewHome(env = process.env) {
  return path.resolve(crewEnv("HOME", env) || path.join(os.homedir(), CREW_DIR));
}
