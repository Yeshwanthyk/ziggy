# Single writer

A session open in the resident is never written by a second process.

## Behaviors

- SW-1: while the resident holds main, `run -c` and `run --session <main-id>` exit 1 with
  `this session is open in another process (pid N); use the UI, or start a new session`.
- SW-2: a plain `run` still works; it starts a new session.

## Entry points

Any CLI write to a session the resident holds.

## Drive

Start a resident, do one web turn, then run the CLI commands.

## Proof

Exact stderr including the resident's pid; no model call; the main transcript is unchanged.

## Gotchas

- The main file only exists after the first web turn; target it after `settled`.
