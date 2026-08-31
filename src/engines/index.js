import { createCliEngine } from "./cli.js";
import { createClaudeAgentEngine } from "./claude-agent.js";
import { createCodexAgentEngine } from "./codex-agent.js";

// Engine contract: id, label, capabilities, startTurn({ ... }) -> { kill }, healthcheck(...) -> Promise<{ok,...}>

const ENGINES = new Map();

export const ENGINE_IDS = ["cli", "claude-agent", "codex-agent"];

export function getEngine(engineId) {
  const id = ENGINE_IDS.includes(engineId) ? engineId : "cli";
  if (!ENGINES.has(id)) {
    if (id === "claude-agent") ENGINES.set(id, createClaudeAgentEngine());
    else if (id === "codex-agent") ENGINES.set(id, createCodexAgentEngine());
    else ENGINES.set(id, createCliEngine());
  }
  return ENGINES.get(id);
}

export function setEngineForTests(engineId, engine) {
  if (engine === null) ENGINES.delete(engineId);
  else ENGINES.set(engineId, engine);
}
