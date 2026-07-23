# Ziggy

Ziggy is a local-first personal-agent runtime; start with the [north star](docs/NORTH-STAR.md), follow the staged [roadmap](docs/ROADMAP.md), and read the repository [agent guide](AGENTS.md) before contributing.

S0 Foundation, S1 Waist, S2 Daemon, and S3 Face are complete. S3 includes the shared Attach Client, CLI one-shots, Session listing, a protocol-only TUI, real API-key and browser-OAuth authentication, and a real Luna-high model/TUI journey. Hosted CI remains disabled while the repository is private; findings-bearing verification requires a current independent findings file for the selected stage. Current S4 work uses:

```sh
bun tooling/verification/runner.ts all --agent-findings /absolute/path/to/ziggy-s4-findings.json
```

S4 Molding remains pending. The settled plan maps the closed Merlin inventory to exactly 39
standalone S4 builtin Extensions—five Skill-only and 34 supervised-Command—five S6/S7
Gateways, and three drops. S4 adds bounded daemon-owned Extension authoring CRUD; `skill-creator`
guides that primitive, while `automation-creator` guides S5's Automation CRUD. Neither has direct
filesystem authority. Candidate waves add
their own bundled catalog entries, and only final closure asserts all 40 entries; only
`skill-creator` and `automation-creator` are enabled in a new Profile. Existing HyperFrames
Blueprint, baked-in skill-writing core Skill, curated scaffolds, reviews, and scenarios are legacy
that the first S4 implementation slice will remove. This planning-only correction does not change
that production or verification code, so executable S4 verification is intentionally transitional
until the slice lands.

Isolated S5 and Gateway implementation may proceed on branches against frozen contracts before
their predecessor stage closes. Integration, manifest status, and release gates remain ordered.
Telegram is the required S6 Gateway for v1; Slack and Discord are parallel S6 candidates that may
join v1 when independently green but do not delay the tag.

## Provider authentication

The Profile daemon owns Provider credentials and stores them only in `credentials/auth.json` with schema version 1 and mode 0600. Clients never read or write that file.

```sh
ziggy auth login anthropic --type api_key --profile /path/to/profile
ziggy auth login anthropic --type oauth --profile /path/to/profile
ziggy auth login openai-codex --type oauth --profile /path/to/profile
ziggy doctor --profile /path/to/profile
```

`ziggy auth login` auto-starts the daemon, carries prompts transiently over the Profile's mode-0600 attach socket, and returns metadata only. Deterministic tests use fake Auth/Provider boundaries; real API-key, Anthropic OAuth, Codex OAuth, and model-call checks are manual and must never publish credential values or raw Provider diagnostics as verification evidence.
