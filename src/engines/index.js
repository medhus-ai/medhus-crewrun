import { createClaudeAgentEngine } from "./claude-agent.js";
import { createCodexAgentEngine } from "./codex-agent.js";

// Engine contract: id, label, capabilities, startTurn({ ... }) -> { kill }, healthcheck(...) -> Promise<{ok,...}>

const ENGINES = new Map();

export const ENGINE_IDS = ["claude-agent", "codex-agent"];

export function getEngine(engineId) {
  if (!ENGINE_IDS.includes(engineId)) throw new Error(`Unsupported v6 engine: ${engineId || "<unset>"}. Use claude-agent or codex-agent.`);
  const id = engineId;
  if (!ENGINES.has(id)) {
    if (id === "claude-agent") ENGINES.set(id, createClaudeAgentEngine());
    else if (id === "codex-agent") ENGINES.set(id, createCodexAgentEngine());
  }
  return ENGINES.get(id);
}

export function setEngineForTests(engineId, engine) {
  if (engine === null) ENGINES.delete(engineId);
  else ENGINES.set(engineId, engine);
}
