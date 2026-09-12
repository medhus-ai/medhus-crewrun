import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, chmod, readFile, writeFile, readdir, lstat, readlink, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { validateIntegrationPlugin } from "@medhus-ai/crewrun-plugin-sdk";
import { crewHome } from "./crew-dirs.js";

const runFile = promisify(execFile);
const PINNED = /^(@[a-z0-9-]+\/[a-z0-9._-]+|[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/;
const pluginHome = (env) => path.join(crewHome(env), "plugins");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

async function records(env) {
  try { return await readJson(path.join(pluginHome(env), "installed.json")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export async function listInstalledPlugins({ env = process.env } = {}) {
  return (await records(env)).map(({ id, name, version, source, digest }) => ({ id, name, version, source, digest }));
}

// Hash the installed tree, including dependencies. Internal npm bin symlinks are allowed;
// links outside the snapshot are not. This is tamper detection, NOT a JavaScript sandbox.
async function treeDigest(root) {
  if (!(await lstat(root)).isDirectory()) throw new Error("Plugin snapshot must be a private directory, not a link.");
  const hash = createHash("sha256");
  async function walk(relative = "") {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const entry = path.join(relative, name);
      const file = path.join(root, entry);
      const info = await lstat(file);
      hash.update(JSON.stringify([entry, info.mode & 0o777]));
      if (info.isSymbolicLink()) {
        const target = await realpath(file);
        if (!target.startsWith(root + path.sep)) throw new Error("Plugin snapshot contains an external symlink.");
        hash.update(await readlink(file));
      } else if (info.isDirectory()) await walk(entry);
      else if (info.isFile()) {
        hash.update(String(info.size) + ":");
        hash.update(await readFile(file));
      } else throw new Error("Plugin snapshot contains a non-file entry.");
    }
  }
  await walk();
  return hash.digest("hex");
}

function snapshotPath(base, directory) {
  if (!/^[a-f0-9-]{36}$/.test(directory)) throw new Error("Invalid installed plugin record.");
  return path.join(base, directory);
}

async function importPackage(root, name) {
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error("Invalid plugin package name.");
  const require = createRequire(path.join(root, "package.json"));
  const entry = require.resolve(name);
  if (!(await realpath(entry)).startsWith(root + path.sep)) throw new Error("Plugin entry is outside its installation.");
  const module = await import(pathToFileURL(entry).href);
  return validateIntegrationPlugin(module.default);
}

export async function loadInstalledPlugins({ env = process.env } = {}) {
  const plugins = [];
  for (const record of await records(env)) {
    const root = snapshotPath(pluginHome(env), record.directory);
    if (await treeDigest(root) !== record.digest) throw new Error(`Installed plugin ${record.id} changed. Reinstall it after owner review.`);
    const plugin = await importPackage(root, record.name);
    if (plugin.id !== record.id) throw new Error("Installed plugin identity changed.");
    plugins.push(plugin);
  }
  return plugins;
}

// Installation is only exposed in the operator CLI, never through agent/helper tools.
// npm lifecycle scripts are disabled; importing the explicitly trusted plugin still executes JS.
export async function installIntegrationPlugin(source, { trust = false, env = process.env } = {}) {
  if (!trust) throw new Error("Review the package and dependencies, then pass --trust. Plugins execute with host privileges.");
  const pinned = String(source || "").match(PINNED);
  const local = !pinned && /^(\/|\.\.?\/)/.test(String(source || "")) ? await realpath(source) : "";
  if (!pinned && !local) throw new Error("Use an exact npm package@1.2.3 version or an explicit local directory.");
  const metadata = local ? await readJson(path.join(local, "package.json")) : { name: pinned[1], version: pinned[2] };
  if (!PINNED.test(`${metadata.name}@${metadata.version}`)) throw new Error("Plugin package needs a valid name and exact version.");
  const base = pluginHome(env);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  const lock = path.join(base, ".install-lock");
  try { await mkdir(lock); } catch (error) {
    if (error.code === "EEXIST") throw new Error("Another plugin install is active. If it crashed, remove only the private plugins/.install-lock directory after checking no install is running.");
    throw error;
  }
  const directory = randomUUID();
  const root = path.join(base, directory);
  let committed = false;
  try {
    await mkdir(root, { mode: 0o700 });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "crewrun-private-plugins", version: "1.0.0", private: true, type: "module" }), { mode: 0o600 });
    let installSource = source;
    const npmOptions = { cwd: root, env: { ...process.env, ...env }, timeout: 120_000, maxBuffer: 2_000_000 };
    if (local) {
      const packed = await runFile("npm", ["pack", local, "--ignore-scripts", "--json", "--pack-destination", root], npmOptions);
      const name = JSON.parse(packed.stdout)[0]?.filename;
      if (!name || path.basename(name) !== name || !name.endsWith(".tgz")) throw new Error("npm returned an invalid package archive.");
      installSource = path.join(root, name);
    }
    await runFile("npm", ["install", "--ignore-scripts", "--omit=dev", "--save-exact", "--no-audit", "--no-fund", "--", installSource], npmOptions);
    const plugin = await importPackage(root, metadata.name);
    if (["slack", "google-workspace", "microsoft365", "github"].includes(plugin.id)) throw new Error("Installed plugins cannot replace bundled provider identities.");
    const record = { id: plugin.id, name: metadata.name, version: metadata.version, source: local || source, directory, digest: await treeDigest(root) };
    const current = await records(env);
    // Keep older snapshots for rollback, but only the new pointer is loaded at next startup.
    const next = [...current.filter((item) => item.id !== plugin.id), record];
    const pending = path.join(base, "installed.pending.json");
    await writeFile(pending, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await rename(pending, path.join(base, "installed.json"));
    committed = true;
    return { id: record.id, name: record.name, version: record.version, digest: record.digest };
  } finally {
    if (!committed) await rm(root, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

export async function scaffoldIntegrationPlugin(destination, { id = "example" } = {}) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("Choose a lowercase plugin id.");
  const root = path.resolve(destination);
  await mkdir(root); // Never overwrite an existing project.
  const manifest = { name: `crewrun-plugin-${id}`, version: "0.1.0", type: "module", exports: "./index.js", files: ["index.js", "README.md"], scripts: { test: "node --test" }, dependencies: { "@medhus-ai/crewrun-plugin-sdk": "^0.6.0" } };
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(path.join(root, "index.js"), `import { defineIntegrationPlugin } from "@medhus-ai/crewrun-plugin-sdk";
export default defineIntegrationPlugin({
  apiVersion: "crewrun.integration/v1", id: "${id}", label: "Example integration",
  capabilities: [{ id: "status", label: "Read status", direction: "read", scopes: [] }],
  actions: [{
    id: "${id}.status", label: "Read status", capability: "status", risk: "read", requiresConnection: false,
    inputSchema: () => ({}),
    validate: (input) => input && typeof input === "object" && !Array.isArray(input) && !Object.keys(input).length
      ? { ok: true, input: {} } : { ok: false, error: "No input fields are accepted." }
  }],
  events: [],
  adapter: { invoke: async () => ({ result: { status: "ready" } }) }
});
`);
  await writeFile(path.join(root, "plugin.test.js"), `import test from "node:test";
import { assertIntegrationPluginContract } from "@medhus-ai/crewrun-plugin-sdk";
import plugin from "./index.js";
test("plugin contract", () => assertIntegrationPluginContract(plugin, {
  "${id}.status": { valid: [{}], invalid: [{ token: "must-not-be-accepted" }] }
}));
`);
  await writeFile(path.join(root, "README.md"), "# CrewRun integration plugin\n\nRun npm install and npm test. Extend the manifest with setup, OAuth, curated actions and verified events. See CrewRun docs/integration-plugins.md. Pin provider hosts, whitelist input fields, keep tokens in adapter closures, and return safe result projections. All external writes require owner approval. Install only after reviewing this package and its dependencies: crewrun plugins install ./this-directory --trust.\n");
  return root;
}
