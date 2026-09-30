# Web sessions

The web UI (and any ui-sdk client) drives the resident's main conversation.

## Behaviors

- WEB-1: a client can close mid-turn; a new client that rewatches from its cursor
  (`watchSession(ref, {epoch, seq})`) before the turn ends gets the live tail to `settled`, and the transcript is one `user, assistant` pair.
- WEB-2: two clients opening main get the same ref, both see `settled`, and one file exists.

## Entry points

ui-sdk `connectZiggy` (the web UI's client), the web UI via `ziggy web pair`.

## Drive

`startResident(profile).connect()`; `openMain`, `watchSession`, `submitPrompt`. Hold a turn open
with `held(first, rest, gate())`.

## Proof

ui-sdk events (`assistant-text`, `settled`); one `.jsonl` under `sessions/local/main/`.

## Gotchas

- Watch before submitting, or early events are missed.
- `ziggy web configure --port 0` is rejected; leave `web.json` absent to get an ephemeral port.
