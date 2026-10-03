# Models

`ziggy models set <profile> <provider/model>` changes the model later turns use.

## Behaviors

- MOD-1: after `models set harness/harness-other`, the next `run` requests `harness-other`.

## Entry points

`ziggy models set`; the web UI and ACP model pickers ([Web sessions](web-sessions.md), [ACP](acp.md)).

## Drive

`models set "$PROFILE" harness/harness-other`, then `run`.

## Proof

`server.request(0).model` (or the last `$REQUESTS` line) is `harness-other`.

## Gotchas

- The sandbox Profile lists only `harness-model` and `harness-other`.
