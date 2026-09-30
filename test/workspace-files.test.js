import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isEditableWorkspaceFile, listWorkspaceFiles, parseCsvPreview, readWorkspaceFilePreview } from "../src/workspace-files.js";

test("workspace file previews stay Markdown and CSV only", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "crew-workspace-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "drafts", "assistant"), { recursive: true });
  mkdirSync(path.join(root, ".crew"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Hello");
  writeFileSync(path.join(root, "drafts", "assistant", "budget.csv"), "Name,Amount\n\"Launch, phase 1\",2400\n");
  writeFileSync(path.join(root, "private.docx"), "not previewable");
  writeFileSync(path.join(root, ".crew", "secret.md"), "not visible");
  assert.equal(isEditableWorkspaceFile("drafts/assistant/budget.csv"), true);
  assert.equal(isEditableWorkspaceFile("drafts/assistant/budget.xlsx"), false);
  assert.deepEqual(listWorkspaceFiles(root).map((file) => file.path), ["drafts/assistant/budget.csv", "README.md"]);
  assert.equal(readWorkspaceFilePreview(root, "README.md").content, "# Hello");
  assert.throws(() => readWorkspaceFilePreview(root, "private.docx"), /Markdown and CSV/);
  const csv = parseCsvPreview(readWorkspaceFilePreview(root, "drafts/assistant/budget.csv").content);
  assert.deepEqual(csv.rows, [["Name", "Amount"], ["Launch, phase 1", "2400"]]);
});
