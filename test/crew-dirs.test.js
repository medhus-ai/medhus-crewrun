import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configureCrew, crewDir, crewEnv, crewHome } from "../src/crew-dirs.js";

test("crewDir() defaults to the first consumer's directory name", () => {
  assert.equal(crewDir(), process.env.CREW_DIR_NAME || ".crew");
});

test("crewEnv prefers the neutral name and falls back only to a configured legacy prefix", () => {
  assert.equal(crewEnv("HOME", { CREW_HOME: "/a", LEGACY_HOME: "/b" }), "/a");
  assert.equal(crewEnv("HOME", { LEGACY_HOME: "/b" }), undefined, "no fallback until a host configures one");
  configureCrew({ legacyEnvPrefix: "LEGACY_" });
  assert.equal(crewEnv("HOME", { LEGACY_HOME: "/b" }), "/b");
  assert.equal(crewEnv("HOME", {}), undefined);
  configureCrew({ legacyEnvPrefix: "" });
});

test("configureCrew brands the state directory and validates the name", () => {
  assert.equal(crewDir(), process.env.CREW_DIR_NAME || ".crew");
  assert.equal(configureCrew({ dirName: ".acme" }).dirName, ".acme");
  assert.equal(crewDir(), ".acme");
  assert.throws(() => configureCrew({ dirName: "../x" }), /invalid crew directory name/);
  configureCrew({ dirName: ".crew" });
});

test("crewHome resolves the override or the home directory default", () => {
  assert.equal(crewHome({ CREW_HOME: "/tmp/crew-home" }), path.resolve("/tmp/crew-home"));
  assert.equal(crewHome({}), path.join(os.homedir(), crewDir()));
});
