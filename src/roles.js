import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { agentDirectories, agentFile } from "./agent-paths.js";
import { crewDir } from "./crew-dirs.js";

const SLUG = /^[a-z][a-z0-9-]*$/;

// Installs role prompt files from a templates directory into <target>/<crewDir()>/roles.
// Hosts decide which roles are always present, how to generate a role without a template,
// and what else to record when a role is installed or archived.
export function createRoleCatalog({
  templatesDir,
  legacyPaths = true,
  alwaysPresent = [],
  generate = null,
  onInstalled = null,
  onRemoved = null,
  cliName = "crew"
} = {}) {
  const always = new Set(alwaysPresent);
  const catalogFile = (root, name) => legacyPaths && !existsSync(path.join(root, crewDir(), "agents")) ? path.join(root, crewDir(), "roles", `${name}.md`) : agentFile(root, name, "md");

  async function installedRoleNames(target) {
    const names = new Set();
    for (const dir of agentDirectories(target)) {
      try {
        const entries = await readdir(dir);
        for (const file of entries) if (file.endsWith(".md")) names.add(file.slice(0, -3));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return names;
  }

  async function templateRoleNames() {
    try {
      const entries = await readdir(templatesDir);
      return entries
        .filter((f) => f.endsWith(".md") && !f.endsWith(".template.md"))
        .map((f) => f.slice(0, -3))
        .filter((name) => !always.has(name));
    } catch {
      return [];
    }
  }

  async function listRoles({ target }) {
    const installed = await installedRoleNames(target);
    const available = await templateRoleNames();
    return {
      target: path.resolve(target),
      installed: [...installed].sort(),
      available: available.filter((name) => !installed.has(name)).sort()
    };
  }

  async function addRole({ target, name, ...options }) {
    if (!name) throw new Error("roles add requires --name <slug>");
    if (!SLUG.test(name)) throw new Error("role name must be a lowercase slug like physics-specialist");
    if (always.has(name)) throw new Error(`${name} is always-present and is installed by ${cliName} init; nothing to add`);
    const template = await readMaybe(path.join(templatesDir, `${name}.md`));
    const content = template ?? (generate ? await generate({ name, ...options }) : null);
    if (content == null) throw new Error(`unknown role ${name}; check ${cliName} roles list for the catalog`);
    const root = path.resolve(target);
    const destDir = path.dirname(catalogFile(root, name));
    const destPath = path.join(destDir, `${name}.md`);
    if (await exists(destPath)) {
      await onInstalled?.(root, name, options);
      return { target: root, name, action: "already-installed", path: destPath };
    }
    await mkdir(destDir, { recursive: true });
    await writeFile(destPath, content, "utf8");
    await onInstalled?.(root, name, options);
    return { target: root, name, action: "added", path: destPath };
  }

  async function removeRole({ target, name }) {
    if (!name) throw new Error("roles remove requires --name <slug>");
    if (!SLUG.test(name)) throw new Error("role name must be a lowercase slug like physics-specialist");
    if (always.has(name)) throw new Error(`${name} is always-present and cannot be removed via this command`);
    const root = path.resolve(target);
    const sourcePath = catalogFile(root, name);
    if (!await exists(sourcePath)) return { target: root, name, action: "not-installed" };
    const archiveDir = path.join(path.dirname(sourcePath), "_archived");
    await mkdir(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${name}-${new Date().toISOString().slice(0, 10)}.md`);
    await rename(sourcePath, archivePath);
    await onRemoved?.(root, name);
    return { target: root, name, action: "archived", path: archivePath };
  }

  return { listAgents: listRoles, addAgent: addRole, removeAgent: removeRole, installedAgentNames: installedRoleNames, listRoles, addRole, removeRole, installedRoleNames, isAlwaysPresent: (name) => always.has(name) };
}

async function readMaybe(file) {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}
