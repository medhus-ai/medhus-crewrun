import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crewHome } from "./crew-dirs.js";
import { createConnectorRegistry } from "./connectors.js";
import { createActionApprovalPolicy, getActionApproval } from "./action-approvals.js";
import { createRoleGovernance } from "./role-contract.js";
import { listRoleSpecs, loadRoleSpec } from "./role-spec.js";
import { createMcpBridge } from "./mcp.js";
import { createAgentRunner } from "./runner.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.";
const PROVIDERS = ["slack", "gmail"];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function standaloneStatePath(targetRoot, env = process.env) {
  return path.join(crewHome(env), "connections", `${hash(path.resolve(targetRoot)).slice(0, 24)}.json`);
}

function readState(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { connections: {}, pending: {} }; throw error; }
}

function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

// The standalone adapter owns provider credentials and exact review payloads in
// a private operator file, outside the repository. Hosts can still replace it.
export function createStandaloneRuntime({ targetRoot, env = process.env, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  if (!targetRoot) throw new Error("standalone runtime requires targetRoot");
  const root = path.resolve(targetRoot);
  const file = standaloneStatePath(root, env);
  const policy = createActionApprovalPolicy({ targetRoot: root, env });
  const approvedDrafts = new Map();
  let runner;

  async function request(url, token, body, method = body ? "POST" : "GET") {
    let response;
    const form = url === "https://oauth2.googleapis.com/token";
    try {
      response = await fetchImpl(url, {
        method, redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" } : {}) },
        ...(body ? { body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) } : {})
      });
    } catch { throw new Error("The service could not be reached. Check your connection and try again."); }
    if (!response.ok) throw new Error(`Service request failed (HTTP ${response.status}).${response.status === 401 ? " Reconnect this account in Integrations." : ""}`);
    const result = await response.json();
    if (result.ok === false || result.error) throw new Error("The service rejected the request. Check the account permissions in Integrations.");
    return { result, scopes: response.headers?.get("x-oauth-scopes") || "" };
  }

  async function tokenFor(connection) {
    if (connection.provider !== "gmail" || !connection.refreshToken) return connection.accessToken;
    const { result } = await request("https://oauth2.googleapis.com/token", "", {
      grant_type: "refresh_token", client_id: connection.clientId,
      client_secret: connection.clientSecret, refresh_token: connection.refreshToken
    });
    if (!result.access_token) throw new Error("Gmail did not return an access token. Reconnect in Integrations.");
    if (result.scope) connection.scopes = String(result.scope).split(" ").filter(Boolean);
    return result.access_token;
  }

  async function draftSnapshot(connection, draftId) {
    const { result } = await request(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}?format=raw`, await tokenFor(connection));
    if (!result.message?.raw) throw new Error("Gmail draft is empty or unavailable.");
    return { raw: result.message.raw, digest: hash(result.message.raw) };
  }

  const governance = createRoleGovernance({
    targetRoot: root, env,
    getContract: (agent) => loadRoleSpec(root, agent)?.contract,
    requestApproval: async (request_) => {
      const connection = readState(file).connections[request_.connectionId];
      if (!connection) throw new Error("This account is disconnected.");
      const draft = request_.action === "gmail.sendDraft" ? await draftSnapshot(connection, request_.input.draftId) : null;
      // Connection replacement and draft edits invalidate an earlier review.
      const input = { ...request_.input, connectionRevision: connection.revision, ...(draft ? { draftDigest: draft.digest } : {}) };
      const result = policy.requestApproval({ ...request_, input });
      if (result.status === "approved" && draft) approvedDrafts.set(result.id, draft.raw);
      if (result.status === "pending") {
        const state = readState(file);
        state.pending[result.id] = { role: request_.role, action: request_.action, connectionId: request_.connectionId, input: request_.input, connectionRevision: connection.revision, ...(draft ? { draftDigest: draft.digest, preview: Buffer.from(draft.raw, "base64url").toString("utf8") } : {}) };
        saveState(file, state);
      }
      return result;
    }
  });

  function registry() {
    const state = readState(file);
    const specs = listRoleSpecs(root);
    return createConnectorRegistry({
      connections: Object.values(state.connections).map((connection) => ({ id: connection.provider, provider: connection.provider, status: "connected", scopes: connection.scopes })),
      roleActions: Object.fromEntries(Object.entries(specs).map(([agent, spec]) => [agent, (spec.contract?.authority?.tools || []).map((tool) => tool.name)])),
      roleConnections: Object.fromEntries(Object.keys(specs).map((agent) => [agent, PROVIDERS])),
      gmailRead: state.connections.gmail?.gmailRead === true,
      governance,
      invoke: async ({ action, connectionId, input, approvalRecord }) => {
        const connection = readState(file).connections[connectionId];
        if (!connection) throw new Error("This account is disconnected.");
        const token = await tokenFor(connection);
        if (action === "slack.postMessage" || action === "slack.replyToMention") {
          const { result } = await request("https://slack.com/api/chat.postMessage", token, { channel: input.channel, text: input.text, mrkdwn: false, unfurl_links: false, unfurl_media: false, ...(input.threadTs ? { thread_ts: input.threadTs } : {}) });
          return { ok: true, channel: result.channel, ts: result.ts };
        }
        if (action === "gmail.sendDraft") {
          const raw = approvedDrafts.get(approvalRecord?.id);
          approvedDrafts.delete(approvalRecord?.id);
          if (!raw) throw new Error("The reviewed Gmail draft is unavailable. Submit it again for approval.");
          const { result } = await request("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", token, { id: input.draftId, message: { raw } });
          return { ok: true, id: result.id, threadId: result.threadId };
        }
        if (action === "gmail.searchMetadata") {
          const params = new URLSearchParams({ q: input.query, maxResults: String(input.maxResults) });
          const { result } = await request(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, token);
          return { messages: (result.messages || []).map(({ id, threadId }) => ({ id, threadId })) };
        }
        if (action === "gmail.getMessage") {
          const { result } = await request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(input.messageId)}?format=full`, token);
          return { id: result.id, threadId: result.threadId, snippet: result.snippet, payload: result.payload };
        }
        throw new Error("Unsupported connector action");
      }
    });
  }

  const tools = createMcpBridge({
    serverName: "crewrun", label: "Crewrun tools", governance,
    stdioServerEntry: fileURLToPath(new URL("./standalone-stdio.js", import.meta.url)),
    serializeContext: (context) => ({ targetRoot: root, roleOptions: context.roleOptions || {}, crewHome: crewHome(env) }),
    toolsForRole: (...args) => registry().toolsForRole(...args),
    describe: (...args) => registry().describe(...args),
    inputSchema: (...args) => registry().inputSchema(...args),
    validate: (...args) => registry().validate(...args),
    actionPolicy: (...args) => registry().actionPolicy(...args),
    call: (...args) => registry().call(...args)
  });

  const operations = {
    async getSnapshot() {
      const state = readState(file);
      return {
        connectors: PROVIDERS.map((provider) => ({
          id: provider, provider, label: provider === "gmail" ? "Gmail" : "Slack", localSetup: true,
          description: provider === "slack" ? "Prepare channel updates and thread replies for your review." : "Review and send existing drafts, with optional inbox access.",
          status: state.connections[provider] ? "connected" : "not connected",
          accountLabel: state.connections[provider]?.account || "",
          capabilities: provider === "slack" ? ["Post message", "Reply in a thread"] : ["Send existing draft", ...(state.connections.gmail?.gmailRead ? ["Search and read email"] : [])]
        })),
        approvals: policy.list().map((approval) => {
          const pending = state.pending[approval.id];
          return { ...approval, source: "crewrun", summary: pending ? `${pending.action}\n${pending.preview || JSON.stringify(pending.input, null, 2)}` : approval.summary };
        }),
        audit: governance.audit.list()
      };
    },
    async connect({ connectorId, credentials = {} }) {
      if (!PROVIDERS.includes(connectorId)) throw new Error("Choose Slack or Gmail.");
      const clean = (key) => String(credentials[key] || "").trim();
      const connection = { provider: connectorId, accessToken: clean("access_token"), clientId: clean("client_id"), clientSecret: clean("client_secret"), refreshToken: clean("refresh_token"), gmailRead: credentials.gmail_read === "1", revision: hash([Date.now(), Math.random()]) };
      if (connectorId === "slack") {
        if (!/^xox[bp]-[^\s]{10,}$/.test(connection.accessToken)) throw new Error("Enter a Slack bot or user OAuth token.");
        const checked = await request("https://slack.com/api/auth.test", connection.accessToken, {});
        connection.scopes = checked.scopes.split(",").map((scope) => scope.trim()).filter(Boolean);
        if (!connection.scopes.includes("chat:write")) throw new Error("This Slack app needs chat:write. Add the scope and reinstall the app.");
        connection.account = checked.result.team || checked.result.user || "Slack workspace";
      } else {
        if (!connection.clientId || !connection.clientSecret || !connection.refreshToken) throw new Error("Enter your Google OAuth client ID, client secret, and refresh token for unattended access.");
        await tokenFor(connection);
        connection.scopes ||= [];
        if (!connection.scopes.some((scope) => [GMAIL_SCOPE + "compose", GMAIL_SCOPE + "modify", "https://mail.google.com/"].includes(scope))) throw new Error("Gmail needs gmail.compose permission to review and send existing drafts.");
        if (connection.gmailRead && !connection.scopes.some((scope) => [GMAIL_SCOPE + "readonly", GMAIL_SCOPE + "modify", "https://mail.google.com/"].includes(scope))) throw new Error("Gmail reads need gmail.readonly permission.");
        connection.account = "Google account";
        delete connection.accessToken;
      }
      const state = readState(file);
      state.connections[connectorId] = connection;
      saveState(file, state);
      return "/connectors";
    },
    disconnect({ connectorId }) {
      if (!PROVIDERS.includes(connectorId)) throw new Error("Unknown connection");
      const state = readState(file);
      delete state.connections[connectorId];
      for (const [id, pending] of Object.entries(state.pending)) if (pending.connectionId === connectorId) delete state.pending[id];
      saveState(file, state);
      return "/connectors";
    },
    async afterApproval({ id, action }) {
      const state = readState(file);
      const pending = state.pending[id];
      if (!pending) return;
      if (action === "approve") {
        const connection = state.connections[pending.connectionId];
        if (!connection || connection.revision !== pending.connectionRevision) throw new Error("The account changed. Ask the agent to submit a new request.");
        if (pending.draftDigest && (await draftSnapshot(connection, pending.input.draftId)).digest !== pending.draftDigest) throw new Error("The draft changed after review. Ask the agent to submit it again.");
        const approval = getActionApproval({ targetRoot: root, approvalId: id, env });
        if (approval?.status !== "approved") throw new Error("This action has not been approved.");
        await registry().call({ role: pending.role, toolName: pending.action, input: { ...pending.input, connectionId: pending.connectionId } });
      }
      const latest = readState(file);
      delete latest.pending[id];
      saveState(file, latest);
    }
  };

  return {
    tools, operations,
    runTurn(agent, prompt, meta = {}) {
      runner ||= createAgentRunner({ tools });
      return runner.runAgentCapture({ root, agent, prompt, label: meta.label || agent, log });
    }
  };
}
