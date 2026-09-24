# Operate Jevpact

Run these commands from the public repository clone. The service command is macOS only; the `status`, `attach`, and `history` commands work directly with the local controller.

```sh
node plugins/jevpact/bin/jevpact.js service status
node plugins/jevpact/bin/jevpact.js status
node plugins/jevpact/bin/jevpact.js history NATIVE_TASK_ID --since 2026-09-24
```

`service status --json` reports whether both LaunchAgents are loaded, the configured and running versions, whether expected tasks are watched, and the last health state. `status --json` reports each attached task's observation mode, token usage, recent decisions, and any attachment failure. It can show a transient `restoring` count immediately after startup. Wait for restoration to finish before judging a missing watcher.

The controller LaunchAgent uses `RunAtLoad` and `KeepAlive`. The health LaunchAgent runs at load and every 60 seconds. Its probe checks the controller RPC, its version, and any expected task IDs. It sends one local macOS failure notification after two consecutive failed checks and one recovery notification after a healthy check. The state is in `~/Library/Application Support/Jevpact/health-state.json`; the private error logs in that directory are `controller.stderr.log` and `health.stderr.log`. macOS notification settings and Focus control whether a banner or sound is visible.

If the controller is running but an expected task is absent, check the task ID, whether its Codex session ended, and `status --json` for `lastAttachmentFailure`. If the task is still active, reattach it with `attach NATIVE_TASK_ID`. If the expected task has ended intentionally, run `service install --clear-expected` or set the remaining expected IDs. Hooks for a new Codex task must be trusted in `/hooks` before they can attach it.

Use `service update` after installing a new plugin version. Running `jevpact stop` against a managed controller would only make launchd restart it, so use `service uninstall` to stop managed supervision. A manually started controller can still be stopped with `jevpact stop`.

Diagnostic history is a local 30-day, 5 GB rolling store. It contains exact redacted Jev request and response records, policy decisions, and native completion observations. Use `history --stats` to inspect retention and dropped records. A transient diagnostic database error appears in `status` but does not by itself mean the controller stopped. [Privacy and data handling](privacy.md) explains what those records can contain.

The timing policy remains experimental. A hook installation, a model answer, or a successful compaction request is not proof that native compaction completed or that the work resumed. The controller records each of those stages separately. A task with an active native Codex goal is not eligible for automatic pause or compaction.
