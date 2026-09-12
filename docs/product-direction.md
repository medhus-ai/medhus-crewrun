# Roadmap

[Documentation](README.md) / Roadmap

Crewrun focuses on recurring work that produces a useful, reviewable result across the tools a
team already uses. The priorities below are planned improvements, not delivery commitments.
See [Capabilities and limits](state.md) for current support.

## Integration hosting direction

**Current release: self-hosted.** Users own their provider app registrations, credentials,
runtime and workspace. CrewRun connects directly to provider APIs, with Tailscale Funnel as
the recommended HTTPS setup for callbacks and webhooks only; the console stays private.
Continue improving this guided setup without introducing a required CrewRun-hosted service.

**Future option: Easy Connect.** Explore an opt-in CrewRun-managed authorization service
and registered provider apps so users can connect through browser consent without creating
their own apps. This is a future direction, not an implemented feature or release commitment.
The self-hosted path must remain available independently.

Before implementation, define account isolation, token custody and refresh, revocation,
provider verification requirements, operating costs, and behavior during service outages.
Keep agents, workspace data and execution local by default, and make any additional hosted
credential/data handling explicit to the user. No provider registration, cloud deployment,
or migration to shared OAuth is authorized by this roadmap.

## Planned improvements

| Priority | Intended outcome |
|---|---|
| Easier setup | Guided provider checks, browser OAuth consent, maintained examples, and a sample-data trial |
| Outcome evaluation | Repeatable checks for factual grounding, recipient accuracy, completion, and correction effort |
| Spending controls | Budget reservations and runtime enforcement beyond recorded-spend reporting |
| Reviewed learning updates | Previews, rollback, and evaluation of proposed context or Skill changes |

A representative workflow is a client operations brief: gather evidence, identify overdue
commitments, prepare an update, obtain approval, and record the result. Start with one agent;
add more when they measurably improve the output.

## How progress will be evaluated

- Accepted deliverables per attempted task.
- Human time spent supervising and correcting results.
- Cost and elapsed time per accepted deliverable, including retries.
- Incorrect or duplicate external actions and recovery after interruptions.
- Setup time and continued use on recurring work.

Comparisons should use the same tasks, permissions, and model budgets. Published results should
include scoring rules and failures. Crewrun does not claim benchmarked superiority over other tools.
