---
name: ziggy-operations
description: Operate Ziggy Profiles — automations, resident serve, Discord, and Slack setup. Read this when creating automations, installing serve, or connecting a channel.
---

# Ziggy operations

Use loaded help and this skill before guessing Ziggy behavior. Read a reference file when the task
matches it. Do not search a developer checkout for plans or `src/`.

## When to read what

- Automations, `/automations`, pause/resume, wake, and run history → [references/automations.md](references/automations.md)
- Resident `ziggy serve` install/start/status/logs → [references/serve.md](references/serve.md)
- Connect Discord → [references/discord.md](references/discord.md)
- Connect Slack → [references/slack.md](references/slack.md)

## Rules

- Profile Markdown is authority. Do not invent a second automation or session store.
- `extensions.json` selects bundled packages already inside Ziggy. Do not download extension code to
  run it.
- Channel tokens stay out of docs, commits, and chat.
- Cite the reference path you used.
