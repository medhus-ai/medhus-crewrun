import os from "node:os";
import path from "node:path";

// v6 workspace paths and environment names are portable across hosts.
export function crewDir() { return ".crew"; }
export function crewEnv(name, env = process.env) { return env[`CREW_${name}`]; }
export function crewEnvNames(name) { return [`CREW_${name}`]; }
export function crewHome(env = process.env) {
  return path.resolve(crewEnv("HOME", env) || path.join(os.homedir(), crewDir()));
}
