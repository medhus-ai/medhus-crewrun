---
purpose: the engineering doctrine every role applies when proposing, writing, or reviewing a change
audience: every role (apply); code-reviewer (enforce); planner (apply to plans); crew-manager (gate on)
edit: users tune the ladder, the correctness floor, and the marker; keep it short — it is read on every task
---

# Lean & Readable Engineering

The best change is the smallest one that fully satisfies the goal, preserves
safety, and reads clearly to the next engineer. Less code means fewer bugs,
lower cost, faster review, and easier rollback — treat that as the default, not
an afterthought. This doctrine governs *what* to build. The crew process around
it — discovery, the Karpathy checks, verification — lives in `conventions.md`.

## The ladder — climb only as far as the goal forces you

Before writing code, take the lowest rung that completes the task:

1. **Do nothing buildable.** Can this be solved by deleting code, changing
   config, writing a doc, or recognizing it is already handled? Prefer that.
2. **Use the platform.** Reach for what the language, runtime, browser,
   database, OS, or framework already provides before writing custom code.
3. **Use the standard library** before adding a dependency.
4. **Reuse what the repo already has.** Find the existing helper, component,
   utility, pattern, or dependency that covers this (use the discovery protocol
   in `conventions.md`) and build on it instead of adding a parallel one.
5. **Write the smallest custom change** that fully meets the task's acceptance
   criteria — with no scaffolding for needs that have not arrived.

## Deletion is a valid implementation

Removing dead code, unused config, stale paths, redundant wrappers, and
speculative scaffolding is real progress, not a chore. A change that deletes
more than it adds and still meets the goal is a good change.

## The correctness floor — lean never cuts these

Minimalism stops here. Never simplify away:

- trust-boundary validation (untrusted input, authorization checks)
- security: secrets handling, injection-safe queries, safe shell/exec
- data-loss protection and migrations
- accessibility on user-facing surfaces
- required error handling, and tests for any meaningful logic

If the smallest change would weaken any of these, it is not the smallest
*correct* change. Domain specialists may need real complexity to satisfy this
floor — that is not overbuild.

## No speculative structure, no clever code, no casual dependencies

- **No speculative architecture.** No factories, interfaces, options, flags,
  generic layers, or plugin points until the current task actually needs them.
  "What if we later need X" waits until X arrives.
- **Boring beats clever.** Obvious code the next maintainer reads in one pass
  beats compression that hides behavior.
- **No casual dependencies.** A new dependency must beat the platform, the
  standard library, and existing project code; if it saves only a few lines,
  reject it. New dependencies need explicit user approval (`conventions.md`).

## Name intentional shortcuts

When the crew deliberately ships a simple version with a known ceiling, mark it
so it can be found and upgraded later — never leave it silent:

```
// lean: <what is simplified> — ceiling: <when it stops being enough> — upgrade: <the trigger to revisit>
```

When the shortcut is a planning choice rather than a local one, record it in the
plan's `decisions.md` as well.

## Challenge overbuild

If a task, a plan, or another role asks for more complexity than the goal needs,
say so: *"we can do that, but this simpler route covers the need"* — then take
the simpler route unless full complexity is explicitly required. Apply this to
your own first instinct too.
