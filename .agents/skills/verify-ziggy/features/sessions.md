# Sessions

Past conversations can be listed, read and continued without being rewritten.

## Behaviors

- SES-1: `sessions list` and `sessions show` leave the Profile tree unchanged.
- SES-2: `run --session <id>` appends to that file: roles become `user, assistant, user, assistant`.

## Entry points

`ziggy sessions list|show <profile> …`, `ziggy run --session <header-id>`, `ziggy run -c`.

## Drive

`run` once, read the header id from the new `.jsonl`, then `run --session <id> "again"`.

## Proof

`treeHash` equal across list/show; one session file with four message roles after the opening `system` snapshot entry.

## Gotchas

- `--session` takes the header id only; `sessions show` also accepts a relative path.
- A plain `run` writes directly under `sessions/`; `run -c` uses `sessions/local/main/`.
