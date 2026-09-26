import { existsSync } from "node:fs";
import { platformInfo, nodeVersionInfo, wslInfo } from "./platform.js";
import { knowledgeInstallation } from "./knowledge-process.js";

// Read-only diagnostics. Never installs dependencies, starts workers or reads credentials.
// Presence checks are not a successful sandbox/inference probe.
export function platformDoctor({ platform = process.platform, arch = process.arch,
  node = process.versions.node, installation = knowledgeInstallation(),
  hasDescriptorReads = platform === "linux" && existsSync("/proc/self/fd"),
  wsl = wslInfo() } = {}) {
  const linux = platform === "linux";
  const status = (ready, reason) => ({ status: ready ? "prerequisites-present" : "unavailable", reason });
  return {
    schemaVersion: 1,
    platform: platformInfo({ platform, arch }),
    node: nodeVersionInfo(node),
    wsl,
    capabilities: {
      knowledgeRead: status(linux && hasDescriptorReads,
        "Race-resistant knowledge reads currently require Linux descriptor-relative access."),
      knowledgeSearch: status(linux && hasDescriptorReads && installation.sandbox && installation.qmd && Number(node.split(".")[0]) >= 22,
        "Requires Linux, bubblewrap, Node 22+, QMD and readable scoped sources; hybrid search also needs verified model setup."),
      officeParsing: status(linux && hasDescriptorReads && installation.sandbox && installation.docling,
        "Requires Linux, bubblewrap and the dedicated Docling environment."),
      codexBoundary: { status: linux ? "platform-eligible" : "unavailable",
        reason: "Linux boundary only; pinned SDK/CLI, credentials and live verification are separate checks." },
      desktop: { status: "build-verification-required", reason: "Shared Tauri shell and headless launcher target Linux, Windows and macOS; native builds and webviews require target-specific verification." }
    },
    notes: ["No sandbox or model was executed. Prerequisites present does not mean live verified.",
      "Unsupported boundaries have no unsandboxed fallback."]
  };
}

export function formatPlatformDoctor(report) {
  return [report.platform.message, report.node.message,
    ...Object.entries(report.capabilities).map(([name, value]) => `${name}: ${value.status} — ${value.reason}`),
    ...report.notes].join("\n");
}
