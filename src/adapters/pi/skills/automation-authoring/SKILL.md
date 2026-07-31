---
name: automation-authoring
description: Create, inspect, update, or remove Profile-owned Ziggy automations without searching for another cron system.
---

# Ziggy automations

When the user asks about an automation, scheduled prompt, recurring task, reminder, or cron:

1. Call `automation_list` immediately to inspect this Profile's definitions, scheduler health, next runs, and latest receipts.
2. Use `automation_create`, `automation_update`, or `automation_remove` for requested definition changes.
3. Use `automation_run` when the user asks to run one now.
4. Treat `automations/<id>.md` as the authoritative human-readable definition and `.runtime/automations/runs/` receipts as execution truth.
5. Creating, updating, or resuming an enabled scheduled definition starts its Profile scheduler automatically. If `automation_list` still reports it offline, say that the definition exists but scheduler startup needs attention in `/automations`.
6. Don't search for or invoke Claw, Merlin, system cron, or another automation store unless the user explicitly asks for that system.

Use a short kebab-case ID, a clear name, and a complete Markdown prompt. Schedules are `cron` with an IANA timezone, one-shot `at` with a canonical UTC instant, or fixed-second `every`. Preserve optional schedule, delivery, and gate fields when updating unless the user asks to change them.
