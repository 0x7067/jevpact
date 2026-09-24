# Privacy and data handling

Jevpact runs locally except for its requests to the hosted TypeSafe Jev API. It is not affiliated with OpenAI or TypeSafe AI.

- Trusted hooks send task, turn, event, and transcript identities to the local controller. They do not forward tool inputs or outputs as hook payloads.
- The controller reads the local Codex rollout to understand lifecycle, usage, and recent visible messages. A bounded source-linked packet sent to Jev can contain user directions, assistant text, and code quoted in those messages. It does not deliberately attach full source files, the full rollout, hidden reasoning, or raw tool bodies. It does not perform general personal-data redaction; do not enable Jevpact for material you cannot send to TypeSafe.
- Jevpact stores local diagnostic history, including exact redacted Jev request bodies and responses. The default retention is 30 days with a shared 5 GB ceiling. The key itself is removed from those records. `history --stats` exposes retention and dropped-record counts.
- The managed macOS service copies the Jev key from the current environment into `~/Library/Application Support/Jevpact/credential` as plaintext in a user-only file (`0600`) inside a private directory (`0700`). It is not stored in macOS Keychain. `service uninstall` removes this file. A user or administrator who can read your local files can read the key.
- The local controller uses a user-only Unix socket. The health probe sends no task content over the network. Its macOS notifications may show a task ID and failure reason on your screen or lock screen, depending on notification settings.

Jevpact does not send separate analytics or telemetry. Codex and TypeSafe have their own data handling and account terms. Review the [TypeSafe API documentation](https://api.typesafe.ai/docs) and your Codex settings before enabling the plugin.
