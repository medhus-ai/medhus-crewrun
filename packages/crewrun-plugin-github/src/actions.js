const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const LABEL = /^[^\u0000-\u001f]{1,80}$/;
const MAX_TEXT = 65_000;

export const githubActions = Object.freeze([
  descriptor({
    id: "github.getRepository", capability: "repositories", label: "Get repository", description: "Read metadata for one installed repository.", risk: "read", scopes: ["metadata:read"],
    inputSchema: (z) => repositorySchema(z), validate: validateRepository
  }),
  descriptor({
    id: "github.getFile", capability: "contents", label: "Get repository file", description: "Read one selected text file from an installed repository.", risk: "read", scopes: ["contents:read"], scopeSets: [["contents:read"], ["contents:write"]],
    inputSchema: (z) => ({ ...repositorySchema(z), path: z.string(), ref: z.string().optional() }), validate: validateGetFile
  }),
  descriptor({
    id: "github.listPullRequests", capability: "pull-requests", label: "List pull requests", description: "List a bounded set of pull requests from an installed repository.", risk: "read", scopes: ["pull_requests:read"], scopeSets: [["pull_requests:read"], ["pull_requests:write"]],
    inputSchema: (z) => ({ ...repositorySchema(z), state: z.enum(["open", "closed", "all"]).optional(), maxResults: z.number().int().min(1).max(50).optional() }), validate: validateListPullRequests
  }),
  descriptor({
    id: "github.getPullRequest", capability: "pull-requests", label: "Get pull request", description: "Read one selected pull request from an installed repository.", risk: "read", scopes: ["pull_requests:read"], scopeSets: [["pull_requests:read"], ["pull_requests:write"]],
    inputSchema: (z) => ({ ...repositorySchema(z), number: z.number().int().positive() }), validate: validateNumberedResource
  }),
  descriptor({
    id: "github.getIssue", capability: "issues", label: "Get issue", description: "Read one selected issue from an installed repository.", risk: "read", scopes: ["issues:read"], scopeSets: [["issues:read"], ["issues:write"]],
    inputSchema: (z) => ({ ...repositorySchema(z), number: z.number().int().positive() }), validate: validateNumberedResource
  }),
  descriptor({
    id: "github.createBranch", capability: "contents", label: "Create branch", description: "Create a new branch from an existing branch. This external write requires approval.", risk: "external-write", approval: "required", scopes: ["contents:write"],
    inputSchema: (z) => ({ ...repositorySchema(z), name: z.string(), fromBranch: z.string() }), validate: validateCreateBranch
  }),
  descriptor({
    id: "github.commitFiles", capability: "contents", label: "Commit text files", description: "Commit bounded text-file changes to a branch without force-pushing or deleting files. This external write requires approval.", risk: "external-write", approval: "required", scopes: ["contents:write"],
    inputSchema: (z) => ({ ...repositorySchema(z), branch: z.string(), message: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })).min(1).max(10) }), validate: validateCommitFiles
  }),
  descriptor({
    id: "github.createPullRequest", capability: "pull-requests", label: "Create pull request", description: "Create a pull request between two existing branches. This external write requires approval.", risk: "external-write", approval: "required", scopes: ["pull_requests:write"],
    inputSchema: (z) => ({ ...repositorySchema(z), title: z.string(), head: z.string(), base: z.string(), body: z.string().optional() }), validate: validateCreatePullRequest
  }),
  descriptor({
    id: "github.createIssue", capability: "issues", label: "Create issue", description: "Create a plain-text issue. This external write requires approval.", risk: "external-write", approval: "required", scopes: ["issues:write"],
    inputSchema: (z) => ({ ...repositorySchema(z), title: z.string(), body: z.string().optional() }), validate: validateCreateIssue
  }),
  descriptor({
    id: "github.addIssueComment", capability: "issues", label: "Add issue comment", description: "Add one plain-text comment to an issue or pull request. This external write requires approval.", risk: "external-write", approval: "required", scopes: ["issues:write"],
    inputSchema: (z) => ({ ...repositorySchema(z), number: z.number().int().positive(), body: z.string() }), validate: validateIssueComment
  }),
  descriptor({
    id: "github.submitPullRequestReview", capability: "pull-requests", label: "Submit pull request review", description: "Submit a comment, approve, or request changes on a pull request. This external write requires approval.", risk: "external-write", approval: "required", scopes: ["pull_requests:write"],
    inputSchema: (z) => ({ ...repositorySchema(z), number: z.number().int().positive(), event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]), body: z.string().optional() }), validate: validatePullRequestReview
  }),
  descriptor({
    id: "github.addLabels", capability: "issues", label: "Add labels", description: "Add existing labels without removing other labels. This external write requires approval.", risk: "external-write", approval: "required", scopes: ["issues:write"],
    inputSchema: (z) => ({ ...repositorySchema(z), number: z.number().int().positive(), labels: z.array(z.string()).min(1).max(20) }), validate: validateAddLabels
  })
]);

export function validateGitHubAction(actionId, input = {}) {
  const action = githubActions.find((entry) => entry.id === String(actionId || ""));
  return action ? action.validate(input) : { ok: false, error: `unknown GitHub action: ${actionId || "<empty>"}` };
}

export function validateRepository(input = {}) {
  try { return { ok: true, input: repository(input) }; } catch (error) { return failed(error); }
}
export function validateGetFile(input = {}) {
  try { return { ok: true, input: { ...repository(input), path: filePath(input.path), ...(input.ref == null || input.ref === "" ? {} : { ref: branch(input.ref, "ref") }) } }; } catch (error) { return failed(error); }
}
export function validateListPullRequests(input = {}) {
  try {
    const state = input.state == null || input.state === "" ? "open" : String(input.state).trim();
    if (!new Set(["open", "closed", "all"]).has(state)) throw new Error("state must be open, closed, or all");
    return { ok: true, input: { ...repository(input), state, maxResults: number(input.maxResults, "maxResults", 20, 1, 50) } };
  } catch (error) { return failed(error); }
}
export function validateNumberedResource(input = {}) {
  try { return { ok: true, input: { ...repository(input), number: number(input.number, "number", null, 1, 1_000_000_000) } }; } catch (error) { return failed(error); }
}
export function validateCreateBranch(input = {}) {
  try { return { ok: true, input: { ...repository(input), name: branch(input.name, "name"), fromBranch: branch(input.fromBranch, "fromBranch") } }; } catch (error) { return failed(error); }
}
export function validateCommitFiles(input = {}) {
  try {
    const files = Array.isArray(input.files) ? input.files : [];
    if (!files.length || files.length > 10) throw new Error("files must contain one through 10 text files");
    const seen = new Set();
    const safeFiles = files.map((file) => {
      const path = filePath(file?.path);
      if (seen.has(path)) throw new Error("files must not contain the same path twice");
      seen.add(path);
      return { path, content: text(file?.content, "file content", MAX_TEXT) };
    });
    return { ok: true, input: { ...repository(input), branch: branch(input.branch, "branch"), message: text(input.message, "message", 256), files: safeFiles } };
  } catch (error) { return failed(error); }
}
export function validateCreatePullRequest(input = {}) {
  try { return { ok: true, input: { ...repository(input), title: text(input.title, "title", 256), head: branch(input.head, "head"), base: branch(input.base, "base"), ...(input.body == null ? {} : { body: text(input.body, "body", MAX_TEXT) }) } }; } catch (error) { return failed(error); }
}
export function validateCreateIssue(input = {}) {
  try { return { ok: true, input: { ...repository(input), title: text(input.title, "title", 256), ...(input.body == null ? {} : { body: text(input.body, "body", MAX_TEXT) }) } }; } catch (error) { return failed(error); }
}
export function validateIssueComment(input = {}) {
  const numbered = validateNumberedResource(input);
  if (!numbered.ok) return numbered;
  try { return { ok: true, input: { ...numbered.input, body: text(input.body, "body", MAX_TEXT) } }; } catch (error) { return failed(error); }
}
export function validatePullRequestReview(input = {}) {
  const numbered = validateNumberedResource(input);
  if (!numbered.ok) return numbered;
  try {
    const event = String(input.event || "").trim();
    if (!new Set(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).has(event)) throw new Error("event must be COMMENT, APPROVE, or REQUEST_CHANGES");
    return { ok: true, input: { ...numbered.input, event, ...(input.body == null ? {} : { body: text(input.body, "body", MAX_TEXT) }) } };
  } catch (error) { return failed(error); }
}
export function validateAddLabels(input = {}) {
  const numbered = validateNumberedResource(input);
  if (!numbered.ok) return numbered;
  try {
    const raw = Array.isArray(input.labels) ? input.labels : [];
    const labels = [...new Set(raw.map((label) => String(label || "").trim()).filter(Boolean))];
    if (!labels.length || labels.length > 20 || labels.some((label) => !LABEL.test(label))) throw new Error("labels must contain one through 20 safe label names");
    return { ok: true, input: { ...numbered.input, labels } };
  } catch (error) { return failed(error); }
}

function descriptor(value) { return Object.freeze(value); }
function repositorySchema(z) { return { owner: z.string(), repo: z.string() }; }
function repository(input) {
  const owner = String(input?.owner || "").trim();
  const repo = String(input?.repo || "").trim();
  if (!OWNER.test(owner)) throw new Error("owner must be a GitHub owner name");
  if (!REPOSITORY.test(repo)) throw new Error("repo must be a GitHub repository name");
  return { owner, repo };
}
function branch(value, name) {
  const result = String(value || "").trim();
  if (!BRANCH.test(result) || result.includes("..") || result.endsWith(".") || result.endsWith("/")) throw new Error(`${name} must be a safe Git branch name`);
  return result;
}
function filePath(value) {
  const result = String(value || "").trim();
  if (!result || result.length > 512 || result.startsWith("/") || result.includes("\\") || result.includes("\u0000")) throw new Error("path must be a relative repository file path");
  const parts = result.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || parts.includes(".git")) throw new Error("path must be a relative repository file path");
  return result;
}
function number(value, name, fallback, minimum, maximum) {
  const result = value == null ? fallback : Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  return result;
}
function text(value, name, maximum) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`${name} is required`);
  if (result.length > maximum) throw new Error(`${name} must not exceed ${maximum} characters`);
  return result;
}
function failed(error) { return { ok: false, error: error?.message || String(error) }; }
