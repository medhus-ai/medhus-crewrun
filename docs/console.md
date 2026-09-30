# Console navigation

Each page owns a distinct part of the workflow. The sidebar lists Inbox, Workspace, Scheduled,
Agents, Plugins & Skills, Activity, and Chats; Usage and Settings are in the workspace menu
at the bottom of the sidebar. The Inbox item shows how many items need the owner.

| Page | Purpose |
| --- | --- |
| Inbox | Everything that needs the owner, in four tabs. **Needs attention** (default) groups questions from agents, finished results ready to accept, problems to resolve (paused, blocked, failed, or a delivery to reconcile), and setup issues (configuration problems, integrations that need reconnecting). **Approvals** lists outgoing actions, proposed skills and memory, and workspace changes. **In progress** shows queued and running work, including work waiting on an approval. **Done** lists accepted, cancelled, and completed work plus the retained decision history. Open a task for its results, deliveries, timeline, Accept result, and Request changes. |
| Workspace | Folders and subfolders of the workspace as an expandable tree; select a Markdown or CSV file to preview it. The selected file's folders open automatically. |
| Scheduled | Calendar opens first and shows the next three occurrences in local time; choose 3, 5, 10, or 25 and page forward. List shows definitions with an enabled toggle, Edit, and Run now. |
| Agents | Role instructions, model, reviewed authority, and memory pointers. |
| Plugins & Skills | One sidebar item with two tabs. **Plugins**: integration plugins for service connections and permissions; open a service for its Connection and Event rules tabs. Calendar mirroring, when supported by the host, belongs here. **Skills**: installed procedures; skill proposals are approved under Inbox → Approvals. |
| Activity | Read-only Agent actions and Integration events; search the retained safe metadata. |
| Chats | Resumed agent conversations, also accessible from recent chats in the sidebar. |
| Usage | Recorded costs, estimates, and accepted outcomes. Spending appears only here. |
| Settings | Providers & credentials (encrypted key store: create, unlock, add or remove API keys), Local models (hardware check, recommended model, connect a llama.cpp or oMLX server), Knowledge (local search model, agent indexes, and web sources: public pages and sitemaps saved as Markdown in `knowledge/sources/` on a schedule), and host configuration status. |

A scheduled task is a definition; its executions appear in the Inbox. A verified integration
event becomes work only when an enabled, authorized event rule routes it. Activity links
routed events to the resulting tasks when those records are available.

Work lists, reviews, activity, and directories show ten items per page. Previous and Next
retain the current filters and search. Calendar pagination keeps a fixed starting time so
moving to the next page does not skip or repeat occurrences as the clock advances.

Task details link to the same Inbox → Approvals item used by the decision queue. Approving an external
action permits delivery; accepting a result confirms a completed deliverable. These remain
separate decisions, and the runtime rechecks authority and task state as before.

Existing `/dashboard`, `/tasks`, `/reviews`, `/calendar`, `/approvals`, `/proposals`, `/events`,
`/audit`, `/connectors`, and `/providers` bookmarks redirect to the corresponding page and tab
(for example `/tasks?run=<id>` to `/inbox?run=<id>` and `/reviews` to `/inbox?tab=approvals`). Existing POST endpoints
remain supported. The layout reuses the existing stores; it introduces no second inbox or
workflow engine.
