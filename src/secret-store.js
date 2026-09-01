import crypto from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { crewEnv, crewHome } from "./crew-dirs.js";
import path from "node:path";

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32; // AES-256
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

// Most provider credentials are exported on unlock so vendor SDKs can pick them
// up ambiently. Server-only credentials opt out and must be resolved explicitly.
export const KNOWN_SECRETS = [
  { id: "anthropic", label: "Anthropic · Claude", env: "ANTHROPIC_API_KEY", hint: "sk-ant-…" },
  { id: "openai", label: "OpenAI · Codex", env: "OPENAI_API_KEY", hint: "sk-…" },
  { id: "glm", label: "Z.ai · GLM", env: "GLM_API_KEY", hint: "GLM coding-plan key" },
  { id: "kimi", label: "Moonshot · Kimi K2", env: "MOONSHOT_API_KEY", hint: "Moonshot key" },
  { id: "openrouter", label: "OpenRouter", env: "OPENROUTER_API_KEY", hint: "sk-or-…" },
  { id: "github", label: "GitHub · token", env: "GH_TOKEN", hint: "ghp_… or github_pat_…" },
  { id: "github-app", label: "GitHub App · private key", env: "GITHUB_APP_PRIVATE_KEY", hint: "-----BEGIN PRIVATE KEY-----" },
  { id: "azure-devops", label: "Azure DevOps · PAT", env: "AZURE_DEVOPS_EXT_PAT", hint: "Azure DevOps personal access token", agentRuntime: false }
];

export const PROVIDER_ENV = Object.fromEntries(KNOWN_SECRETS.map((entry) => [entry.id, entry.env]));
const RUNTIME_PROVIDER_ENV = Object.fromEntries(
  KNOWN_SECRETS
    .filter((entry) => entry.agentRuntime !== false)
    .map((entry) => [entry.id, entry.env])
);

export function resolveSecretName(identifier) {
  const value = String(identifier || "").trim();
  const known = KNOWN_SECRETS.find((entry) => entry.id === value || entry.env === value);
  return known ? known.env : value;
}

export function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  return text.length <= 4 ? "••••" : `••••${text.slice(-4)}`;
}

// Key/salt retained so add/rotate during a session don't re-prompt for the password.
let cache = null;
let sealKey = null;
let sealSalt = null;
const injectedProviderEnv = new Map();

export function secretsFilePath() {
  const override = crewEnv("SECRETS_FILE");
  return override ? path.resolve(override) : path.join(crewHome(), "secrets.json");
}

// ── Crypto core (pure, password-based — used by the store and by tests) ───────

export function seal(secrets, password) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt);
  return sealWithKey(secrets, key, salt);
}

export function open(blob, password) {
  if (!blob || typeof blob !== "object") throw new Error("not a sealed secrets file");
  const salt = Buffer.from(blob.salt, "base64");
  return openWithKey(blob, deriveKey(password, salt, blob.params));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function secretsFileExists() {
  return readBlob() !== null;
}

export function isUnlocked() {
  return cache !== null;
}

// With no file yet, bootstraps an empty store so the first setSecret can seal without a separate init step.
export function unlock(password) {
  const blob = readBlob();
  if (blob) {
    sealSalt = Buffer.from(blob.salt, "base64");
    sealKey = deriveKey(password, sealSalt, blob.params);
    cache = openWithKey(blob, sealKey);
  } else {
    sealSalt = crypto.randomBytes(16);
    sealKey = deriveKey(password, sealSalt);
    cache = {};
  }
  applyProviderEnv(cache);
  return Object.keys(cache);
}

export function lock() {
  restoreProviderEnv();
  cache = null;
  sealKey = null;
  sealSalt = null;
}

// Rotating the operator password keeps stored API keys rather than orphaning them; advances the in-memory key if already unlocked.
export function rekey(oldPassword, newPassword) {
  const blob = readBlob();
  if (!blob) return false;
  const secrets = open(blob, oldPassword); // throws on a wrong old password
  const resealed = seal(secrets, newPassword);
  writeBlob(resealed);
  if (cache) {
    cache = secrets;
    sealSalt = Buffer.from(resealed.salt, "base64");
    sealKey = deriveKey(newPassword, sealSalt);
  }
  return true;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export function getSecret(name) {
  return cache ? cache[name] : undefined;
}

// Callers such as agent-run health checks only need to know whether a named
// reference is usable; they must never receive the secret value. Include both
// the stored environment-variable names and their friendly built-in aliases
// so a contract can safely use either form (for example, "github" or
// "GH_TOKEN"). This object is safe to serialize into a scoped MCP context.
export function secretAvailability() {
  if (!cache) return {};
  const available = {};
  for (const [name, value] of Object.entries(cache)) {
    if (value) available[name] = true;
  }
  for (const entry of KNOWN_SECRETS) {
    if (cache[entry.env]) {
      available[entry.id] = true;
      available[entry.env] = true;
    }
  }
  return available;
}

// Returns null (not []) when a file exists but is locked — names can't be known without the key.
export function listSecretNames() {
  if (cache) return Object.keys(cache);
  return readBlob() ? null : [];
}

// Locked → set:false because names aren't knowable without the key.
export function knownSecretStatus() {
  return KNOWN_SECRETS.map((entry) => {
    const value = cache ? cache[entry.env] : undefined;
    return { ...entry, set: Boolean(value), masked: value ? maskSecret(value) : "" };
  });
}

export function customSecretNames() {
  if (!cache) return [];
  const known = new Set(KNOWN_SECRETS.map((entry) => entry.env));
  return Object.keys(cache).filter((name) => !known.has(name));
}

// Empty when locked or no secret stored — subscription/ambient auth still applies, so this never forces API-key auth on an SDK engine.
export function secretEnvForRunner(runner) {
  const envVar = RUNTIME_PROVIDER_ENV[runner?.provider];
  if (!envVar) return {};
  const value = secretValueForRunner(runner);
  return value ? { [envVar]: value } : {};
}

// Raw stored key for a runner (secret_ref wins over the provider default); "" when locked or unset.
export function secretValueForRunner(runner) {
  if (!cache || !runner) return "";
  return (runner.secret_ref && cache[runner.secret_ref]) || cache[PROVIDER_ENV[runner.provider]] || "";
}

// Anthropic-protocol routing: a runner with base_url speaks the Anthropic API at a
// third-party or local endpoint (GLM, Kimi, Ollama, LM Studio, llama.cpp). The stored
// key rides in ANTHROPIC_AUTH_TOKEN, as those vendors document for Claude Code;
// local servers typically need no key, so a missing one only omits the token.
export function anthropicRouteEnv(runner) {
  const baseUrl = String(runner?.base_url || "").trim();
  if (!baseUrl) return {};
  const key = secretValueForRunner(runner);
  // ANTHROPIC_API_KEY is explicitly blanked so the Bearer token wins even when the operator
  // also stores a direct Anthropic key (OpenRouter's Claude Code guide requires this).
  return { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "", ...(key ? { ANTHROPIC_AUTH_TOKEN: key } : {}) };
}

// ── Writes (require an unlocked store; reseal in place, no re-prompt) ──────────

export function setSecret(name, value) {
  requireUnlocked();
  if (!NAME_PATTERN.test(String(name || ""))) {
    throw new Error(`invalid secret name: ${name || "<empty>"}`);
  }
  cache[name] = String(value ?? "");
  persist();
  applyProviderEnv(cache);
  return name;
}

export function removeSecret(name) {
  requireUnlocked();
  if (cache[name] === undefined) return false;
  delete cache[name];
  persist();
  applyProviderEnv(cache);
  return true;
}

// Escape hatch for an orphaned store sealed under a password no longer known — destructive, deletes the file outright.
export function discardSecrets() {
  try {
    rmSync(secretsFilePath());
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  lock();
}

export function resetSecretStoreForTests() {
  lock();
}

// ── Private helpers ───────────────────────────────────────────────────────────

function deriveKey(password, salt, params = SCRYPT_PARAMS) {
  return crypto.scryptSync(String(password ?? ""), salt, KEY_LENGTH, params);
}

function sealWithKey(secrets, key, salt) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    kdf: "scrypt",
    params: SCRYPT_PARAMS,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function openWithKey(blob, key) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  try {
    const plaintext = Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, "base64")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    // GCM tag mismatch is indistinguishable from a wrong key, by design.
    throw new Error("could not open secrets: wrong password or corrupted secrets file");
  }
}

function persist() {
  writeBlob(sealWithKey(cache, sealKey, sealSalt));
}

function applyProviderEnv(secrets) {
  for (const envVar of Object.values(RUNTIME_PROVIDER_ENV)) {
    if (secrets[envVar]) {
      if (!injectedProviderEnv.has(envVar)) {
        injectedProviderEnv.set(envVar, {
          existed: Object.prototype.hasOwnProperty.call(process.env, envVar),
          value: process.env[envVar]
        });
      }
      process.env[envVar] = secrets[envVar];
    } else {
      restoreProviderEnv(envVar);
    }
  }
}

function restoreProviderEnv(name = "") {
  const names = name ? [name] : [...injectedProviderEnv.keys()];
  for (const envVar of names) {
    const original = injectedProviderEnv.get(envVar);
    if (!original) continue;
    if (original.existed) process.env[envVar] = original.value;
    else delete process.env[envVar];
    injectedProviderEnv.delete(envVar);
  }
}

function requireUnlocked() {
  if (!cache) throw new Error("secret store is locked; sign in first");
}

function readBlob() {
  try {
    return JSON.parse(readFileSync(secretsFilePath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error; // a malformed file should fail loudly, not silently reset
  }
}

function writeBlob(blob) {
  const file = secretsFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(blob, null, 2)}\n`, { mode: 0o600 });
  return file;
}
