# Changelog

All notable changes to Ziggy are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`package.json` is the version source of truth. `ziggy version` prints it.

## [Unreleased]


## [0.2.3] - 2026-08-18

### Added

- ACP `session/new` now announces Buzz's unstable SessionModelState: `availableModels` and `currentModelId` sourced from the Profile's auth-configured models (the auth.json ∩ models-store intersection)
- ACP `session/set_model` request handler validates `provider/model` against the Profile's authed models and records the per-session selection
## [0.2.2] - 2026-08-16

### Added

- Focused local rule parity tests for lexical scope, Reflect ownership, strict runtime `typeof`, assertions, unknown causes, unsafe dictionaries, and module mocking

### Changed

- Root `check` now runs the gateway-client's scoped lint, typecheck, and tests; the client's scoped oxlint configuration references the shared Ziggy plugin without duplicating a plugin or dependency
- Restored upstream lexical mapped/conditional-infer type-parameter fidelity for the object-parameter and unknown-return rules

## [0.2.1] - 2026-08-16

### Added

- Transactional Profile extension identity and lifecycle management, with first-class in-process `profile_extensions` operations across TUI, print, gateway, and automation faces
- Safer third-party adoption guardrails: inspect source in an OS temporary directory, never run install or lifecycle scripts, copy only the package source into the Profile shelf, then explicitly admit it through `profile_extensions`
- Managed-service path hardening: launchd and systemd service definitions now publish deterministic `HOME`, `ZIGGY_HOME`, `PATH`, and an absolute executable; the checksum-verified, symlink-safe `~/.local/bin/ziggy` installer shipped in 0.2.0 is retained unchanged

### Fixed

- Extension mutations now preserve prior selection and owned automation state on failure, validate through the production-shaped Pi loader, and report bounded lifecycle-stage failures
- Standalone resource smoke and upstream package-versus-local shelf identity handling are now more reliable

## [0.2.0] - 2026-08-15

### Added

- Machine-readable JSON for Profile, extension, specialist, automation, memory, and session inspection, plus Pi-owned NDJSON output for `ziggy run --json`
- Exact session resume with `ziggy run --session <id>`
- Recoverable Profile memory scaffolding, inventory commands, private pre-write backups, and bounded backup retention
- Serve-owned, authenticated loopback WebSocket gateway for UI sessions and watch-only channel sessions
- Dependency-free `@ziggy/gateway-client` with typed requests, event streams, reconnects, restored watches, and a minimal browser example
- ACP v1 face at `ziggy acp <profile> [--shared]` for Zed, Buzz, and other ACP clients
- MIT license for Ziggy-owned code

### Changed

- `ziggy serve` now owns live chat registration and UI session lifecycles alongside channel and automation work
- ACP sessions use isolated `sessions/acp/*` transcripts; shared clients use group-scoped memory instead of owner memory

## [0.1.0] - 2026-08-15

First tracked release. Ziggy is a folder that is an assistant: one Bun/TypeScript runtime wrapping `@earendil-works/pi-coding-agent@0.84.1`. Pi owns the agent loop, providers, sessions, and TUI; Ziggy owns Profile policy and composition.

### Added

- Profile folders identified by `SOUL.md`, with `ziggy init`, `profiles`, TUI, and `run`
- Capped Profile memory (`MEMORY.md`, per-user and per-group files) and `memory_write`
- Specialists as `agents/<id>.md`, with `agent_run` / `agent_discuss`, labeled child voices on Slack/Discord/Telegram, and local rails under `sessions/local/agents/<id>/`
- Shared in-process `ChatHandle` (`prompt`, `abort`, `steer`, `followUp`, `subscribe`, `isIdle`)
- Telegram, Discord, and Slack gateways, plus `ziggy serve` launchd/systemd supervision
- File-backed automations, optional provider/model/thinking overrides, scheduler, and `wake`
- Bundled extension catalog copied onto `<profile>/extensions/`, with required `pi-packages`, `extension-authoring`, and `ziggy-operations`
- Standalone compiled binary, `ziggy version`, `ziggy update`, `doctor`, `auth`, `models`, and transcript-free `sessions` list/show
- Curl install for macOS Apple Silicon: `curl -fsSL https://github.com/Yeshwanthyk/ziggy/releases/latest/download/install.sh | sh`

[Unreleased]: https://github.com/Yeshwanthyk/ziggy/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Yeshwanthyk/ziggy/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Yeshwanthyk/ziggy/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Yeshwanthyk/ziggy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Yeshwanthyk/ziggy/releases/tag/v0.1.0
