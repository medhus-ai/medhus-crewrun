import path from "node:path";

import { createConversationStore } from "./conversations.js";
import { listRoleSpecs } from "./role-spec.js";
import { listSchedules } from "./schedules.js";
import { listSkills } from "./skills.js";
import { createMcpBridge } from "./mcp.js";

export const HELPER_ROLE = "crew-helper";
const AGENT_PURPOSE = "console-chat";
const HELPER_PURPOSE = "console-helper";
const CHAT_TIMEOUT_MS = 120_000;

export function createConsoleChatService({ targetRoot, getDb, createRunner, createHelperRunner, log = () => {} } = {}) {
  if (!targetRoot) throw new Error("console chat needs a target root");
  const root = path.resolve(targetRoot);
  if (typeof getDb !== "function") throw new Error("console chat needs a database handle");
  if (typeof createRunner !== "function") throw new Error("console chat needs an agent runner");
  const conversations = createConversationStore({ getDb });

  function purposeFor(role) {
    return role === HELPER_ROLE ? HELPER_PURPOSE : AGENT_PURPOSE;
  }

  function assertRole(role) {
    const value = String(role || "").trim();
    if (value === HELPER_ROLE) return value;
    if (!listRoleSpecs(root)[value]) throw new Error("Agent not found.");
    return value;
  }

  function existing(role) {
    return conversations.listConversations({ targetRoot: root, role, purpose: purposeFor(role), limit: 1 })[0] || null;
  }

  function getChat({ role } = {}) {
    const agent = assertRole(role);
    const thread = existing(agent);
    return {
      id: thread?.id || null,
      role: agent,
      title: thread?.title || chatTitle(agent),
      updatedAt: thread?.updated_at || "",
      messages: thread ? conversations.listMessages(thread.id) : []
    };
  }

  function listChats({ limit = 12 } = {}) {
    const rows = conversations.listConversations({ targetRoot: root, limit: Math.min(Math.max(Number(limit) || 12, 1), 100) });
    return rows
      .filter((row) => row.purpose === AGENT_PURPOSE || row.purpose === HELPER_PURPOSE)
      .map((row) => ({ id: row.id, role: row.role, title: row.title || chatTitle(row.role), updatedAt: row.updated_at, purpose: row.purpose }));
  }

  async function sendChat({ role, message } = {}) {
    const agent = assertRole(role);
    const input = String(message || "").trim();
    if (!input) throw new Error("Write a message before sending it.");
    if (input.length > 20_000) throw new Error("A chat message must be at most 20000 characters.");
    const conversationId = conversations.getOrCreateConsoleConversation({
      targetRoot: root,
      role: agent,
      title: chatTitle(agent),
      purpose: purposeFor(agent)
    });
    conversations.appendMessage({ conversationId, author: "user", content: input });
    const thread = conversations.getConversation(conversationId);
    const messages = conversations.listMessages(conversationId);
    const runner = agent === HELPER_ROLE && createHelperRunner ? createHelperRunner() : createRunner();
    const result = await captureTurn({
      runner,
      root,
      role: agent,
      messages,
      resumeSessionId: thread?.engine_session_id || null,
      worktree: thread?.worktree_dir ? { dir: thread.worktree_dir, branch: thread.worktree_branch } : null,
      context: agent === HELPER_ROLE ? helperInstructions(root) : "",
      modeOverride: agent === HELPER_ROLE ? "propose" : undefined,
      log
    });
    const response = result.ok ? result.text || "Completed without a text response." : `I could not complete that chat turn: ${result.reason || "the runner stopped"}`;
    conversations.appendMessage({ conversationId, author: agent, content: response, usage: result.usage });
    if (result.engineSessionId) conversations.setConversationEngineSession(conversationId, result.engineSessionId);
    if (result.workdir || result.branch) conversations.setConversationWorktree(conversationId, result.workdir, result.branch);
    if (!thread?.title || thread.title === chatTitle(agent)) conversations.setConversationTitle(conversationId, titleFrom(input, agent));
    return getChat({ role: agent });
  }

  return { getChat, listChats, sendChat, conversations };
}

export function createConsoleHelperBridge({ targetRoot } = {}) {
  if (!targetRoot) throw new Error("crew helper needs a target root");
  const root = path.resolve(targetRoot);
  return createMcpBridge({
    serverName: "crew-helper",
    label: "Crew helper",
    crewTools: false,
    instructions: "Use this internal read-only tool to inspect the current crew before you give setup guidance. Never request credentials or make a persistent change; draft a clear confirmation for the operator instead.",
    toolsForRole: (role) => role === HELPER_ROLE ? ["crew.status"] : [],
    describe: () => "Read the installed agents, skills, and scheduled tasks so setup guidance stays current.",
    inputSchema: () => ({}),
    call: () => helperStatus(root)
  });
}

export function helperStatus(targetRoot) {
  if (!targetRoot) throw new Error("crew helper needs a target root");
  const root = path.resolve(targetRoot);
  const agents = Object.values(listRoleSpecs(root)).map((spec) => ({ role: spec.role, title: spec.title || spec.role }));
  const skills = listSkills({ targetRoot: root }).map((skill) => ({ id: skill.id, description: skill.description, roles: skill.roles }));
  const scheduled = listSchedules({ targetRoot: root }).map((task) => ({ role: task.role, id: task.id, title: task.title, cron: task.cron, enabled: task.enabled }));
  return { agents, skills, scheduled };
}

function helperInstructions(targetRoot) {
  const status = helperStatus(targetRoot);
  return [
    "## Crew helper",
    "You help the operator set up and govern this CrewRun workspace. Ask only the smallest blocking questions, then draft the next safe change for the operator to confirm in the normal console form. Do not claim you changed files, schedules, skills, permissions, or connectors yourself.",
    "",
    "For a new agent, collect: slug, responsibility, a concise instruction, model/default preference, and the authority or data boundary.",
    "For an agent change, collect: which agent, what should change, and whether the current contract must change.",
    "For a skill, collect: reusable purpose, steps/body, applicable agents, scope, and why it is repeatable. Explain that skills are proposed first and approved in Approvals.",
    "For a scheduled task, collect: agent, task title, instruction, repeat rule, time, local timezone, and enabled state. CrewRun schedules remain the source of truth.",
    "For integrations, never ask for credentials in chat. Direct the operator to Integrations and explain that outgoing actions stay approval-gated.",
    "",
    `Current agents: ${status.agents.map((entry) => entry.role).join(", ") || "none"}.`,
    `Current skills: ${status.skills.map((entry) => entry.id).join(", ") || "none"}.`,
    `Current scheduled tasks: ${status.scheduled.map((entry) => `${entry.role}:${entry.id}`).join(", ") || "none"}.`
  ].join("\n");
}

function chatTitle(role) {
  return role === HELPER_ROLE ? "Crew helper" : `${String(role)} chat`;
}

function titleFrom(message, role) {
  const text = String(message || "").replace(/\s+/g, " ").trim().slice(0, 72);
  return text || chatTitle(role);
}

async function captureTurn({ runner, root, role, messages, resumeSessionId, worktree, context, modeOverride, log }) {
  const attempt = async (sessionId) => new Promise((resolve) => {
    const lines = [];
    let handle;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, workdir: handle?.workdir || null, branch: handle?.branch || null });
    };
    const timer = setTimeout(() => {
      try { handle?.kill?.("SIGTERM"); } catch { /* best effort */ }
      finish({ ok: false, reason: "chat timed out", text: lines.join("\n").trim() });
    }, CHAT_TIMEOUT_MS);
    timer.unref?.();
    try {
      handle = runner.startAgentTurn({
        targetRoot: root,
        agent: role,
        messages,
        resumeSessionId: sessionId,
        worktree,
        context,
        modeOverride,
        onLine: (line) => { if (String(line || "").trim()) lines.push(String(line)); },
        onStatus: (status) => log(`${role}: ${status}`),
        onError: (error) => lines.push(`[runner-error] ${error?.message || error}`),
        onClose: ({ code, stderr, usage, engineSessionId } = {}) => {
          const text = lines.join("\n").trim();
          if (code === 0 || code == null) finish({ ok: true, text, usage, engineSessionId });
          else finish({ ok: false, reason: `runner exited ${code}${stderr ? `: ${stderr}` : ""}`, text, usage, engineSessionId });
        }
      });
    } catch (error) {
      finish({ ok: false, reason: error?.message || String(error), text: "" });
    }
  });
  let result = await attempt(resumeSessionId);
  if (!result.ok && resumeSessionId && runner.isLikelyStaleSessionError?.(result.reason)) result = await attempt(null);
  return result;
}
