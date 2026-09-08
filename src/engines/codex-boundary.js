import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkspace, workspaceIdentity } from "../workspace-manifest.js";
import { loadRoleSpec } from "../role-spec.js";

const sdkEntry = import.meta.resolve("@openai/codex-sdk");
const require = createRequire(sdkEntry);
export const VERIFIED_CODEX_VERSION = "0.152.0";

export function assertCodexBoundary() {
  if (process.platform !== "linux") throw new Error("Governed Codex isolation is currently verified on Linux only.");
  for (const manifest of [path.join(path.dirname(fileURLToPath(sdkEntry)), "..", "package.json"), require.resolve("@openai/codex/package.json")]) {
    if (JSON.parse(readFileSync(manifest, "utf8")).version !== VERIFIED_CODEX_VERSION) {
      throw new Error(`Governed Codex requires verified SDK/CLI ${VERIFIED_CODEX_VERSION}; rerun boundary verification before upgrading.`);
    }
  }
}

export function codexBoundaryId(targetRoot, role, profile) {
  return createHash("sha256").update(JSON.stringify({
    boundary: 1, workspace: readWorkspace(targetRoot) || workspaceIdentity(targetRoot), role,
    spec: loadRoleSpec(targetRoot, role), profile
  })).digest("hex");
}

export const CODEX_BOUNDARY_CONFIG = Object.freeze({
  suppress_unstable_features_warning: true,
  approval_policy: "never",
  default_permissions: "crew-governed",
  // No native filesystem reads or writes, including the native patch handler.
  // Model transport and our authenticated MCP transport run outside this sandbox.
  permissions: { "crew-governed": { filesystem: { "/": "deny" }, network: { enabled: false } } },
  features: {
    shell_tool: false, unified_exec: false, shell_snapshot: false, view_image: false,
    browser_use: false, browser_use_external: false, browser_use_full_cdp_access: false,
    computer_use: false, apps: false, plugins: false, remote_plugin: false,
    hooks: false, memories: false, multi_agent: false, multi_agent_v2: false,
    // Some models require the isolated JS orchestration surface. It receives the
    // same restricted tool registry; this does not enable shell or filesystem IO.
    code_mode: false, code_mode_host: true, code_mode_only: false,
    image_generation: false, artifact: false, goals: false, skill_search: false,
    skill_mcp_dependency_install: false, workspace_dependencies: false,
    tool_suggest: false, auth_elicitation: false, skip_host_skill_discovery: true,
    request_permissions_tool: false, default_mode_request_user_input: false
  },
  agents: { enabled: false, max_depth: 1, max_threads: 1 },
  memories: { use_memories: false, generate_memories: false },
  project_doc_max_bytes: 0, project_doc_fallback_filenames: [],
  web_search: "disabled"
});
