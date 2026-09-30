# Run

`ziggy run <profile> "<prompt>"` answers once, from the Profile's SOUL, with its default model.

## Behaviors

- RUN-1: stdout is the assistant text followed by a newline; exit 0.
- RUN-2: the model request carries the Profile's model and its SOUL in the system prompt.
- RUN-3: `--json` streams Pi session events; the first line is the session header.
- RUN-4: a provider failure exits 1 with `provider request failed` on stderr.

## Entry points

`ziggy run <profile> "<prompt>"`, `ziggy run <profile> --json "<prompt>"`.

## Drive

With the sandbox up: `HOME=$SCRATCH_HOME bun src/main.ts run "$PROFILE" hi` prints `ok`.

## Proof

stdout/exit code; the last line of `$REQUESTS` has `"model":"harness-model"` and the SOUL text;
one new `.jsonl` under `$PROFILE/sessions/`.

## Gotchas

- Script a failure with `fail(400, …)`. Pi retries a 5xx (four requests, ~14 s) and then
  succeeds on the next scripted reply.
