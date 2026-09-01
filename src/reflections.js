import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { crewDir } from "./crew-dirs.js";

// A per-role journal the role appends at the end of a turn ("what worked, what to avoid"). It is
// a plain markdown file under the crew directory — versioned, human-reviewable, and editable —
// and the read side is bounded so a long journal never floods a prompt.
const ROLE = /^[a-z][a-z0-9-]{0,79}$/;
const MAX_TEXT = 2000;

export function reflectionsPath(targetRoot, role) {
  if (!ROLE.test(String(role || ""))) throw new Error("role must be a lowercase slug");
  return path.join(path.resolve(targetRoot || process.cwd()), crewDir(), "memory", "reflections", `${role}.md`);
}

export function appendReflection({ targetRoot, role, text, ref = "", author = role } = {}) {
  const body = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!body || body.length > MAX_TEXT) throw new Error(`reflection must contain 1 to ${MAX_TEXT} characters`);
  if (/^#{1,6}\s/m.test(body)) throw new Error("reflection text may not contain headings");
  const file = reflectionsPath(targetRoot, role);
  const at = new Date().toISOString();
  const entry = { at, ref: String(ref || "").trim().slice(0, 120), author: String(author || role).trim().slice(0, 80), text: body };
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(file, `# Reflections — ${role}\n\nAppend-only journal the role writes for itself at the end of a turn. Humans review and prune it; newest entries are last.\n`, "utf8");
  }
  appendFileSync(file, `\n## ${at} — ${entry.ref || "general"} — ${entry.author}\n\n${body}\n`, "utf8");
  return entry;
}

// Newest `limit` entries, oldest first within that window.
export function readReflections({ targetRoot, role, limit = 10 } = {}) {
  const file = reflectionsPath(targetRoot, role);
  if (!existsSync(file)) return [];
  const entries = [];
  const parts = readFileSync(file, "utf8").replace(/\r\n/g, "\n").split(/^## /m).slice(1);
  for (const part of parts) {
    const [head, ...rest] = part.split("\n");
    const match = head.match(/^(\S+) — (.*?) — (.*)$/);
    if (!match) continue;
    entries.push({ at: match[1], ref: match[2] === "general" ? "" : match[2], author: match[3], text: rest.join("\n").trim() });
  }
  const max = Math.max(1, Math.min(Number(limit) || 10, 100));
  return entries.slice(-max);
}

export function reflectionsPrompt(entries = [], { role = "" } = {}) {
  if (!entries.length) return "";
  return [
    `## Reflections${role ? ` (${role})` : ""}`,
    "Notes this role left for itself after earlier turns. Current instructions win when they conflict.",
    ...entries.map((entry) => `- ${String(entry.at).slice(0, 10)}${entry.ref ? ` (${entry.ref})` : ""}: ${entry.text.replace(/\s+/g, " ")}`)
  ].join("\n");
}
