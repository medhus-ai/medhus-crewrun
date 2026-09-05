import { existsSync } from "node:fs";
import path from "node:path";
import { crewDir } from "./crew-dirs.js";

// New projects use agents/. Resolve existing files in place so upgrades never
// hide a legacy agent, duplicate its schedules, or discard its shared defaults.
export function agentDirectories(root) {
  return ["agents", "roles"].map((name) => path.join(path.resolve(root), crewDir(), name));
}

export function agentFile(root, name, extension = "json") {
  if (!/^(?:_defaults|[a-z][a-z0-9-]{0,79})$/.test(String(name))) throw new Error("invalid agent name");
  if (!["json", "md"].includes(extension)) throw new Error("invalid agent file type");
  const dirs = agentDirectories(root);
  const existing = dirs.find((dir) => existsSync(path.join(dir, `${name}.${extension}`)));
  const owner = existing || dirs.find((dir) => existsSync(path.join(dir, `${name}.json`)) || existsSync(path.join(dir, `${name}.md`)))
    || (existsSync(dirs[1]) && !existsSync(dirs[0]) ? dirs[1] : dirs[0]);
  return path.join(owner, `${name}.${extension}`);
}
