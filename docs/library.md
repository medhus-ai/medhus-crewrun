# Library integration

[Documentation](README.md) / Library integration

Install the package and import the modules you need:

```bash
npm install medhus-crewrun
```

## Run a configured agent

The standalone runtime includes task storage, the usage ledger, and configured Slack/Gmail tools.
The project must already define the agent and have a working runner.

```js
import { createStandaloneRuntime } from "medhus-crewrun/standalone";

const runtime = createStandaloneRuntime({ targetRoot: "./my-project" });
try {
  const result = await runtime.runTurn("operations", "Prepare today's project brief.");
  console.log(result.text || result.reason);
} finally {
  await runtime.close();
}
```

`runTurn` records the turn and its results. Use `runtime.start()` to run the queue worker,
or `createUp` for schedules, check-ins, and lifecycle management. Outgoing actions remain queued
until reviewed and processed by a worker. See [runtime recovery](runtime-recovery.md).

For a runner without standalone task storage:

```js
import { createAgentRunner } from "medhus-crewrun/runner";

const runner = createAgentRunner();
const result = await runner.runAgentCapture({
  root: "./my-project",
  agent: "operations",
  prompt: "Prepare today's project brief."
});
```

Attach a tool bridge and storage appropriate to your application when using the lower-level runner.
The executable [brief example](../examples/brief.mjs) shows a governed custom tool registry.

## Supply a custom host

A host supplies application-specific tools, events, storage, or lifecycle behavior.
Load it with `crewrun up ./my-project --host ./host.mjs --console`, or from code:

```js
import { createUp, loadHostModule } from "medhus-crewrun/up";

const targetRoot = "/absolute/path/to/my-project";
const host = await loadHostModule("./host.mjs", { targetRoot });
const up = createUp({ targetRoot, host });
await up.start();
// Call await up.stop() during application shutdown.
```

Host modules export a plain object, a default factory, or `createHost({ targetRoot, log })`.
Optional hooks include `runTurn`, `runSchedule`, `enqueue`, event routing, housekeeping,
and lifecycle methods. `operations` supplies console snapshots and actions.
Providing `runTurn` keeps execution and storage under the host's control.

Use `createMcpBridge` to expose host tools to Claude in-process and Codex over stdio.
Pair it with `createToolBroker` and agent governance for permission checks.
A bridge serves the tools you define; it does not discover or proxy arbitrary remote MCP servers.
Codex and container integrations need host entry scripts for their child processes.

`configureCrew({ dirName, legacyEnvPrefix })` changes the project directory name and environment
prefix compatibility. Hosts also supply shared memory content, domain-specific tools, and product UI.

See the [Host API reference](host-api-v1.md), [Module reference](modules.md), and
[Slack event gateway example](../examples/slack/README.md).
