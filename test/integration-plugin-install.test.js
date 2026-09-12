import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installIntegrationPlugin, loadInstalledPlugins, listInstalledPlugins, scaffoldIntegrationPlugin } from "../src/integration-plugins.js";
import { assertIntegrationPluginContract } from "../packages/crewrun-plugin-sdk/index.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewrun-plugin-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, env: { CREW_HOME: path.join(root, "private"), npm_config_cache: path.join(root, "cache"), npm_config_offline: "true" } };
}

test("plugin installer requires explicit trust and exact npm versions", async (t) => {
  const { env } = await fixture(t);
  await assert.rejects(installIntegrationPlugin("example@1.2.3", { env }), /--trust/);
  for (const source of ["example", "example@latest", "example@^1.2.3", "https://example.com/code.tgz", "git+https://example.com/repo"]) {
    await assert.rejects(installIntegrationPlugin(source, { trust: true, env }), /exact npm/);
  }
  assert.deepEqual(await listInstalledPlugins({ env }), []);
});

test("local installation is a pinned snapshot, disables scripts and detects changed installed code", { timeout: 60_000 }, async (t) => {
  const { root, env } = await fixture(t);
  const source = path.join(root, "source");
  await mkdir(source);
  const marker = path.join(root, "script-ran");
  await writeFile(path.join(source, "package.json"), JSON.stringify({
    name: "crewrun-plugin-fixture", version: "1.2.3", type: "module", exports: "./index.js",
    scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}', 'bad')"` }
  }));
  await writeFile(path.join(source, "index.js"), 'export default { apiVersion: "crewrun.integration/v1", id: "fixture", label: "Original", actions: [], events: [], capabilities: [] };\n');
  const installed = await installIntegrationPlugin(source, { trust: true, env });
  assert.equal(installed.id, "fixture");
  await assert.rejects(access(marker));
  await writeFile(path.join(source, "index.js"), 'throw new Error("local edits must not run");\n');
  assert.equal((await loadInstalledPlugins({ env }))[0].label, "Original");
  assert.equal((await listInstalledPlugins({ env }))[0].version, "1.2.3");
  const records = JSON.parse(await readFile(path.join(env.CREW_HOME, "plugins/installed.json"), "utf8"));
  await writeFile(path.join(env.CREW_HOME, "plugins", records[0].directory, "node_modules/crewrun-plugin-fixture/index.js"), 'throw new Error("changed");\n');
  await assert.rejects(loadInstalledPlugins({ env }), /changed. Reinstall/);
});

test("scaffold creates a minimal testable package without overwriting a directory", async (t) => {
  const { root } = await fixture(t);
  const destination = path.join(root, "plugin");
  await scaffoldIntegrationPlugin(destination, { id: "weather" });
  const pkg = JSON.parse(await readFile(path.join(destination, "package.json"), "utf8"));
  assert.equal(pkg.name, "crewrun-plugin-weather");
  assert.match(await readFile(path.join(destination, "plugin.test.js"), "utf8"), /assertIntegrationPluginContract/);
  await assert.rejects(scaffoldIntegrationPlugin(destination), /EEXIST/);
  assert.throws(() => assertIntegrationPluginContract({
    id: "weather", label: "Weather", capabilities: [{ id: "read", label: "Read" }],
    actions: [{ id: "weather.read", label: "Read", capability: "read", inputSchema: () => ({}), validate: () => ({ ok: true }) }]
  }), /Provide valid inputs/);
});
