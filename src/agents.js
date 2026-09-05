export * from "./agent-spec.js";
import { createRoleCatalog } from "./roles.js";
export function createAgentCatalog(options = {}) { return createRoleCatalog({ ...options, legacyPaths: false }); }
