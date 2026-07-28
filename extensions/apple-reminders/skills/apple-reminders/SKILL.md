---
name: apple-reminders
description: "List, add, edit, complete, or delete Apple Reminders and reminder lists via remindctl."
---

# Apple Reminders CLI (remindctl)

Use `remindctl` to manage Apple Reminders directly from the terminal.

Use this skill for personal to-dos that should sync through Apple Reminders. Use a calendar
for appointments and the user's chosen project tracker for project work. If "remind me" could
mean either a device-synced reminder or a notification in the current application, ask which
destination they want before creating anything.

## Setup

- Install: `brew install steipete/tap/remindctl`
- macOS-only; grant Reminders permission when prompted
- Check status: `remindctl status`
- Request access: `remindctl authorize`

## Common Commands

### View Reminders

```bash
remindctl                    # Today's reminders
remindctl today              # Today
remindctl tomorrow           # Tomorrow
remindctl week               # This week
remindctl overdue            # Past due
remindctl all                # Everything
remindctl 2026-01-04         # Specific date
```

### Manage Lists

```bash
remindctl list               # List all lists
remindctl list Work          # Show specific list
remindctl list Projects --create    # Create list
remindctl list Work --delete        # Delete list
```

### Create Reminders

```bash
remindctl add "Buy milk"
remindctl add --title "Call mom" --list Personal --due tomorrow
remindctl add --title "Meeting prep" --due "2026-02-15 09:00"
```

### Complete/Delete

```bash
remindctl complete 1 2 3     # Complete by ID
remindctl delete 4A83 --force  # Delete by ID
```

### Output Formats

```bash
remindctl today --json       # JSON for scripting
remindctl today --plain      # TSV format
remindctl today --quiet      # Counts only
```

## Date Formats

Accepted by `--due` and date filters:

- `today`, `tomorrow`, `yesterday`
- `YYYY-MM-DD`
- `YYYY-MM-DD HH:mm`
- ISO 8601 (`2026-01-04T12:34:56Z`)

## Clarify ambiguous intent

User: "Remind me to check on the deploy in 2 hours"

**Ask:** "Do you want this in Apple Reminders, which syncs to your devices, or as a
notification in this application?"

- Apple Reminders → use this skill
- Application notification → use the notification capability available in the current host
