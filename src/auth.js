import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { crewEnv, crewHome, crewDir } from "./crew-dirs.js";
import path from "node:path";

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 8;

const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 30000;

// Cookie name follows the crew directory so two hosts on one browser host never share a session.
export function sessionCookieName() {
  return `${crewDir().replace(/^\./, "")}_session`;
}

// Two credentials, one file. The operator password unlocks the secret store and
// every mutation; the optional viewer password grants a session that can read
// the cockpit and nothing else, so a team can watch the pipeline without
// holding the keys that spend money.
export const OPERATOR_ROLE = "operator";
export const VIEWER_ROLE = "viewer";

const SESSIONS = new Map();
let loginFailures = 0;
let loginLockedUntil = 0;

export function authFilePath() {
  const override = crewEnv("AUTH_FILE");
  return override ? path.resolve(override) : path.join(crewHome(), "cockpit-auth.json");
}

export function hasPassword() {
  const record = readAuthRecord();
  return Boolean(record?.salt && record?.hash);
}

// Returns a user-readable rejection reason, or null if acceptable.
export function passwordError(password) {
  const value = String(password || "");
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return "password must be alphanumeric (include at least one letter and one number)";
  }
  return null;
}

export function setPassword(password) {
  const value = String(password || "");
  const invalid = passwordError(value);
  if (invalid) {
    throw new Error(invalid);
  }
  // Rotating the operator password must not silently revoke viewer access.
  return writeAuthRecord({ ...digest(value), viewer: readAuthRecord()?.viewer || null });
}

export function verifyPassword(password) {
  return matches(password, readAuthRecord());
}

export function hasViewerPassword() {
  const viewer = readAuthRecord()?.viewer;
  return Boolean(viewer?.salt && viewer?.hash);
}

export function setViewerPassword(password) {
  const value = String(password || "");
  const invalid = passwordError(value);
  if (invalid) {
    throw new Error(invalid);
  }
  const record = readAuthRecord();
  if (!record?.salt || !record?.hash) {
    throw new Error("set the operator password first");
  }
  if (matches(value, record)) {
    throw new Error("the viewer password must differ from the operator password");
  }
  return writeAuthRecord({ ...record, viewer: digest(value) });
}

export function removeViewerPassword() {
  const record = readAuthRecord();
  if (!record) return "";
  for (const [token, role] of SESSIONS) {
    if (role === VIEWER_ROLE) SESSIONS.delete(token);
  }
  return writeAuthRecord({ ...record, viewer: null });
}

export function verifyViewerPassword(password) {
  return matches(password, readAuthRecord()?.viewer);
}

// ── Sessions (in-memory; a server restart requires re-login) ─────────────────

export function createSession(role = OPERATOR_ROLE) {
  const token = crypto.randomBytes(32).toString("hex");
  SESSIONS.set(token, role === VIEWER_ROLE ? VIEWER_ROLE : OPERATOR_ROLE);
  return token;
}

export function hasSession(token) {
  return Boolean(token) && SESSIONS.has(token);
}

export function sessionRole(token) {
  return (token && SESSIONS.get(token)) || "";
}

export function isViewerSession(token) {
  return sessionRole(token) === VIEWER_ROLE;
}

export function destroySession(token) {
  SESSIONS.delete(token);
}

// ── Login throttling ──────────────────────────────────────────────────────────

export function loginLockedForMs() {
  return Math.max(0, loginLockedUntil - Date.now());
}

export function recordLoginFailure() {
  loginFailures += 1;
  if (loginFailures >= MAX_LOGIN_FAILURES) {
    loginFailures = 0;
    loginLockedUntil = Date.now() + LOGIN_LOCK_MS;
  }
}

export function recordLoginSuccess() {
  loginFailures = 0;
  loginLockedUntil = 0;
}

export function resetAuthForTests() {
  SESSIONS.clear();
  loginFailures = 0;
  loginLockedUntil = 0;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function readAuthRecord() {
  try {
    return JSON.parse(readFileSync(authFilePath(), "utf8"));
  } catch {
    return null;
  }
}

function writeAuthRecord(record) {
  const file = authFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    version: 1,
    algorithm: "scrypt",
    params: SCRYPT_PARAMS,
    salt: record.salt,
    hash: record.hash,
    viewer: record.viewer || undefined,
    updated_at: new Date().toISOString()
  }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function digest(password) {
  const salt = crypto.randomBytes(16);
  return {
    salt: salt.toString("base64"),
    hash: crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS).toString("base64")
  };
}

function matches(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const salt = Buffer.from(record.salt, "base64");
  const expected = Buffer.from(record.hash, "base64");
  const actual = crypto.scryptSync(String(password || ""), salt, expected.length, record.params || SCRYPT_PARAMS);
  return crypto.timingSafeEqual(actual, expected);
}
