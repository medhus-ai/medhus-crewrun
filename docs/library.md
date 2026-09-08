# Use CrewRun from code

The reference host owns the single durable runtime. Initialize a workspace once, then start it:

```js
import { createHost } from "@medhus-ai/crewrun-reference-host";
import { createUp } from "medhus-crewrun/up";
import { createConsole } from "medhus-crewrun/console/server";

const targetRoot = "/absolute/path/to/workspace";
const host = createHost({ targetRoot });
const up = createUp({ targetRoot, host });
const consoleApp = createConsole({ targetRoot, up, operations: host.operations, knownEvents: host.knownEvents });
await up.start();
await consoleApp.listen();
// On shutdown:
await consoleApp.close();
await up.stop();
```

For injected secrets, fetch implementations, or installed plugins, use
`createIntegrationHost` from the same package. It still uses the shared worker,
store, approval outbox, and governed tools—not a second runtime.

Custom `--host` modules, standalone runtimes, arbitrary CLI engines, and worktree
factories are retired. See [v6 migration](v6-migration.md) and
[plugin authoring and provider setup](reference-host.md).
