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

Cron uses five numeric fields in the process's local time: minute, hour, day of month, month,
and day of week. Wildcards, lists, ranges, and steps are supported. Missed windows coalesce into
one task. Open its result from **Tasks** or the status link in **Scheduled**.

Standalone schedules persist their trigger cursor and queued task together. Processes sharing
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

An agent's `hooks` list subscribes it to event names supplied by an application:

```json
{ "hooks": ["task.assigned"] }
```

Applications emit events through `createUp().emit(event, payload)`. Standalone mode enqueues
matching tasks with a debounced external ID; custom hosts can supply routing and enqueue behavior.
Hooks do not automatically subscribe to external webhooks.

For durable work between agents, use `createHandoffQueue({ getDb, governance })`. The host
supplies the authenticated sender, and the queue checks both agents' authority before enqueueing.
See [governed handoffs](host-api-v1.md#durable-governed-handoffs).

The exported file-based `createScheduler` and `createPulse` helpers are for one host operator
process. They do not provide the standalone store's cross-process claims.
