import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const Database = await import("better-sqlite3")
  .then((module) => { new module.default(":memory:").close(); return module.default; })
  .catch(() => null);
const sqlite = Database ? test : test.skip;

import { createConsoleChatService, createConsoleHelperBridge, HELPER_ROLE } from "../src/console-chat.js";

sqlite("console chat resumes one durable thread per agent", async (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "crew-console-chat-"));
  const root = path.join(parent, "repo");
  mkdirSync(path.join(root, ".crew", "roles"), { recursive: true });
  writeFileSync(path.join(root, ".crew", "roles", "ops.json"), JSON.stringify({ title: "Operations" }));
  const db = new Database(":memory:");
  t.after(() => { db.close(); rmSync(parent, { recursive: true, force: true }); });
  const calls = [];
  const runner = {
    startAgentTurn({ agent, messages, resumeSessionId, modeOverride, onLine, onClose }) {
      calls.push({ agent, messages, resumeSessionId, modeOverride });
      queueMicrotask(() => { onLine(`Reply ${calls.length}`); onClose({ code: 0, engineSessionId: `session-${calls.length}` }); });
      return { kill() {} };
    },
    isLikelyStaleSessionError: () => false
  };
  const chats = createConsoleChatService({ targetRoot: root, getDb: () => db, createRunner: () => runner, createHelperRunner: () => runner });
  const first = await chats.sendChat({ role: "ops", message: "First question" });
  const second = await chats.sendChat({ role: "ops", message: "Second question" });
  assert.equal(first.id, second.id);
  assert.equal(calls[1].resumeSessionId, "session-1");
  assert.deepEqual(second.messages.map((message) => message.author), ["user", "ops", "user", "ops"]);
  const helper = await chats.sendChat({ role: HELPER_ROLE, message: "Help me add an agent" });
  assert.equal(helper.role, HELPER_ROLE);
  assert.equal(calls[2].modeOverride, "propose");
  assert.deepEqual(chats.listChats().map((entry) => entry.role).sort(), [HELPER_ROLE, "ops"]);

  const helperBridge = createConsoleHelperBridge({ targetRoot: root });
  const tools = helperBridge.toolHandlers({ role: HELPER_ROLE });
  assert.deepEqual(tools.map((tool) => tool.toolName), ["crew.status"]);
  const status = await tools[0].invoke({});
  assert.equal(status.structuredContent.agents[0].role, "ops");
});
