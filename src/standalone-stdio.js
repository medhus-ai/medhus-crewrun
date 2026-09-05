import { createStandaloneRuntime } from "./standalone.js";
import { mcpRoleFromEnv, readMcpContextData, serveStdio } from "./mcp-stdio.js";

const context = readMcpContextData();
const runtime = createStandaloneRuntime({ targetRoot: context.targetRoot, env: { ...process.env, ...(context.crewHome ? { CREW_HOME: context.crewHome } : {}) } });
await serveStdio({ bridge: runtime.tools, role: mcpRoleFromEnv(), toolContext: context });
