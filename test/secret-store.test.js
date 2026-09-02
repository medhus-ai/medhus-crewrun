import assert from "node:assert/strict";
import * as fsModule from "node:fs";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

// Must be set before the module reads the path.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "crew-secret-test-"));
process.env.CREW_SECRETS_FILE = path.join(tmpRoot, "secrets.json");

const store = await import("../src/secret-store.js");

const PASSWORD = "correct horse 9 battery";
let testSeq = 0;

after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  store.resetSecretStoreForTests();
  // A fresh file per test so the lifecycle/listing assertions are independent.
  testSeq += 1;
  process.env.CREW_SECRETS_FILE = path.join(tmpRoot, `secrets-${testSeq}.json`);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

test("seal/open round-trips and rejects the wrong password", () => {
  const blob = store.seal({ ANTHROPIC_API_KEY: "sk-ant-123" }, PASSWORD);
  assert.equal(blob.algorithm, "aes-256-gcm");
  assert.ok(!JSON.stringify(blob).includes("sk-ant-123"), "ciphertext must not leak the key");
  assert.deepEqual(store.open(blob, PASSWORD), { ANTHROPIC_API_KEY: "sk-ant-123" });
  assert.throws(() => store.open(blob, "wrong password 1"), /wrong password or corrupted/);
});

test("a tampered ciphertext fails the GCM auth tag", () => {
  const blob = store.seal({ OPENAI_API_KEY: "sk-openai" }, PASSWORD);
  const flipped = Buffer.from(blob.ciphertext, "base64");
  flipped[0] ^= 0xff;
  assert.throws(() => store.open({ ...blob, ciphertext: flipped.toString("base64") }, PASSWORD), /corrupted/);
});

test("unlock decrypts, set persists at 0600, lock clears memory", () => {
  store.unlock(PASSWORD); // no file yet → empty store keyed to this password
  assert.equal(store.isUnlocked(), true);
  store.setSecret("ANTHROPIC_API_KEY", "sk-ant-xyz");

  // Persisted, encrypted, and locked down to the operator.
  if (process.platform !== "win32") {
    assert.equal((statSync(process.env.CREW_SECRETS_FILE).mode & 0o777), 0o600);
  }
  assert.ok(!readFileSync(process.env.CREW_SECRETS_FILE, "utf8").includes("sk-ant-xyz"));

  store.lock();
  assert.equal(store.isUnlocked(), false);
  assert.equal(store.getSecret("ANTHROPIC_API_KEY"), undefined);

  // Re-unlock with the same password reads the persisted secret back.
  store.unlock(PASSWORD);
  assert.equal(store.getSecret("ANTHROPIC_API_KEY"), "sk-ant-xyz");
});

test("unlock pushes provider keys into process.env for the SDK engines", () => {
  store.unlock(PASSWORD);
  store.setSecret("ANTHROPIC_API_KEY", "sk-ant-env");
  assert.equal(process.env.ANTHROPIC_API_KEY, "sk-ant-env");

  store.lock();
  delete process.env.ANTHROPIC_API_KEY;
  store.unlock(PASSWORD); // unlock alone re-applies the env
  assert.equal(process.env.ANTHROPIC_API_KEY, "sk-ant-env");
});

test("remove and lock revoke injected provider env while preserving ambient values", () => {
  process.env.OPENAI_API_KEY = "ambient-openai";
  store.unlock(PASSWORD);
  store.setSecret("OPENAI_API_KEY", "stored-openai");
  store.setSecret("ANTHROPIC_API_KEY", "stored-anthropic");
  assert.equal(process.env.OPENAI_API_KEY, "stored-openai");
  assert.equal(process.env.ANTHROPIC_API_KEY, "stored-anthropic");

  assert.equal(store.removeSecret("OPENAI_API_KEY"), true);
  assert.equal(process.env.OPENAI_API_KEY, "ambient-openai");
  store.lock();
  assert.equal(process.env.OPENAI_API_KEY, "ambient-openai");
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  delete process.env.OPENAI_API_KEY;
});

test("secretEnvForRunner resolves stored and ambient keys by provider and secret_ref", () => {
  store.unlock(PASSWORD);
  store.setSecret("OPENAI_API_KEY", "sk-default");
  store.setSecret("openai-work", "sk-work");

  // Provider default.
  assert.deepEqual(store.secretEnvForRunner({ provider: "openai" }), { OPENAI_API_KEY: "sk-default" });
  // secret_ref wins.
  assert.deepEqual(
    store.secretEnvForRunner({ provider: "openai", secret_ref: "openai-work" }),
    { OPENAI_API_KEY: "sk-work" }
  );
  // Unknown provider / no stored key → empty (subscription auth still applies).
  assert.deepEqual(store.secretEnvForRunner({ provider: "custom" }), {});
  store.lock();
  assert.deepEqual(store.secretEnvForRunner({ provider: "openai" }), {});

  process.env.OPENROUTER_API_KEY = "sk-or-ambient";
  assert.equal(store.secretValueForRunner({ provider: "openrouter" }), "sk-or-ambient");
  assert.deepEqual(store.secretEnvForRunner({ provider: "openrouter" }), { OPENROUTER_API_KEY: "sk-or-ambient" });
  delete process.env.OPENROUTER_API_KEY;
});

test("writes require an unlocked store and names are validated", () => {
  assert.throws(() => store.setSecret("ANTHROPIC_API_KEY", "x"), /locked/);
  store.unlock(PASSWORD);
  assert.throws(() => store.setSecret("bad name!", "x"), /invalid secret name/);
  assert.equal(store.removeSecret("never-set"), false);
});

test("rekey migrates the file to a new password and refuses a wrong old one", () => {
  store.unlock(PASSWORD);
  store.setSecret("ANTHROPIC_API_KEY", "sk-keep-me");
  store.lock();

  const NEW = "another secret 123";
  // Wrong old password changes nothing and the old password still works.
  assert.throws(() => store.rekey("wrong old pw 1", NEW), /wrong password or corrupted/);
  store.unlock(PASSWORD);
  assert.equal(store.getSecret("ANTHROPIC_API_KEY"), "sk-keep-me");
  store.lock();

  // Correct old password re-encrypts: new opens, old no longer does.
  assert.equal(store.rekey(PASSWORD, NEW), true);
  store.unlock(NEW);
  assert.equal(store.getSecret("ANTHROPIC_API_KEY"), "sk-keep-me");
  store.lock();
  assert.throws(() => store.unlock(PASSWORD), /wrong password or corrupted/);
});

test("rekey is a no-op with no secrets file", () => {
  assert.equal(store.rekey(PASSWORD, "another secret 123"), false);
});

test("known-provider env vars (incl. glm/kimi/github) apply on unlock", () => {
  store.unlock(PASSWORD);
  store.setSecret("GLM_API_KEY", "glm-1");
  store.setSecret("MOONSHOT_API_KEY", "kimi-1");
  store.setSecret("GH_TOKEN", "ghp_1");
  assert.equal(process.env.GLM_API_KEY, "glm-1");
  assert.equal(process.env.MOONSHOT_API_KEY, "kimi-1");
  assert.equal(process.env.GH_TOKEN, "ghp_1");
  // GitHub routes through the cli engine via the provider catalog.
  assert.deepEqual(store.secretEnvForRunner({ provider: "github" }), { GH_TOKEN: "ghp_1" });
});

test("resolveSecretName maps ids and env names; passes literals through", () => {
  assert.equal(store.resolveSecretName("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(store.resolveSecretName("kimi"), "MOONSHOT_API_KEY");
  assert.equal(store.resolveSecretName("GH_TOKEN"), "GH_TOKEN");
  assert.equal(store.resolveSecretName("openai-work"), "openai-work");
});

test("knownSecretStatus masks set keys; customSecretNames lists the rest", () => {
  store.unlock(PASSWORD);
  store.setSecret("OPENAI_API_KEY", "sk-abcd1234");
  store.setSecret("openai-work", "sk-second");

  const openai = store.knownSecretStatus().find((entry) => entry.id === "openai");
  assert.equal(openai.set, true);
  assert.equal(openai.masked, "••••1234");
  const glm = store.knownSecretStatus().find((entry) => entry.id === "glm");
  assert.equal(glm.set, false);

  assert.deepEqual(store.customSecretNames(), ["openai-work"]);
});

test("discardSecrets deletes the file and locks", () => {
  store.unlock(PASSWORD);
  store.setSecret("ANTHROPIC_API_KEY", "sk-gone");
  assert.equal(store.secretsFileExists(), true);

  store.discardSecrets();
  assert.equal(store.isUnlocked(), false);
  assert.equal(store.secretsFileExists(), false);
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
});

test("listSecretNames signals locked vs empty vs unlocked", () => {
  assert.deepEqual(store.listSecretNames(), []); // no file
  store.unlock(PASSWORD);
  store.setSecret("OPENAI_API_KEY", "sk");
  assert.deepEqual(store.listSecretNames(), ["OPENAI_API_KEY"]);
  store.lock();
  assert.equal(store.listSecretNames(), null); // file exists but locked
});

test("writes repair the file mode of an existing secrets file", () => {
  if (process.platform === "win32") return;
  const { chmodSync } = require_fs();
  store.unlock(PASSWORD);
  store.setSecret("A_KEY", "1");
  chmodSync(process.env.CREW_SECRETS_FILE, 0o644);
  store.setSecret("B_KEY", "2");
  assert.equal(statSync(process.env.CREW_SECRETS_FILE).mode & 0o777, 0o600);
});

function require_fs() { return fsModule; }
