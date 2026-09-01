import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { crewDir } from "../src/crew-dirs.js";
import { createTemplateReader, interpolate } from "../src/templates.js";

test("template reader substitutes the crew directory and host placeholders", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crew-templates-"));
  await writeFile(path.join(dir, "role.md"), "read __CREW_DIR__/memory and __EXTRA__ ($&)", "utf8");
  const read = createTemplateReader(dir, { substitutions: { __EXTRA__: "more $1" } });
  assert.equal(read("role.md"), `read ${crewDir()}/memory and more $1 ($&)`);
  assert.equal(interpolate("hi __NAME__", { NAME: "$&" }), "hi $&");
});
