import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CREW_DIR, crewEnv, crewHome } from "../src/crew-dirs.js";

test("CREW_DIR defaults to the first consumer's directory name", () => {
  assert.equal(CREW_DIR, process.env.CREW_DIR_NAME || ".gitcrew");
});

test("crewEnv prefers the neutral name and falls back to the legacy prefix", () => {
  assert.equal(crewEnv("HOME", { CREW_HOME: "/a", GITCREW_HOME: "/b" }), "/a");
  assert.equal(crewEnv("HOME", { GITCREW_HOME: "/b" }), "/b");
  assert.equal(crewEnv("HOME", {}), undefined);
});

test("crewHome resolves the override or the home directory default", () => {
  assert.equal(crewHome({ CREW_HOME: "/tmp/crew-home" }), path.resolve("/tmp/crew-home"));
  assert.equal(crewHome({}), path.join(os.homedir(), CREW_DIR));
});
