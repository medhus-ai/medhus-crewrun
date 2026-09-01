import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { crewDir } from "../src/crew-dirs.js";
import { createRoleCatalog } from "../src/roles.js";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "crew-roles-"));
  const templatesDir = path.join(base, "templates");
  await mkdir(templatesDir, { recursive: true });
  await writeFile(path.join(templatesDir, "ceo.md"), "# CEO", "utf8");
  await writeFile(path.join(templatesDir, "ops.md"), "# Ops", "utf8");
  await writeFile(path.join(templatesDir, "specialist.template.md"), "# skeleton", "utf8");
  return { base, templatesDir, target: path.join(base, "repo") };
}

test("catalog lists, installs from templates or a generator, and refuses unknown or always-present roles", async () => {
  const { templatesDir, target } = await fixture();
  const events = [];
  const catalog = createRoleCatalog({
    templatesDir,
    alwaysPresent: ["ceo"],
    generate: ({ name, custom }) => (custom ? `# ${name} (generated)` : null),
    onInstalled: (root, name, options) => events.push(["installed", name, Boolean(options.custom)]),
    cliName: "acme"
  });

  assert.deepEqual(await catalog.listRoles({ target }), { target: path.resolve(target), installed: [], available: ["ops"] });
  await assert.rejects(catalog.addRole({ target, name: "ceo" }), /always-present and is installed by acme init/);
  await assert.rejects(catalog.addRole({ target, name: "ghost" }), /unknown role ghost; check acme roles list/);
  await assert.rejects(catalog.addRole({ target, name: "Bad Name" }), /lowercase slug/);

  const added = await catalog.addRole({ target, name: "ops" });
  assert.equal(added.action, "added");
  assert.equal(await readFile(path.join(target, crewDir(), "roles", "ops.md"), "utf8"), "# Ops");
  assert.equal((await catalog.addRole({ target, name: "ops" })).action, "already-installed");

  const generated = await catalog.addRole({ target, name: "gtm", custom: true });
  assert.equal(generated.action, "added");
  assert.equal(await readFile(generated.path, "utf8"), "# gtm (generated)");
  assert.deepEqual(events, [["installed", "ops", false], ["installed", "ops", false], ["installed", "gtm", true]]);
  assert.deepEqual((await catalog.listRoles({ target })).installed, ["gtm", "ops"]);
  assert.equal(catalog.isAlwaysPresent("ceo"), true);
});

test("removing a role archives its file and notifies the host", async () => {
  const { templatesDir, target } = await fixture();
  const removed = [];
  const catalog = createRoleCatalog({ templatesDir, alwaysPresent: ["ceo"], onRemoved: (root, name) => removed.push(name) });
  await catalog.addRole({ target, name: "ops" });
  await assert.rejects(catalog.removeRole({ target, name: "ceo" }), /always-present and cannot be removed/);
  assert.equal((await catalog.removeRole({ target, name: "nope" })).action, "not-installed");
  const result = await catalog.removeRole({ target, name: "ops" });
  assert.equal(result.action, "archived");
  assert.deepEqual(removed, ["ops"]);
  const archived = await readdir(path.join(target, crewDir(), "roles", "_archived"));
  assert.equal(archived.length, 1);
  assert.match(archived[0], /^ops-\d{4}-\d{2}-\d{2}\.md$/);
  assert.deepEqual([...(await catalog.installedRoleNames(target))], []);
});

test("role names never leave the roles directory", async () => {
  const { templatesDir, target } = await fixture();
  const catalog = createRoleCatalog({ templatesDir });
  await assert.rejects(catalog.removeRole({ target, name: "../escape" }), /lowercase slug/);
  await assert.rejects(catalog.addRole({ target, name: "../escape" }), /lowercase slug/);
});
