# Automations

An automation's result reaches its target conversation exactly once per run.

## Behaviors

- AUT-1: with no resident, `ziggy wake <profile> <id>` runs the model once and stores one
  `ziggy.automation-result` receipt in the target conversation per run.
- AUT-2: a live idle target gets an `automation-result` event and one receipt.
- AUT-3: with a resident up, `ziggy wake` is forwarded to it, and a target it has not opened
  gets the stored receipt.
- AUT-4: a live busy target is refused as `session-busy` (retriable) and not written mid-turn.
- AUT-5 (red): a resident starts even when an automation's cron parses but never fires
  (`0 0 31 2 *`). Today Effect's `Cron.next` throws and `serve` never comes up.

Unreachable end to end: "delivering one run twice gives one receipt". Nothing re-sends a run
(no retry path in `src/application/automations.ts`), so dedupe of the same `runId` is only
reachable below the CLI.

## Entry points

`ziggy wake`, ui-sdk `runAutomation(profileId, id)`, the scheduler (cron).

## Drive

Write `automations/<id>.md`:

```markdown
---
version: 1
cron: 0 9 * * *
timezone: UTC
broadcast: conversation:<session-header-id>
---

Write the digest.
```

## Proof

`wake delivered: conversation:<id>` on stderr; `custom_message` count in the target `.jsonl`;
ui-sdk `automation-result` event.

## Gotchas

- A cron that never fires is not a safe "never scheduled" value while AUT-5 is red: use
  `0 9 * * *` and keep runs away from 09:00 UTC.
- Do not quote `cron`; the frontmatter parser keeps the quotes and the cron is invalid.
- Receipts are `custom_message` entries with `customType: ziggy.automation-result`, not
  messages: `transcript.text` does not include them.
- `wake` forwards to the resident when one is running.
