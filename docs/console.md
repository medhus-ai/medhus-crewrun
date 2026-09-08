# Console navigation

Each page owns a distinct part of the workflow:

| Page | Purpose |
| --- | --- |
| Dashboard | Counts for running work, pending reviews, tasks needing attention, spend, and workspace health. |
| Tasks | Executions and results, defaulting to Needs attention, followed by Active, Completed, and All. Each execution identifies its source. |
| Reviews | Actions to approve, results to accept, proposed memory and skills, and retained decision history. |
| Scheduled | Calendar opens first and shows the next three occurrences in local time; choose 3, 5, 10, or 25 and page forward. List shows definitions with an enabled toggle, Edit, and Run now. |
| Agents | Role instructions, model, reviewed authority, and memory pointers. |
| Skills | Installed procedures and new skill proposals. |
| Integrations | Service connections and permissions; open a service for its Connection and Event rules tabs. Calendar mirroring, when supported by the host, belongs here. |
| Activity | Read-only Agent actions and Integration events; search the retained safe metadata. |
| Chats | Resumed agent conversations, also accessible from recent chats in the sidebar. |
| Usage | Recorded costs, estimates, and accepted outcomes. |
| Settings | Providers, credential availability, runtimes, and host configuration status. |

A scheduled task is a definition; its executions appear in Tasks. A verified integration
event becomes work only when an enabled, authorized event rule routes it. Activity links
routed events to the resulting tasks when those records are available.

Work lists, reviews, activity, and directories show ten items per page. Previous and Next
retain the current filters and search. Calendar pagination keeps a fixed starting time so
moving to the next page does not skip or repeat occurrences as the clock advances.

Task details link to the same Reviews item used by the decision queue. Approving an external
action permits delivery; accepting a result confirms a completed deliverable. These remain
separate decisions, and the runtime rechecks authority and task state as before.

Existing `/calendar`, `/approvals`, `/proposals`, `/events`, `/audit`, `/connectors`, and
`/providers` bookmarks redirect to the corresponding page and tab. Existing POST endpoints
remain supported. The layout reuses the existing stores; it introduces no second inbox or
workflow engine.
