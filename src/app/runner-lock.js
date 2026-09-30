import Database from "better-sqlite3";
import { chmodSync, mkdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { runtimeStatePath } from "../runtime-store.js";

export function runnerDirectory(targetRoot, env = process.env) {
  return path.dirname(runtimeStatePath(targetRoot, env));
}

// An OS-held SQLite write lock has no stale PID/timeout takeover race. Keep it in
// its own database: the work queue must never be held in a long transaction.
export function acquireRunnerLock(targetRoot, env = process.env) {
  const directory = runnerDirectory(targetRoot, env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error("Runner state directory cannot be a symlink");
  chmodSync(directory, 0o700);
  const file = path.join(directory, "runner-lock.sqlite");
  const db = new Database(file, { timeout: 0 });
  try {
    chmodSync(file, 0o600);
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    if (error.code === "SQLITE_BUSY") throw new Error("This workspace already has a running CrewRun host. Attach to it or stop it before restarting.");
    throw error;
  }
  return { directory, close: () => { if (db.open) db.close(); } };
}
