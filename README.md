# Ziggy

Ziggy is a local-first personal-agent runtime; start with the [north star](docs/NORTH-STAR.md), follow the staged [roadmap](docs/ROADMAP.md), and read the repository [agent guide](AGENTS.md) before contributing.

S0 Foundation, S1 Waist, S2 Daemon, and S3 Face are complete. S3 includes the shared Attach Client, CLI one-shots, Session listing, a protocol-only TUI, real API-key and browser-OAuth authentication, and a real Luna-high model/TUI journey. Hosted CI remains disabled while the repository is private; implemented-S3 verification requires a current independent findings file:

```sh
bun tooling/verification/runner.ts all --agent-findings /absolute/path/to/ziggy-s3-findings.json
```

## Provider authentication

The Profile daemon owns Provider credentials and stores them only in `credentials/auth.json` with schema version 1 and mode 0600. Clients never read or write that file.

```sh
ziggy auth login anthropic --type api_key --profile /path/to/profile
ziggy auth login anthropic --type oauth --profile /path/to/profile
ziggy auth login openai-codex --type oauth --profile /path/to/profile
ziggy doctor --profile /path/to/profile
```

`ziggy auth login` auto-starts the daemon, carries prompts transiently over the Profile's mode-0600 attach socket, and returns metadata only. Deterministic tests use fake Auth/Provider boundaries; real API-key, Anthropic OAuth, Codex OAuth, and model-call checks are manual and must never publish credential values or raw Provider diagnostics as verification evidence.
