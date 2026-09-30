#!/usr/bin/env node
import { appWorkspace, ensureRunner, readRunner, runnerRequest, serveApp } from "../src/app/runtime.js";
import { platformDoctor } from "../src/platform-doctor.js";

const [command = "ensure", workspace, ...extra] = process.argv.slice(2);
try {
  if (extra.length || !["ensure", "serve", "status", "stop", "login", "doctor"].includes(command)) throw new Error("Usage: crewrun-app [ensure|serve|status|stop|login|doctor] [workspace]");
  if (command === "doctor") console.log(JSON.stringify(platformDoctor()));
  else {
    const root = appWorkspace(workspace, process.env, { initialize: command === "ensure" || command === "serve" });
    if (command === "serve") {
      const app = await serveApp(root, { log: console.log });
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void app.stop(); });
    } else if (command === "ensure") {
      const descriptor = await ensureRunner(root);
      const { cookie } = await runnerRequest(descriptor, "session");
      // Private pipe to the native shell, never a URL query/fragment or persisted log.
      console.log(JSON.stringify({ protocol: 1, url: descriptor.url, identity: descriptor.identity, cookie }));
    } else {
      const descriptor = readRunner(root);
      if (!descriptor) throw new Error("No app runner is recorded for this workspace");
      const result = await runnerRequest(descriptor, command === "login" ? "login-code" : command);
      console.log(JSON.stringify({ url: descriptor.url, ...result }));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
