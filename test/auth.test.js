import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

// Must be set before the module reads the path.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "crew-auth-test-"));
process.env.CREW_AUTH_FILE = path.join(tmpRoot, "cockpit-auth.json");

const auth = await import("../src/auth.js");

const PASSWORD = "correct horse 9 battery";

after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => auth.resetAuthForTests());

test("password rule: 8+ characters, alphanumeric", () => {
  assert.match(auth.passwordError("short1"), /at least 8 characters/);
  assert.match(auth.passwordError("lettersonly"), /alphanumeric/);
  assert.equal(auth.passwordError(PASSWORD), null);
});

test("operator and viewer passwords are stored hashed and verified separately", () => {
  assert.equal(auth.hasPassword(), false);
  assert.throws(() => auth.setViewerPassword("viewer pass 1"), /operator password first/);
  auth.setPassword(PASSWORD);
  assert.equal(auth.verifyPassword(PASSWORD), true);
  assert.equal(auth.verifyPassword("wrong password"), false);
  assert.throws(() => auth.setViewerPassword(PASSWORD), /must differ/);
  auth.setViewerPassword("viewer pass 1");
  assert.equal(auth.hasViewerPassword(), true);
  assert.equal(auth.verifyViewerPassword("viewer pass 1"), true);
  assert.equal(auth.verifyPassword("viewer pass 1"), false);
  auth.setPassword("another secret 123");
  assert.equal(auth.hasViewerPassword(), true, "rotating the operator password keeps viewer access");
  auth.removeViewerPassword();
  assert.equal(auth.hasViewerPassword(), false);
});

test("sessions carry a role, and the cookie name follows the crew directory", () => {
  const operator = auth.createSession();
  const viewer = auth.createSession(auth.VIEWER_ROLE);
  assert.equal(auth.sessionRole(operator), auth.OPERATOR_ROLE);
  assert.equal(auth.isViewerSession(viewer), true);
  auth.destroySession(viewer);
  assert.equal(auth.hasSession(viewer), false);
  assert.equal(auth.SESSION_COOKIE, `${(process.env.CREW_DIR_NAME || ".gitcrew").replace(/^\./, "")}_session`);
});

test("login throttling locks after repeated failures and clears on success", () => {
  for (let i = 0; i < 5; i += 1) auth.recordLoginFailure();
  assert.ok(auth.loginLockedForMs() > 0);
  auth.recordLoginSuccess();
  assert.equal(auth.loginLockedForMs(), 0);
});
