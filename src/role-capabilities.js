const REVIEW_ROLES = new Set(["code-reviewer", "qa-engineer", "security-reviewer"]);

const DEFAULT_BOUNDARY = [
  "## Control boundary",
  "The host application owns workflow state, remote writes, branch and isolation policy, and durable memory. Use the host's MCP tools for allowed control-plane actions; never bypass them with a shell, provider plugin, hook, or direct API call.",
  "Do not install or modify provider configuration, hooks, MCP servers, or durable memory."
];

// `subagentPrefix` names the provider-native helper agents so transcripts show the host's brand.
export function roleCapabilityProfile(role, { reviewOnly = false, subagentPrefix = "crew" } = {}) {
  const id = String(role || "").trim();
  const reviewer = reviewOnly || REVIEW_ROLES.has(id) || id.endsWith("-reviewer");
  const engineer = id === "engineer" || (!reviewer && id.endsWith("-engineer"));
  const subagents = engineer || reviewer;

  return {
    role: id,
    kind: reviewer ? "review" : engineer ? "implementation" : "coordination",
    subagents: {
      allowed: subagents,
      maxDepth: subagents ? 1 : 0,
      writable: engineer,
      parallelWriters: false,
      prefix: subagentPrefix
    },
    providerOwns: [
      "reasoning",
      "source and diff inspection",
      "bounded test execution",
      "context compaction"
    ],
    hostOwns: [
      "workflow state",
      "remote writes",
      "branch and isolation selection",
      "durable memory approval"
    ]
  };
}

// `boundary` replaces the neutral control-boundary text; `notes[role]` adds role-specific lines.
export function roleCapabilityInstructions(capabilities, { boundary = DEFAULT_BOUNDARY, notes = {} } = {}) {
  const profile = capabilities || roleCapabilityProfile("");
  const lines = [...boundary, ...(notes[profile.role] || [])];
  if (!profile.subagents.allowed) {
    lines.push("Do not spawn provider subagents or agent teams in this role.");
    return lines.join("\n");
  }
  lines.push(
    "You may use provider-native subagents for a large, bounded task inside this stage.",
    "Subagents are depth-one helpers: they inherit this role's restrictions, cannot change host or remote state, and must return their result to you. You remain responsible for the final answer, verdict, diff, and test evidence."
  );
  if (profile.subagents.writable) {
    lines.push("Use at most one writing subagent at a time. Give it a bounded, disjoint file assignment; use additional subagents as read-only investigators to avoid conflicting edits.");
  } else {
    lines.push("All review subagents are read-only. Use separate review lenses such as correctness, security, tests, compatibility, or performance, then deduplicate findings into one verdict.");
  }
  return lines.join("\n");
}

export function claudeSubagentDefinitions(capabilities, { allowShell = false } = {}) {
  if (!capabilities?.subagents?.allowed) return {};
  const prefix = capabilities.subagents.prefix || "crew";
  const researchTools = ["Read", "Grep", "Glob"];
  const agents = {
    [`${prefix}-investigator`]: {
      description: "Investigate one bounded code, test, correctness, security, compatibility, or performance question and return evidence to the parent.",
      prompt: "Investigate only the delegated question. Stay read-only, cite concrete files and evidence, do not contact remote services, and return a concise result to the parent agent.",
      tools: researchTools,
      disallowedTools: ["Agent", "Edit", "Write", "WebSearch", "WebFetch"],
      model: "inherit",
      maxTurns: 12
    }
  };
  if (capabilities.subagents.writable) {
    agents[`${prefix}-implementation-worker`] = {
      description: "Implement one bounded, disjoint part of a large change when the parent explicitly assigns owned files.",
      prompt: "Implement only the delegated change in the assigned files. Do not spawn agents, contact remote services, change branches, install configuration, or write durable memory. Report changed files and verification to the parent.",
      tools: [...researchTools, "Edit", "Write", ...(allowShell ? ["Bash"] : [])],
      disallowedTools: ["Agent", "WebSearch", "WebFetch"],
      model: "inherit",
      maxTurns: 20
    };
  }
  return agents;
}

export function claudeSubagentToolRule(capabilities) {
  if (!capabilities?.subagents?.allowed) return "";
  const prefix = capabilities.subagents.prefix || "crew";
  return capabilities.subagents.writable
    ? `Agent(${prefix}-investigator,${prefix}-implementation-worker)`
    : `Agent(${prefix}-investigator)`;
}
