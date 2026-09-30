# Launch Desk

Launch Desk is the smallest complete CrewRun example: a coordinator, a web-enabled researcher, and a writer. It demonstrates scoped files, a verified handoff, durable tasks, an owner review surface, and a disabled routine—without requiring an integration or giving an agent publishing access.

Create a fresh copy rather than copying configuration by hand:

```bash
crewrun init ./launch-desk --preset launch-desk --name "My launch desk" --timezone America/Phoenix
crewrun up ./launch-desk --console
```

In the coordinator chat, paste:

> Turn our brief into a launch plan. Delegate market evidence to the researcher, then have the writer prepare a one-page launch brief for my review.

The researcher can search and write only its own internal drafts. The writer can use those notes but cannot search or publish. The coordinator can create and delegate linked tasks, but none of the three can act outside the workspace or send to a provider. The weekly check starts disabled.

This is intentionally a pattern, not a fake business. Replace the two Markdown files in `knowledge/` with your own brief and audience, then change roles through the console when the work needs a different shape.
