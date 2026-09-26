# One app: desktop and headless

Linux, Windows and macOS (Intel and Apple Silicon) are build/test targets. The app
packages the current npm implementation, including its existing vendor engines,
rather than rewriting the runtime or console. Native target verification is required
before calling a platform release-ready.

## Run

Keep `CrewRun` (`CrewRun.exe` on Windows) beside `payload/` in a portable archive,
or use the native installer. No npm or system Node is required. Desktop uses the
OS webview; the display-free build of the same launcher has no webview dependency.

```text
CrewRun                                      # desktop, default personal workspace
CrewRun --workspace /path/to/workspace        # desktop, existing workspace
CrewRun --headless --workspace /path/to/workspace
CrewRun --status --workspace /path/to/workspace
CrewRun --login --workspace /path/to/workspace
CrewRun --stop --workspace /path/to/workspace
CrewRun --doctor
```

Only the implicit personal workspace is initialized automatically. Explicit paths
must already be CrewRun workspaces. Existing `CREW_HOME` state is reused; no old
queues are imported. The headless-only binary requires an explicit mode.

Desktop starts or attaches to one detached runner. Closing the window leaves work
running; `--stop` stops it. `--headless` runs in the foreground without a display,
ready for your OS service manager. No autostart/service is installed silently.

## Private attachment

The console binds only to `127.0.0.1` on an assigned port. `--status` gives its URL;
`--login` issues a single-use five-minute browser code. The native window receives
an HttpOnly session through a private pipe/native cookie API, never a URL credential
or JavaScript bridge. Sessions expire after twelve hours and on runner restart.
Provider credentials remain in the existing host vault.

A separate SQLite OS lock prevents competing runners; CLI `up`/`console` honor it
too. A failed readiness check cannot steal ownership. Private descriptors use owner
permissions and a Windows ACL. Keep `CREW_HOME` off shared/untrusted filesystems;
these controls do not defend against owner-level malware.

For headless browser access, use authenticated SSH **over your private tailnet**.
Run `--status` and `--login` on the host for the same workspace. Forward the assigned
port to the **same** client port to preserve Host/Origin checks:

```text
ssh -N -L 127.0.0.1:PORT:127.0.0.1:PORT user@TAILNET-HOST
```

Open `http://127.0.0.1:PORT/` locally and enter the code. Restrict SSH peers with
tailnet ACLs; VPN membership does not replace app sign-in. This is operator-managed
private forwarding, not a native remote selector or public proxy. Disconnecting
does not stop scheduled work. No public/wildcard console option exists in the app.

## Build, step by step

1. On the target OS/architecture use Node **24.14.0**, `npm ci`, and `npm test`.
2. `npm run app:stage` creates a new `apps/desktop/payload` with locked dependencies
   and the official Node binary/license. Existing output is never overwritten.
3. `npm run app:smoke` checks SQLite, workspace creation, concurrent attachments,
   authentication and shutdown without system Node/npm on PATH.
4. In `apps/desktop`, run `cargo test --locked --no-default-features` then
   `cargo build --locked --release --no-default-features`. From the repo root run
   `node scripts/archive-app.mjs headless` to test the native binary and create a
   portable archive plus SHA-256 in `dist/releases/`.
5. Install target [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
   In `apps/desktop`, run `cargo test --locked`, then
   `npx --yes @tauri-apps/cli@2.11.5 build --bundles deb` (Linux), `dmg` (macOS),
   or `nsis` (Windows). From the repo root, `node scripts/archive-app.mjs desktop`
   also creates a portable app.
6. Verify window rendering, external OAuth navigation, sleep/reconnect, shutdown and
   total process-tree RAM/CPU on every target before release.

Use a clean checkout and several GB of free disk for staging and bundler copies.
Weights and the private Docling venv are not copied from the developer machine.
Native inference dependencies and SDKs make this baseline larger than the future
local/OpenRouter-only profile. Dropping SDKs alone would break current compatible
routes; that reduced profile needs its own verified engine/dependency plan.

## CI/CD and limits

`ci.yml` tests Linux, Windows, Intel macOS and Apple Silicon macOS. `apps.yml` builds
desktop/headless variants, smoke-tests the packaged runtime/native headless mode,
checks authenticated dashboard rendering in each native webview, and retains unsigned
tester archives/installers for seven days. GitHub execution
is pending until pushed. Cargo and npm lockfiles are committed inputs.

No npm publishing, public release, cloud deployment or live provider tests run in
these workflows. Signing/notarization, automatic updates and service/autostart
installation remain separate release work. Do not disable OS security to treat
unsigned artifacts as signed releases. GUI behavior/performance remain release gates.

Packaging does not port isolation: knowledge read/search/parsing and Codex still
require their verified Linux boundaries. Unsupported Windows/macOS features remain
disabled; shared UI is not proof of full execution parity.

`src/app/` owns attachment/lifecycle; `bin/crewrun-app.js` is the shared entrypoint;
`apps/desktop/` owns the narrow native wrapper; `scripts/` owns staging/smoke/archive
tooling. Work, tools, approvals and providers remain in their existing modules.

### Local verification

The Linux staged runtime and display-free native launcher have passed startup,
authenticated browser access, shared-runner attachment and graceful shutdown checks.
Both Rust variants compile. After installing the shared system WebKit 4.1 runtime,
the actual Linux webview rendered the authenticated dashboard and closing its window
preserved the background runner. A real Chromium login-form regression check also
passes: same-origin referrer policy preserves form POST provenance without relaxing
the console's origin checks. Windows and macOS verification still awaits the
corresponding GitHub jobs. These are implementation artifacts, not signed or fully
verified releases.
