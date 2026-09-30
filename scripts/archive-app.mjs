import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (!["desktop", "headless"].includes(mode)) throw new Error("Choose desktop or headless");
const base = path.resolve("apps/desktop"), releases = path.resolve("dist/releases");
const binary = process.platform === "win32" ? "CrewRun.exe" : "CrewRun";
copyFileSync(path.join(base, "target/release", binary), path.join(base, binary));
execFileSync(process.execPath, [fileURLToPath(new URL("./smoke-launcher.mjs", import.meta.url)), path.join(base, binary)], { stdio: "inherit" });
mkdirSync(releases, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(base, "payload/manifest.json")));
const filename = `CrewRun-${manifest.version}-${process.platform}-${process.arch}-${mode}-unsigned.tar.gz`;
const archive = path.join(releases, filename);
if (existsSync(archive)) throw new Error("Refusing to replace an existing release artifact");
// tar is a build-host tool on the three CI images, never an end-user dependency.
const partial = `${archive}.partial`;
if (existsSync(partial)) throw new Error("Previous incomplete archive exists; inspect and remove it before retrying");
try {
  // Relative paths: GNU tar on Windows reads "D:\\..." as a remote host ("D") and fails.
  const cwd = process.cwd();
  execFileSync("tar", ["-czf", path.relative(cwd, partial), "-C", path.relative(cwd, base), binary, "payload"], { stdio: "inherit", cwd });
  renameSync(partial, archive);
} catch (error) { rmSync(partial, { force: true }); throw error; }
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
writeFileSync(`${archive}.sha256`, `${hash.digest("hex")}  ${filename}\n`);
