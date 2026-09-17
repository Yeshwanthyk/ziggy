---
name: ziggy-operations
description: Operate Ziggy Profiles — CLI help, models, auth, specialists, sessions, ACP, updates, automations, memory, resident serve, and channels. Read this before changing or inspecting Ziggy runtime operations.
---

# Ziggy operations

Use `ziggy_help` and this skill before guessing Ziggy behavior. Omit `topic` for the command index,
then request the matching topic for exact version-matched usage. Read a reference file when the task
matches it. Do not search a developer checkout for plans or `src/`.

## When to read what

- Automations, `/automations`, pause/resume, wake, and run history → [references/automations.md](references/automations.md)
- Profile memory, scopes, caps, backups, and inspection → [references/memory.md](references/memory.md)
- Resident `ziggy serve` install/start/status/logs → [references/serve.md](references/serve.md)
- Connect Telegram → [references/telegram.md](references/telegram.md)
- Connect Discord → [references/discord.md](references/discord.md)
- Connect Slack → [references/slack.md](references/slack.md)
- Initialize or list Profiles → `ziggy_help` topics `init` or `profiles`
- Select or inspect a Profile model → `ziggy_help` topic `models`
- Provider authentication → `ziggy_help` topic `auth`
- Create, validate, inspect, or run specialists → `ziggy_help` topic `agents`
- Inspect stored sessions → `ziggy_help` topic `sessions`
- Open an Agent Client Protocol session → `ziggy_help` topic `acp`
- Update the Ziggy executable → `ziggy_help` topic `update`
- Open the local TUI or a one-shot run → `ziggy_help` topics `tui` or `run`
- Profile diagnosis or package selection → `ziggy_help` topics `doctor` or `extensions`

## Rules

- Profile Markdown is authority. Do not invent a second automation or session store.
- Bundled and Profile-owned packages are admitted only through the in-process `profile_extensions`
  tool. Read `pi-packages` for selection and `extension-authoring` for the authoritative third-party
  adoption procedure.
- Specialists may use `pi_docs` or `ziggy_help` only when their Profile tool allowlist names them.
  They never receive `profile_extensions`; hand validation and admission back to the parent Profile
  agent.
- Channel tokens stay out of docs, commits, and chat.
- Cite the reference path you used.
