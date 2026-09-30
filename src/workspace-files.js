import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { relativeWorkspacePath, resolveWorkspacePath } from "./workspace-manifest.js";

// Deliberately small first-format surface: agents can produce durable, inspectable text
// without pretending that arbitrary Office files can be edited safely.
export const EDITABLE_WORKSPACE_EXTENSIONS = Object.freeze([".md", ".csv"]);
const MAX_FILES = 250;
const MAX_PREVIEW_BYTES = 1_000_000;

export function isEditableWorkspaceFile(relative) {
  try { relativeWorkspacePath(relative); } catch { return false; }
  const value = String(relative || "").toLowerCase();
  return !value.startsWith(".crew/") && EDITABLE_WORKSPACE_EXTENSIONS.some((extension) => value.endsWith(extension));
}

export function listWorkspaceFiles(targetRoot) {
  const root = path.resolve(targetRoot);
  const files = [];
  const visit = (relative = "", depth = 0) => {
    if (depth > 20 || files.length >= MAX_FILES) return;
    const directory = relative ? resolveWorkspacePath(root, relative) : root;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= MAX_FILES) break;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = resolveWorkspacePath(root, child);
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) visit(child, depth + 1);
      else if (stats.isFile() && isEditableWorkspaceFile(child)) files.push({ path: child, type: path.extname(child).slice(1), bytes: stats.size });
    }
  };
  if (existsSync(root)) visit();
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Folder tree for the Workspace page: every visible folder (so the structure is
// recognizable even where nothing is previewable yet) and the previewable files
// inside them. Bounded like the flat listing; hidden folders and node_modules are skipped.
const MAX_FOLDERS = 500;

export function listWorkspaceTree(targetRoot) {
  const root = path.resolve(targetRoot);
  const tree = { name: "", path: "", folders: [], files: [] };
  let folderCount = 0, fileCount = 0;
  const visit = (node, depth) => {
    if (depth > 20) return;
    const directory = node.path ? resolveWorkspacePath(root, node.path) : root;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = node.path ? `${node.path}/${entry.name}` : entry.name;
      let stats;
      try { stats = lstatSync(resolveWorkspacePath(root, child)); } catch { continue; }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory() && folderCount < MAX_FOLDERS) {
        folderCount += 1;
        const folder = { name: entry.name, path: child, folders: [], files: [] };
        node.folders.push(folder);
        visit(folder, depth + 1);
      } else if (stats.isFile() && fileCount < MAX_FILES && isEditableWorkspaceFile(child)) {
        fileCount += 1;
        node.files.push({ name: entry.name, path: child, type: path.extname(child).slice(1), bytes: stats.size });
      }
    }
  };
  if (existsSync(root)) visit(tree, 0);
  return tree;
}

export function countTreeFiles(node) {
  return node.files.length + node.folders.reduce((sum, folder) => sum + countTreeFiles(folder), 0);
}

export function readWorkspaceFilePreview(targetRoot, relative) {
  if (!isEditableWorkspaceFile(relative)) throw new Error("Workspace preview supports Markdown and CSV files only.");
  const file = resolveWorkspacePath(targetRoot, relative);
  const stats = lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Choose a regular workspace file.");
  if (stats.size > MAX_PREVIEW_BYTES) throw new Error("Workspace previews are limited to 1 MB. Split this file before previewing it.");
  return { path: relative, type: path.extname(relative).slice(1).toLowerCase(), bytes: stats.size, content: readFileSync(file, "utf8") };
}

export function parseCsvPreview(content, { maxRows = 200, maxColumns = 50 } = {}) {
  const rows = [[]];
  let cell = "", quoted = false;
  const pushCell = () => { if (rows.at(-1).length < maxColumns) rows.at(-1).push(cell); cell = ""; };
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") pushCell();
    else if (char === "\n") { pushCell(); if (rows.length < maxRows) rows.push([]); else break; }
    else if (char !== "\r") cell += char;
  }
  if (rows.length <= maxRows && (cell || rows.at(-1).length)) pushCell();
  if (rows.length > 1 && rows.at(-1).length === 0) rows.pop();
  const width = Math.max(0, ...rows.map((row) => row.length));
  return { rows, width, truncated: rows.length >= maxRows || rows.some((row) => row.length >= maxColumns) };
}
