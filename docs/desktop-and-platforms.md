# Desktop and multi-OS delivery

Windows, Linux and macOS are now product targets. See the [packaged app guide](packaged-app.md)
for the implemented launcher, build steps and current verification limits.
Keep one runtime and the existing console, agents, tasks, reviews and plugin SDK.

## Current state

| Surface | Status |
|---|---|
| Linux x64 source runtime | Existing tested path; individual dependencies still required |
| Windows x64 source runtime | Experimental; CI covers portable behavior, not Linux isolation |
| Linux ARM64 | Experimental; target-specific native dependency and boundary verification outstanding |
| Native Windows knowledge search/Office parsing | Disabled pending equivalent filesystem and worker isolation |
| macOS Intel and Apple Silicon | Build/test targets; native verification pending |
| Self-contained headless distribution | Implemented; native Linux smoke tests pass |
| Native desktop window/installer | Tauri implementation and unsigned installer workflow; target verification required |

Run `node bin/crewrun.js doctor` (or add `--json`) from a development checkout.
The report is read-only and distinguishes platform eligibility, installed
prerequisites and unavailable features. It does not run sandbox or model probes;
installed dependencies alone never prove a working security boundary.

The first portability slice added this report, explicit unsupported-OS knowledge
denials, a Windows/Node 24 CI lane, and lazy Codex dependency resolution so merely
loading the host does not require resolving that vendor SDK. This does **not** yet
remove vendor packages from the development dependency tree or create a local-model
distribution. Linux regression results do not count as native Windows verification.

## Product architecture

- Ship self-contained installers with a pinned Node runtime and target-built native
  dependencies. npm is a development/build tool, not the end-user installation path.
- Reuse the server-rendered console in a thin desktop shell; no React rewrite or
  duplicated desktop task database. Evaluate Tauri first, without assuming a RAM win.
- One runner owns a workspace runtime identity. Windows/tabs attach to it; closing
  a window is separate from pausing automation or explicitly stopping the runner.
- A headless installation needs neither GUI nor system Node/npm. Start-at-login or
  boot is an explicit owner choice. Never kill a separately managed or remote runner
  merely because a client disconnects.
- Future reduced-profile chat options are the local-model project and OpenRouter. Download
  model weights after installation with consent and verification. Keep current
  development engine support separate from the launch bundle's dependency selection.
- Keep the console loopback-only today. Future remote attachment must verify private
  VPN access **and** application authentication. Do not enable wildcard/public binding,
  public console tunnels or a public-mode override. Provider callback ingress remains
  distinct from management access.

## Release gates (implemented portions are tracked in the packaged app guide)

1. **Authenticated attachment and ownership:** narrow local handshake, owner sessions,
   protocol/version check, one runner per identity, bounded startup/reconnect, and
   two simultaneous clients tested. Do not equate today's Host/Origin and CSRF checks
   with complete remote-console authentication.
2. **Self-contained headless artifact:** stage pinned runtime and dependency closure,
   test SQLite and optional model/parser dependencies on each actual target, exercise
   paths containing spaces/Unicode and run without system Node/npm. The current baseline
   retains the existing engines; a reduced-provider profile is later work. Preserve notices/checksums.
3. **Thin window prototype:** attach to the same host and serve the existing UI. No
   renderer shell/filesystem primitives; bounded native commands only. External login
   opens in the system browser. Test WebKitGTK/WebView2 before selecting a shell.
4. **Windows execution safety:** equivalent race-resistant source reads, junction and
   symlink containment, isolated parsers/model workers, protected credential storage
   and process-tree cleanup. If a capability is unverified, keep it unavailable rather
   than substituting prompt instructions or unsandboxed execution.
5. **Install/update/service lifecycle:** signed or explicitly labeled tester artifacts,
   explicit autostart, graceful drain, crash recovery, atomic update/rollback, native
   file-lock behavior, and proof old/new workers cannot run the same queued work.
6. **Private remote attachment:** verified VPN/interface policy, app authentication,
   session revocation, disconnect/reconnect and spoofed-proxy rejection. No remote
   console release until these checks pass.

Measure total shell + webview + host CPU/RAM on idle, hidden, streaming and long-chat
workloads. Account for model workers separately. Retain current style, resizable
sidebar, pagination and chat identity. No existing workspace service is restarted
or exposed by the packaging work.

## Hermes desktop source review

Reviewed the official repository at commit
`accb82032cfe8f62d7e8675f0409f3cd1a840b8f` using a shallow, UI-focused clone. This was
a source/architecture review, not a rendered-UI audit or performance benchmark.

| Useful pattern | CrewRun application |
|---|---|
| Explicit backend ownership and singleton guards | Attach windows to existing work; never start another runner just to open a page |
| Separate backend truth from UI caches | Tasks, reviews and chats remain authoritative in the runtime; UI owns presentation only |
| Connection/profile-scoped state | No old workspace transcripts or responses leaking into a new selection |
| Bounded, jittered reconnect | Avoid hot retry loops; distinguish auth rejection from connection outage |
| Visibility-aware UI loops | Pause cosmetic polling/animation when hidden, not the scheduler |
| Narrow native boundary | No generic privileged bridge reachable from model output or rendered pages |
| Target-specific lifecycle tests | Verify real Windows shutdown/file locks, not only mocked OS labels |

Source references:

- [Runner sharing](https://github.com/NousResearch/hermes-agent/blob/accb82032cfe8f62d7e8675f0409f3cd1a840b8f/apps/desktop/electron/host-backend-singleton.ts)
- [Owned-child lifecycle](https://github.com/NousResearch/hermes-agent/blob/accb82032cfe8f62d7e8675f0409f3cd1a840b8f/apps/desktop/electron/local-backend-lifecycle.ts)
- [Connection scope](https://github.com/NousResearch/hermes-agent/blob/accb82032cfe8f62d7e8675f0409f3cd1a840b8f/apps/shared/src/backend-scope.ts)
- [Reconnect policy](https://github.com/NousResearch/hermes-agent/blob/accb82032cfe8f62d7e8675f0409f3cd1a840b8f/apps/shared/src/reconnect-backoff.ts)
- [UI pause policy](https://github.com/NousResearch/hermes-agent/blob/accb82032cfe8f62d7e8675f0409f3cd1a840b8f/apps/desktop/src/lib/renderer-loop-pause.ts)

Do not adopt Hermes' whole Electron/React surface, broad native filesystem/git
capabilities or public remote gateway options. Those are not CrewRun's product
boundaries. Tauri remains an evaluation candidate, not a settled efficiency claim.
No Hermes code/assets were copied into CrewRun. If we later copy substantial MIT
source, preserve its copyright/license notice and inspect dependency/asset licenses.
