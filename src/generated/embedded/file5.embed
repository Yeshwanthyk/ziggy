---
name: apple-reminders
description: "Read and safely manage Apple Reminders on macOS. Use for listing reminders or exact create, reschedule, move, complete, and explicitly confirmed delete requests."
---

# Apple Reminders

Use only the `apple_reminders_*` tools supplied with this skill. Never write or run ad hoc
AppleScript, shell, `osascript`, or `remindctl` commands. The tools keep AppleScript source fixed,
pass model data as argv, reject ambiguous targets, perform at most one write, and verify mutations
by captured reminder ID.

## Resolve the request

- Resolve relative dates immediately before the tool call into absolute local calendar components.
- Treat a date without a time as `kind: "all-day"`.
- Treat a date with an exact time as `kind: "timed"` and pass 24-hour `hour` and `minute` values.
- Ask one concise clarification for vague times such as “morning” or “later.” Never invent a time.
- Preserve the current list for reschedule and complete. Set `source_list` only when the user names
  it or an earlier tool result establishes it.
- Require a named or confirmed destination list for create and move.
- Match reminder and list names exactly and case-sensitively. If a tool reports ambiguity, make no
  mutation and ask the user to choose the exact source list.

## Read

- Call `apple_reminders_list_incomplete` to list incomplete reminders. Pass `list` only for one
  exact list.
- Call `apple_reminders_list_due` with an absolute local `date` to list incomplete timed and
  all-day reminders due that day. Pass `list` only for one exact list.
- Use tool output as authoritative. Never claim Reminders access succeeded after a tool failure.

## Mutate

- Call `apple_reminders_create` once with an exact `name`, destination `list`, and optional `due`.
  It refuses an incomplete exact-name duplicate in that list.
- Call `apple_reminders_reschedule` once with an exact `name`, optional `source_list`, and required
  absolute `due`. It preserves the reminder’s list.
- List moves are currently unsupported because the macOS Reminders AppleScript interface can report
  a changed container without persisting it. If the user requests one, explain this limit. Do not
  emulate a move with create-then-delete because that changes identity and can lose metadata.
- Call `apple_reminders_complete` once with an exact `name` and optional `source_list`. An already
  completed exact match is reported without another write.
- Call `apple_reminders_delete` only after the user explicitly confirms deletion of that exact
  reminder from that exact source list. Then pass `confirmed: true`. Never infer confirmation from
  a general cleanup request or from an earlier turn.

Do not retry a failed mutation. A timeout, cancellation, Apple Event error, or failed read-back can
mean the write outcome is uncertain. Report the failure and inspect Reminders with a read tool
before proposing another mutation.

For a request affecting multiple reminders, resolve the complete exact set first, call one mutation
at a time, and report each verified result separately. Never imply cross-reminder atomicity.

## Access failures

If macOS denies access, ask the user to grant the Ziggy host process access to Reminders in
**System Settings → Privacy & Security → Automation**, then retry only the read that proved access
was denied. Do not retry a mutation whose outcome is uncertain.
