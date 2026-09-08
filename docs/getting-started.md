# Getting started

[Documentation](README.md) / Getting started

You need Node.js 20 or newer and a supported vendor sign-in or API runner.
If SQLite needs to compile during installation, see [native build requirements](security.md#installation).

## Install and start

To run the code in this checkout:

```bash
npm install
node bin/crewrun.js init ../my-workspace
node bin/crewrun.js up ../my-workspace --console
```

To use a published release:

```bash
npm install -g medhus-crewrun
crewrun init ./my-project
crewrun up ./my-project --console
```

Initialize the workspace before startup. Open **http://127.0.0.1:4400**. The command must remain running
for scheduled work and queued deliveries to execute. Changes on GitHub main reach npm after a release.

## Complete your first task

1. Open **Settings → Providers** and check that a runner is available. See [provider setup](providers.md).
2. Open **Agents → Add agent**. Describe its job and choose its runner.
3. Open **Tasks → Create a task**. Describe the result you need and how you will judge it.
4. Review saved results on the task page. Outgoing Slack or Gmail actions appear in **Reviews**.
5. Select **Accept deliverable** when the result meets your requirements. **Usage** shows recorded
   spend and cost per accepted deliverable.

An agent's permissions determine which tools it can use. Set up [integrations](integrations.md)
before asking it to send messages, or start with a task that produces a written result.

## Useful commands

```bash
crewrun up ./my-project --console          # tasks, deliveries, and scheduled work
crewrun console ./my-project               # manual tasks and deliveries; no scheduled triggers
crewrun agents check ./my-project          # validate check-in and hook settings
crewrun proposals list ./my-project        # review proposed learning
crewrun skills index ./my-project --write  # rebuild the Skills index
```

Use `--console-port 4500` with `up`, or `--port 4500` with `console`, to change the port.
The bundled console stays loopback-only. Use an authenticated private tunnel or reverse proxy for remote access; publish only callback ingress publicly.
When running from a checkout, replace `crewrun` with `node bin/crewrun.js`.

Read [Tasks and recovery](runtime-recovery.md) before relying on unattended work.
