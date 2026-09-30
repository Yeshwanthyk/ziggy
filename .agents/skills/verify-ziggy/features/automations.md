# Automations

An automation's result reaches its target conversation exactly once per run.

## Behaviors

- AUT-1: with no resident, `ziggy wake <profile> <id>` runs the model once and stores one
  `ziggy.automation-result` receipt in the target conversation per run.
- AUT-2: a live idle target gets an `automation-result` event and one receipt.
- AUT-3: with a resident up, `ziggy wake` is forwarded to it, and a target it has not opened
  gets the stored receipt.
- AUT-4: a live busy target is refused as `session-busy` (retriable) and not written mid-turn.
- AUT-5: a resident starts even when an automation's cron parses but never fires
  (`0 0 31 2 *`). Parsing rejects it as "cron never fires", so the scheduler records it invalid.
- AUT-6: a web conversation the UI resumed and then switched away from gets the stored receipt.
  A switch that lands between the registry match and the live append (resume is not under the
  registry permit) also falls back to the stored append; that race is proven below the CLI in
  `test/adapters/pi/automation-result.test.ts`.
- AUT-7: `wake` delivers to a Slack thread (`chat.postMessage` with `thread_ts`), a Discord thread
  (`discord:channel:<thread id>`, split at 2,000 characters) and a Telegram chat (`sendMessage`),
  in `broadcast` order, against the fake chat server (`test/harness/chat.ts`).

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

For channel targets, write `slack.json`, `discord.json` and `telegram.json` with any tokens, start
`startChatServer()` and run `ziggyWith(profile, chat.env, "wake", …)`; `chat.env` points
`ZIGGY_SLACK_API_URL`, `ZIGGY_DISCORD_API_URL` and `ZIGGY_TELEGRAM_API_URL` at it.

## Proof

`wake delivered: conversation:<id>` on stderr; `custom_message` count in the target `.jsonl`;
ui-sdk `automation-result` event; `chat.posts` paths and bodies for channel targets.

## Gotchas

- A cron that never fires makes the definition invalid, so it is not a "never scheduled" value:
  use `0 9 * * *` and keep runs away from 09:00 UTC.
- Do not quote `cron`; the frontmatter parser keeps the quotes and the cron is invalid.
- Receipts are `custom_message` entries with `customType: ziggy.automation-result`, not
  messages: `transcript.text` does not include them.
- `wake` forwards to the resident when one is running.
- The UI resumes only web transcripts (`sessions/local/main/`); move a `run` transcript there
  before `resumeSession`.
