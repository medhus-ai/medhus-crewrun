# Development

[Documentation](README.md) / Development

Use Node.js 20 or newer. SQLite is a runtime dependency; see
[native build requirements](security.md#installation) if installation needs a compiler.

```bash
npm install
npm test
npm pack --dry-run
```

The default suite covers runtime behavior, SQLite claims and recovery, console routes, and
mocked provider calls. CI runs on Linux with Node 20 and 24 and Windows with Node 20.
Live-provider and Docker tests are opt-in.

## Live tests

These commands make real provider calls or run Docker. Configure the corresponding credentials
or local vendor sign-in before using them:

```bash
CREW_LIVE_E2E=1 CREW_LIVE_CLAUDE=1 node --test test/live-e2e.test.js
CREW_LIVE_E2E=1 CREW_LIVE_CODEX=1 node --test test/live-e2e.test.js
CREW_LIVE_E2E=1 CREW_LIVE_OPENROUTER=1 node --test test/live-e2e.test.js
CREW_LIVE_E2E=1 CREW_LIVE_DOCKER=1 node --test test/live-e2e.test.js
```

OpenRouter uses `OPENROUTER_API_KEY`; `CREW_LIVE_OPENROUTER_MODEL` selects its model.
`CREW_LIVE_DOCKER_IMAGE` selects the Docker image. Claude and Codex subscription checks use
the local signed-in client rather than an ambient API key.

## Examples and contributions

Run `node examples/brief.mjs` from a checkout with a configured Claude sign-in or
`ANTHROPIC_API_KEY`. For OpenRouter, set `OPENROUTER_API_KEY` and
`CREW_EXAMPLE_RUNNER=openrouter-auto`. The [Slack example](../examples/slack/README.md) demonstrates
signed event intake and a host reply policy.

Keep shared runtime behavior independent of a particular product. Put domain-specific workflow
rules and branding in host applications. Update the relevant guide when behavior changes,
preserve documented compatibility, and add tests for changes to execution or delivery guarantees.
