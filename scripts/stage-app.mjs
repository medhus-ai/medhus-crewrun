import { cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGED_NODE = "24.14.0";
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageFiles = ["package.json", "src", "bin", "docs", "examples", "README.md", "LICENSE", "NOTICE"];
const lock = JSON.parse(readFileSync(path.join(source, "package-lock.json")));

function copyPackage(from, to) {
  mkdirSync(to, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(from, "package.json")));
  const inclusions = (manifest.files || packageFiles).flatMap((name) => name === "*.js" ? readdirSync(from).filter((f) => f.endsWith(".js")) : [name]);
  for (const name of new Set(["package.json", ...inclusions, "LICENSE", "NOTICE", "README.md"])) {
    if (name.includes("..") || path.isAbsolute(name) || /[*?]/.test(name)) throw new Error(`Unsupported package inclusion: ${name}`);
    if (existsSync(path.join(from, name))) cpSync(path.join(from, name), path.join(to, name), { recursive: true, dereference: false });
  }
}

// Build on the target OS/architecture after npm ci. Never cross-copy native SQLite
// or model binaries, and never copy workspace credentials or a developer home.
export function stageApp(destination) {
  if (process.versions.node !== PACKAGED_NODE) throw new Error(`Build with Node ${PACKAGED_NODE}, not ${process.versions.node}`);
  const output = path.resolve(destination);
  if (existsSync(output)) throw new Error("Choose a new output directory; staging never overwrites an existing artifact");
  mkdirSync(path.join(output, "runtime"), { recursive: true });
  const modules = path.join(output, "app", "node_modules"); mkdirSync(modules, { recursive: true });
  const runtime = path.join(output, "runtime", process.platform === "win32" ? "node.exe" : "node");
  copyFileSync(process.execPath, runtime); chmodSync(runtime, 0o755);
  const nodeLicense = [path.join(path.dirname(process.execPath), "LICENSE"), path.resolve(path.dirname(process.execPath), "..", "LICENSE")].find(existsSync);
  if (!nodeLicense) throw new Error("Official Node LICENSE missing beside the build runtime");
  copyFileSync(nodeLicense, path.join(output, "runtime", "LICENSE"));
  const installed = path.join(source, "node_modules");
  for (const entry of readdirSync(installed)) {
    if (entry.startsWith(".") || entry === "medhus-crewrun") continue;
    if (entry.startsWith("@")) {
      mkdirSync(path.join(modules, entry), { recursive: true });
      for (const name of readdirSync(path.join(installed, entry))) copyDependency(path.join(installed, entry, name), path.join(modules, entry, name));
    } else copyDependency(path.join(installed, entry), path.join(modules, entry));
  }
  copyPackage(source, path.join(modules, "medhus-crewrun"));
  const manifest = { format: 1, version: JSON.parse(readFileSync(path.join(source, "package.json"))).version,
    platform: process.platform, arch: process.arch, node: PACKAGED_NODE,
    nodeSha256: createHash("sha256").update(readFileSync(runtime)).digest("hex") };
  writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;

  function copyDependency(from, to) {
    const key = path.relative(source, from).split(path.sep).join("/");
    const record = lock.packages[key];
    if (!record) throw new Error(`Dependency is not in package-lock.json: ${key}; build from npm ci`);
    if (record.dev && !record.devOptional) return;
    if (lstatSync(from).isSymbolicLink()) {
      const resolved = realpathSync(from);
      if (path.dirname(resolved) !== path.join(source, "packages")) throw new Error(`Unreviewed linked dependency: ${from}`);
      copyPackage(resolved, to);
    } else cpSync(from, to, { recursive: true, dereference: false });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/stage-app.mjs <new-output-directory>");
  console.log(JSON.stringify(stageApp(process.argv[2])));
}
