import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseFrontmatter } from "./frontmatter.js";

// Tasks as files: one markdown file per work item in a directory. Fields come from YAML
// frontmatter (`status: open`) or bold bullets (`- **Status:** open`); frontmatter wins.
// Updates rewrite the existing field line in place, so hand-edited files stay readable.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const BULLET = /^-\s+\*\*([A-Za-z][A-Za-z0-9 _-]*):\*\*\s*(.*)$/;

export function createWorkItemSource({ dir } = {}) {
  if (!dir) throw new Error("createWorkItemSource requires dir");
  const root = path.resolve(dir);

  function fileFor(id) {
    if (!ID.test(String(id || ""))) throw new Error(`invalid work item id: ${id || "<empty>"}`);
    return path.join(root, `${id}.md`);
  }

  function list(filter = {}) {
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => name.endsWith(".md") && ID.test(name.slice(0, -3)))
      .sort()
      .map((name) => parseWorkItem(name.slice(0, -3), readFileSync(path.join(root, name), "utf8")))
      .filter((item) => Object.entries(filter).every(([key, value]) => value == null || item.fields[key] === String(value)));
  }

  function get(id) {
    const file = fileFor(id);
    return existsSync(file) ? parseWorkItem(id, readFileSync(file, "utf8")) : null;
  }

  function create(id, { title, fields = {}, body = "" } = {}) {
    const file = fileFor(id);
    if (existsSync(file)) throw new Error(`work item ${id} already exists`);
    const lines = [`# ${String(title || id).trim()}`, ""];
    for (const [key, value] of Object.entries(fields)) lines.push(`- **${fieldLabel(key)}:** ${value}`);
    if (body) lines.push("", String(body).trim());
    mkdirSync(root, { recursive: true });
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    return get(id);
  }

  function update(id, fields = {}) {
    const file = fileFor(id);
    if (!existsSync(file)) throw new Error(`work item ${id} does not exist`);
    let text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    for (const [key, value] of Object.entries(fields)) text = setField(text, key, String(value));
    writeFileSync(file, text, "utf8");
    return get(id);
  }

  return { dir: root, list, get, create, update };
}

export function parseWorkItem(id, text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const fields = {};
  for (const line of normalized.split("\n")) {
    const match = line.match(BULLET);
    if (match && fields[fieldKey(match[1])] === undefined) fields[fieldKey(match[1])] = match[2].trim();
  }
  for (const [key, value] of Object.entries(parseFrontmatter(normalized))) fields[fieldKey(key)] = String(value);
  const heading = normalized.match(/^#\s+(.+?)\s*$/m);
  return { id, title: fields.title || heading?.[1] || id, fields };
}

function setField(text, key, value) {
  const normalizedKey = fieldKey(key);
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) {
      const front = text.slice(4, end);
      const pattern = new RegExp(`^${escapeRegex(normalizedKey)}:.*$`, "m");
      if (pattern.test(front)) return `---\n${front.replace(pattern, `${normalizedKey}: ${value}`)}${text.slice(end)}`;
    }
  }
  const lines = text.split("\n");
  let lastBullet = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(BULLET);
    if (!match) continue;
    lastBullet = index;
    if (fieldKey(match[1]) === normalizedKey) {
      lines[index] = `- **${match[1]}:** ${value}`;
      return lines.join("\n");
    }
  }
  const bullet = `- **${fieldLabel(normalizedKey)}:** ${value}`;
  if (lastBullet >= 0) lines.splice(lastBullet + 1, 0, bullet);
  else {
    const heading = lines.findIndex((line) => /^#\s+/.test(line));
    lines.splice(heading >= 0 ? heading + 1 : 0, 0, "", bullet);
  }
  return lines.join("\n");
}

function fieldKey(label) {
  return String(label || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function fieldLabel(key) {
  return String(key || "").split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
