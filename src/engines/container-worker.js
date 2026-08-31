import { pathToFileURL } from "node:url";

import { PROTOCOL } from "./container.js";
import { getEngine } from "./index.js";

// Runs one engine turn inside the container and streams events to the parent over stdout.
// Hosts wrap this in their own entry script to re-attach their tool bridge.
export async function runContainerWorker({ engineId, tools = null, stdin = process.stdin, stdout = process.stdout } = {}) {
  let source = "";
  for await (const chunk of stdin) source += chunk;

  const emit = (type, value) => {
    stdout.write(`${PROTOCOL}${JSON.stringify({ type, value })}\n`);
  };

  try {
    const input = JSON.parse(source || "{}");
    const engine = getEngine(engineId);
    await new Promise((resolve) => {
      engine.startTurn({
        ...input,
        tools,
        onLine: (value) => emit("line", value),
        onPartialText: (value) => emit("partial", value),
        onStatus: (value) => emit("status", value),
        onError: (error) => emit("error", error?.message || String(error)),
        onClose: (value) => { emit("close", value); resolve(); }
      });
    });
  } catch (error) {
    emit("error", error?.stack || error?.message || String(error));
    emit("close", { code: 1, stderr: error?.message || String(error), usage: null, engineSessionId: null });
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  await runContainerWorker({ engineId: String(process.argv[2] || "") });
}
