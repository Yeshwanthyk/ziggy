---
name: automation-authoring
description: Create, inspect, update, or remove Profile-owned Ziggy automations without searching for another cron system.
---

# Ziggy automations

When the user asks about an automation, scheduled prompt, recurring task, reminder, or cron:

1. Call `automation_list` immediately to inspect this Profile's definitions.
2. Use `automation_create`, `automation_update`, or `automation_remove` for requested definition changes.
3. Treat `automations/<id>.md` as the authoritative human-readable definition.
4. Say plainly that V1 stores and manages definitions but doesn't schedule them in the background yet. Never claim a definition will run on a schedule until scheduler support exists.
5. Don't search for or invoke Claw, Merlin, system cron, or another automation store unless the user explicitly asks for that system.

Use a short kebab-case ID, a clear name, and a complete Markdown prompt. Preserve optional delivery and gate fields when updating unless the user asks to change them.
