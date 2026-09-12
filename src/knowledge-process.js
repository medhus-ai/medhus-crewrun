import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const KNOWLEDGE_VERSIONS = Object.freeze({ qmd: "2.8.3", docling: "2.126.0", boundary: 1 });

// These are host-only paths. Never accept executable, config, model or index paths from tools.
export function knowledgeInstallation(env = process.env) {
  let modules = "";
  try { modules = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@tobilu/qmd"))), "../../.."); } catch { /* optional dependency */ }
  const venv = path.resolve(env.CREW_DOCLING_VENV || path.join(here, "../node_modules/.crewrun-docling"));
  return { modules, venv, qmd: Boolean(modules) && Number(process.versions.node.split(".")[0]) >= 22, docling: existsSync(path.join(venv, "bin/python")), sandbox: process.platform === "linux" && existsSync("/usr/bin/bwrap"), semantic: env.CREW_KNOWLEDGE_SEMANTIC === "1" };
}

export function knowledgeSandboxArgs({ kind, job, cache, models, installation }) {
  if (!installation.sandbox) throw new Error("Knowledge parsing/search requires Linux bubblewrap. No unsandboxed fallback; see docs/workspace-knowledge.md.");
  if (!installation[kind]) throw new Error(`${kind} is unavailable (QMD requires Node 22+ and optional npm dependencies; Docling requires its dedicated venv). See docs/workspace-knowledge.md.`);
  const args = ["--unshare-all", "--die-with-parent", "--cap-drop", "ALL", "--clearenv"];
  // System code/libraries only: no host home, workspace, credentials, sockets or network.
  for (const directory of ["/usr", "/bin", "/lib", "/lib64"]) if (existsSync(directory)) args.push("--ro-bind", realpathSync(directory), directory);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/home/worker",
    "--ro-bind", job, "/work", "--chdir", "/work");
  const environment = { PATH: "/usr/bin:/bin", HOME: "/home/worker", LANG: "C.UTF-8", TMPDIR: "/tmp", OMP_NUM_THREADS: "2", OPENBLAS_NUM_THREADS: "2", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1", QMD_FORCE_CPU: "1", XDG_CACHE_HOME: "/models", XDG_CONFIG_HOME: "/tmp/config" };
  for (const [key, value] of Object.entries(environment)) args.push("--setenv", key, value);
  if (models && existsSync(models)) args.push("--ro-bind", models, "/models");
  else args.push("--dir", "/models");
  if (kind === "qmd") {
    args.push("--ro-bind", process.execPath, "/runtime/node", "--ro-bind", installation.modules, "/app/node_modules",
      "--ro-bind", path.join(here, "knowledge-qmd-worker.js"), "/app/worker.mjs", "--bind", cache, "/index",
      "/usr/bin/flock", "-w", "30", "/index/lock", "/usr/bin/prlimit", "--cpu=120", "--fsize=268435456", "--nofile=512", "--",
      "/runtime/node", "--max-old-space-size=1024", "/app/worker.mjs");
  } else {
    args.push("--ro-bind", installation.venv, "/python", "--ro-bind", path.join(here, "knowledge-docling-worker.py"), "/app/worker.py",
      "/usr/bin/prlimit", "--as=4294967296", "--cpu=90", "--fsize=16777216", "--nofile=256", "--", "/python/bin/python", "-I", "/app/worker.py");
  }
  return args;
}

export async function runKnowledgeProcess(options) {
  const args = knowledgeSandboxArgs(options);
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/bwrap", args, { env: {}, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "", size = 0, failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      reject(new Error(`${options.kind} could not complete in its restricted sandbox. Check installation, input limits and local model setup (docs/workspace-knowledge.md).`));
    };
    const timer = setTimeout(fail, options.kind === "qmd" ? 180000 : 100000);
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size > 8000000) fail(); else output += chunk.toString("utf8"); });
    // Parser diagnostics can contain document text or host paths. Never forward them to agents.
    child.stderr.on("data", (chunk) => { size += chunk.length; if (size > 8000000) fail(); });
    child.on("error", () => { clearTimeout(timer); fail(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) return fail();
      try { resolve(JSON.parse(output)); } catch { fail(); }
    });
  });
}
