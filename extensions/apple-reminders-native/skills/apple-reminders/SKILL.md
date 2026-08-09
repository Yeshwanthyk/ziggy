---
name: apple-reminders-native
description: "Read and manage Apple Reminders through macOS AppleScript and osascript."
---

# Apple Reminders via AppleScript

Use this skill for Apple Reminders on macOS. It avoids `remindctl` and talks directly to the
Reminders app with the built-in `/usr/bin/osascript` command.

## Access

The first command may trigger a macOS permission prompt. If access is denied, ask the user to
grant this Profile or Terminal access to Reminders in **System Settings → Privacy & Security →
Automation**.

## List incomplete reminders

```bash
/usr/bin/osascript <<'APPLESCRIPT'
tell application "Reminders"
  set rows to {}
  set matchingReminders to every reminder whose completed is false
  repeat with reminderItem in matchingReminders
    set listName to name of container of reminderItem
    set end of rows to listName & " — " & (name of reminderItem)
  end repeat
  if rows is {} then
    return "No incomplete reminders."
  end if
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed
  set resultText to rows as text
  set AppleScript's text item delimiters to oldDelimiters
  return resultText
end tell
APPLESCRIPT
```

## List reminders due today or tomorrow

Push the date and completion predicates into Reminders' application-wide collection. Do not walk
every reminder and read `completed` or `due date` one item at a time; those cross-process Apple
Events can turn a simple query into a multi-minute scan.

Set `dayOffset` to `0` for today or `1` for tomorrow:

```bash
/usr/bin/osascript <<'APPLESCRIPT'
set dayOffset to 1
set dayStart to (current date) + dayOffset * days
set hours of dayStart to 0
set minutes of dayStart to 0
set seconds of dayStart to 0
set dayEnd to dayStart + 1 * days

tell application "Reminders"
  set matchingReminders to every reminder whose completed is false and due date is greater than or equal to dayStart and due date is less than dayEnd
  set rows to {}
  repeat with reminderItem in matchingReminders
    set reminderDue to due date of reminderItem
    set listName to name of container of reminderItem
    set end of rows to listName & " — " & (name of reminderItem) & " (" & (time string of reminderDue) & ")"
  end repeat
  if rows is {} then
    return "No incomplete reminders due on that day."
  end if
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed
  set resultText to rows as text
  set AppleScript's text item delimiters to oldDelimiters
  return resultText
end tell
APPLESCRIPT
```

## List a specific list

Replace `Personal` with the requested list name:

```bash
/usr/bin/osascript -e 'tell application "Reminders" to get name of every reminder of list "Personal"'
```

## Create, complete, or delete

Use AppleScript with an exact list and reminder name. Confirm destructive actions before deleting.
For completion, set `completed` to `true`; for creation, `make new reminder at end of reminders of
list "Personal" with properties {name:"Buy milk"}`.

## Rules

- macOS only; use the built-in `/usr/bin/osascript`.
- Filter with `whose` before iterating. Never scan every reminder with per-item Apple Events when
  the query can be expressed through `completed`, `due date`, or another Reminders property.
- Never claim access succeeded if `osascript` returns an error.
- Ask which destination to use before creating a reminder if the user could mean Apple Reminders or
  a notification in the current application.
- Keep output concise and include the Reminders list name.
