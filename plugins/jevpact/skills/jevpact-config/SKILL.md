---
name: jevpact-config
description: Explain, inspect, or change Jevpact runtime settings and reusable profiles from a Codex task. Use when someone asks to tune Jevpact for this task, a project, or all tasks, or asks what Jevpact can configure.
---

# Configure Jevpact

Jevpact keeps persistent settings in `~/.jevpact/config.json`. Use `jevpact` from `PATH` when installed there. Otherwise run the bundled `../../bin/jevpact.js` relative to this skill with Node.js. The examples below use `jevpact` as shorthand. The CLI validates values, creates the file on first read if needed, writes it atomically, and asks a running controller to reload after changes. Do not edit the JSON by hand for ordinary changes.

Start with `config list` for the live catalog and `config show --thread current` for this task's effective values. The pre-made `default` global profile supplies the ordinary baseline; inspect it with `config profile show default`. If the selected global profile is missing, Jevpact restores the default binding and profile when possible and otherwise uses source defaults. The CLI verifies `CODEX_THREAD_ID` against the native task index. `--project current` uses the recorded working directory and resolves a Git worktree to its main checkout. For another task, use its actual native task ID; do not infer it from a title or context-window ID.

## Crafting lifecycle messages

Native Codex compaction does not produce a stable, readable post-compaction message for Jevpact to edit or interpolate. [OpenAI's compaction guide](https://developers.openai.com/api/docs/guides/compaction) describes an opaque encrypted item that carries prior state; the compacted context may also retain earlier messages. In an observed Codex desktop rollout, `compacted.payload.message` was empty and `replacement_history` contained retained user messages plus an encrypted `compaction` item. Its exact retained content is not a documented text template.

Jevpact sends `resumeMessage` *after* native compaction as a separate user-role message: `Jevpact compaction complete: <resumeMessage body>`. It sends `pauseMessage` before compaction and `deferMessage` when no compaction occurs, both with the fixed `Jevpact context maintenance:` prefix. These bodies add instructions to the thread; they do not replace the native compacted state. A deferred thread still has its original history. When helping someone write a message, show the complete prefixed text and explain that prior user directions and the assistant's pause wrap-up may already be available. Repeating them can waste context; contradicting them can misdirect continuation. Preserve explicit user stops, unresolved results, and the difference between completing compaction and completing the task.

All three message bodies accept dynamic `{{...}}` tokens anywhere in the text. Run `config tokens` for the complete live catalog. Common choices are `{{user.latestPrompt}}`, `{{work.latestDirection}}`, `{{assistant.latestFinal}}`, `{{assistant.recentMessages:3}}`, `{{pause.wrapUp}}`, and `{{assistant.lastBeforeCompaction}}`. Recent-list counts are 1-10. Tokens expand once when Jevpact sends the message; copied text containing `{{...}}` is not expanded again. Write `\{{` for literal `{{`. Unknown tokens fail configuration validation, and a token unavailable at that lifecycle stage becomes `[unavailable: token.name]`.

`{{pause.wrapUp}}` is available on defer and resume after the assistant finishes the pause turn. `{{assistant.lastBeforeCompaction}}` is frozen immediately before native compaction and is available on resume. Context counters on resume refer to that pre-compaction checkpoint. `{{user.latestPrompt}}` selects direct user text; `{{work.latestDirection}}` also permits a delegated or scheduled direction. Tool tokens contain bounded excerpts of observed calls and results; “result not observed” is not proof that a tool is still running or that a result was understood. The opaque native compaction item cannot supply a readable `{{compaction.recordText}}`, so that token is rejected.

When a request does not specify scope, ask whether it should apply to this task or its project before writing. Use `--global` only when the user asks for all tasks. Show the current value and the proposed value before applying a consequential change. A direct request naming both setting and scope is enough to apply it.

For an initial walkthrough, explain these options first: `mode` (`automatic`, `observe`, `off`), `minInputTokens`, `nativeLimitTokens`, `reserveTokens`, the pause/resume/defer message bodies, and profiles. Mention `minGrowthTokens` and `minRequests` when the user wants compaction frequency. On request, use `config list` to explain the advanced timing, watcher, diagnostic, and timeout settings. `nativeLimitTokens` changes Jevpact's pressure ceiling within Codex's reported context window; it does not increase that window.

Useful commands:

```text
jevpact config list
jevpact config tokens
jevpact config show --thread current
jevpact config show --project current
jevpact config set minInputTokens 250000 --project current
jevpact config set pauseMessage "Finish the connected step and pause." --thread current
jevpact config set resumeMessage "Continue from this wrap-up: {{assistant.lastBeforeCompaction}}" --thread current
jevpact config reset minInputTokens --thread current
jevpact config clear --thread current
jevpact config reattach --thread current
jevpact config profile show default
jevpact config profile set default minInputTokens 250000
jevpact config profile unset default minInputTokens
jevpact config profile save deep-work --thread current
jevpact config profile apply deep-work --project current
jevpact config profile list
jevpact config profile show deep-work
```

Profiles are saved snapshots of effective settings. The default global profile is editable and cannot be deleted through the CLI. A profile saved from global can contain global-only history settings; a profile with those settings cannot be applied to a project or task. Applying a profile binds it to a scope; explicit settings at that scope take precedence. `profile set NAME KEY VALUE` edits a profile, `profile unset NAME KEY` restores the source default for that profile key, `profile clear --project PATH` removes a project binding, and `profile clear --global` selects the default global profile. Other unbound profiles can be deleted. Settings resolve from source defaults through global, the most specific matching project path, then task.

After a write, distinguish the saved file from the running controller result. The CLI reports whether reload succeeded, whether an action is finishing before the change takes effect, and whether a watcher change needs reattachment or a history storage change needs a controller restart. Use `config reattach --thread ID` only after a pending controller action finishes. Report those exact results. Jev questions, criteria, confidence thresholds, and request context are outside this configuration surface.
