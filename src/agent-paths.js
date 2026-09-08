import path from "node:path";
import { crewDir } from "./crew-dirs.js";
import { resolveWorkspacePath } from "./workspace-manifest.js";

// v6 definitions have one location. Markdown is context, not an agent definition.
export function agentDirectories(root) {
  return [path.join(path.resolve(root), crewDir(), "agents")];
}

export function agentFile(root, name, extension = "json") {
  if (!/^(?:_defaults|[a-z][a-z0-9-]{0,79})$/.test(String(name))) throw new Error("invalid agent name");
  if (!["json", "md"].includes(extension)) throw new Error("invalid agent file type");
  const file = path.join(agentDirectories(root)[0], `${name}.${extension}`);
  return resolveWorkspacePath(root, path.relative(path.resolve(root), file).split(path.sep).join("/"));
}
