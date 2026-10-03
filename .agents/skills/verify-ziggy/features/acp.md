# ACP

An editor talks to the Profile over the Agent Client Protocol on stdio.

## Behaviors

- ACP-1: `initialize`, `session/new`, `session/prompt` returns `end_turn` with the Profile's model.
- ACP-2: `session/set_model` to `harness/harness-other` changes the next request's model.

## Entry points

`ziggy acp <profile> [--shared]` spawned by an editor.

## Drive

Spawn `ziggy acp`, connect `@agentclientprotocol/sdk` `client().connectWith(ndJsonStream(...))`.

## Proof

Response `stopReason`; `server.request(0).model`.

## Gotchas

- The SDK has no typed `set_model` method; send `"session/set_model"` by name.
- `session/new` needs an absolute `cwd`.
