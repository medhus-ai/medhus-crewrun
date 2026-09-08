# Scheduling and event-driven work

[Documentation](README.md) / Scheduling

Run `crewrun up ./my-project --console` to process tasks, deliveries, schedules, and check-ins.
The command must stay running. `crewrun console` processes manual tasks and deliveries without
starting scheduled triggers.

## Scheduled tasks

Create recurring work under **Scheduled**, or add entries to an agent's `scheduled` array:

```json
{
  "scheduled": [
    {
      "id": "weekday-brief",
      "cron": "30 8 * * 1-5",
      "prompt": "Prepare today's project brief with blockers and next actions.",
      "enabled": true
    }
  ]
}
```

Cron uses five numeric fields in the workspace manifest's timezone: minute, hour, day of month, month,
and day of week. Wildcards, lists, ranges, and steps are supported. Missed windows coalesce into
one task. Open its result from **Tasks** or the status link in **Scheduled**.

Durable schedules persist their trigger cursor and queued task together. Processes sharing
the same local database share claims. Interrupted or paused work for a trigger needs attention
before that trigger queues more work. See [recovery rules](runtime-recovery.md).

## Automatic check-ins

A heartbeat runs an agent periodically. Configure it in the agent's activity settings:

```json
{
  "heartbeat": {
    "interval": "30m",
    "prompt": "Check current commitments. Report only what needs attention.",
    "budget_usd_per_day": 2
  }
}
```

`"heartbeat": "30m"` is shorthand; `"off"` disables it. Intervals support `s`, `m`, `h`, `d`,
`w`, `mo`, and `y`. The daily check uses recorded or estimated spend; it does not reserve budget
or impose a hard provider spending limit.

## Hooks and handoffs

An agent's `hooks` list permits named events; it does not enable a route by itself.
Enable provider rules in **Integrations**, or lifecycle rules in the reviewed
workspace manifest. Verified events and transactional lifecycle rows carry stable
IDs and use the durable queue.

Use `task.delegate` for linked child work. Both agents' handoff and data
permissions are checked. Questions and outcomes remain on the original task chain.
There is no `createUp().emit`, file-based scheduler, or in-memory heartbeat worker.
See [workspace event and task contracts](workspaces.md).
