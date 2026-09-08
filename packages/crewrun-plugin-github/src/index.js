import { defineIntegrationPlugin } from "@medhus-ai/crewrun-plugin-sdk";

import { createGitHubAdapter } from "./adapter.js";
import { githubActions } from "./actions.js";
import { githubEvents, githubSubscription } from "./events.js";

export { createGitHubAdapter, createGitHubAppClient, installUrlFor, invokeGitHubAction, signGitHubAppJwt, withGitHubInstallationToken } from "./adapter.js";
export { githubActions, validateGitHubAction } from "./actions.js";
export { githubEvents, githubSubscription, normalizeGitHubEvent, verifyGitHubWebhook } from "./events.js";

export function createGitHubPlugin(options = {}) {
  return defineIntegrationPlugin({
    apiVersion: "crewrun.integration/v1",
    id: "github",
    label: "GitHub",
    description: "Governed GitHub App repository access and signed webhook deliveries.",
    capabilities: [
      { id: "repositories", label: "Repositories", description: "Read metadata for installed repositories.", direction: "read", scopes: ["metadata:read"] },
      { id: "contents", label: "Repository contents", description: "Read files, create branches, and commit bounded text changes.", direction: "both", scopes: ["contents:read", "contents:write"] },
      { id: "pull-requests", label: "Pull requests", description: "Read and create pull requests and submit reviews.", direction: "both", scopes: ["pull_requests:read", "pull_requests:write"] },
      { id: "issues", label: "Issues", description: "Read and create issues, comments, and additive labels.", direction: "both", scopes: ["issues:read", "issues:write"] },
      { id: "repository-events", label: "Repository events", description: "Receive signed GitHub App repository webhook deliveries.", direction: "read", scopes: ["webhooks:read"] }
    ],
    actions: githubActions,
    events: githubEvents,
    subscription: githubSubscription,
    metadata: {
      connectionKind: "github-app-installation",
      installUrlTemplate: "https://github.com/apps/{appSlug}/installations/new",
      requiredConfiguration: ["app ID", "app slug", "signed webhook verification", "operator-managed App JWT signer"],
      unsupported: ["personal access tokens", "repository administration", "membership", "settings", "deletion", "force pushes", "raw GitHub requests"]
    },
    adapter: createGitHubAdapter(options)
  });
}

// This default is credential-free and is safe to inspect in a console. A reference host creates
// a configured instance with an App ID, slug, webhook secret, and either a private key or a
// vault/HSM-backed signAppJwt function.
export const githubPlugin = createGitHubPlugin();
export default githubPlugin;
