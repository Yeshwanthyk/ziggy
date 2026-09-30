# Memory

What the Profile learns persists and comes back in later turns, scoped to who is talking.

## Behaviors

- MEM-1: `memory_write` shared `add` lands in `MEMORY.md` and appears under `## Memory (shared)`
  in the next turn's system prompt.
- MEM-2: a write over the cap (2200 code points shared, 1375 person/group) returns
  `ERROR: memory full …` and leaves the existing file byte-identical.
- MEM-3: a group conversation's prompt includes `memory/groups/<id>.md` and never `memory/users/`.

## Entry points

The model calling `memory_write`; a group conversation via ui-sdk `openMain(profileId, {kind:"group", groupId})` or a channel.

## Drive

Script `tools({name:"memory_write", arguments:{scope, operations}})`, then `text(...)`, then `run`.

## Proof

File contents; the tool message in the following request; `rawRequests` for prompt contents.

## Gotchas

- CLI `run` is a local context: `person` writes `memory/users/owner.md`; `group` is refused.
