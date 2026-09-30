import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { crewDir, crewEnv, crewEnvNames, crewHome } from "../src/crew-dirs.js";
test("v6 uses canonical paths and ignores legacy host environment prefixes", () => {
  assert.equal(crewDir(), ".crew");
  assert.equal(crewEnv("HOME", { CREW_HOME: "/a", GITCREW_HOME: "/b" }), "/a");
  assert.equal(crewEnv("HOME", { GITCREW_HOME: "/b" }), undefined);
  assert.deepEqual(crewEnvNames("HOME"), ["CREW_HOME"]);
  assert.equal(crewHome({}), path.join(os.homedir(), ".crew"));
});
