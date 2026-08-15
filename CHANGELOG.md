# Changelog

All notable changes to Ziggy are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`package.json` is the version source of truth. `ziggy version` prints it.

## [Unreleased]

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

[Unreleased]: https://github.com/Yeshwanthyk/ziggy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Yeshwanthyk/ziggy/releases/tag/v0.1.0
