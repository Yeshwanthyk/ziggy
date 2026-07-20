# S2 — Daemon

## Goal

Turn the headless S1 session engine into a resident, per-profile daemon reachable over a real attach-protocol socket, supporting multiple concurrent clients/sessions, disconnect-without-kill, and event replay on reconnect.

## Deliverables

- Daemon process (`packages/core/src/daemon/`): Effect layer composition that owns one profile directory for its entire lifetime. Listens on a Unix domain socket at `<profile>/.runtime/ziggy.sock`, created with `0600` permissions. The socket path _is_ the identity — no global daemon registry, no port allocation.
- NDJSON framing over the socket implementing the exact `packages/protocol` methods from S1: `initialize`, `session/start`, `session/resume`, `session/list`, `session/subscribe`, `session/unsubscribe`, `turn/start`, `turn/steer`, `turn/interrupt`, and `approval/resolve`.
- Multi-session concurrency: each active session runs as its own Effect fiber; the daemon can run several sessions' turns simultaneously without one blocking another.
- Subscription/fan-out model: a session can have N subscribed connections at once; every session event is broadcast to all current subscribers. Approval requests fan out to all subscribers of that session with first-response-wins, followed by a `resolved` broadcast to the rest so they stop prompting.
- **Disconnect ≠ kill**: a Client closing its socket connection does not stop an in-flight Turn. The Turn keeps running; its canonical event envelopes keep appending to the Session NDJSON log. A new connection can call `session/subscribe` for that Session and pick up live events immediately.
- **Replay on reconnect**: `session/subscribe` accepts `sinceSeq`, returns every canonical `{ schemaVersion, seq, emittedAt, event }` envelope after it from the Session NDJSON sequence authority, then live-tails atomically. `session/resume` opens a Session and performs that subscribe-with-replay atomically. Disk and wire use the identical envelope shape.
- Single-writer Profile lock: the daemon takes an exclusive lock on the Profile directory at startup (e.g. a lock file with PID) and refuses to start a second daemon against the same Profile. This enforces constitution rule 1 for machine-owned state at the process level without preventing direct owner edits to human-owned moldable files.
- `ziggy service install` — registers the daemon with `launchd` (macOS) or `systemd` (Linux) as a user service, so it survives login/logout and restarts on crash.
- `ziggy serve` — runs the daemon in the foreground (for `service install` to wrap, and for manual debugging).
- Daemon auto-start: any CLI/TUI command that needs the daemon and finds no live socket starts one itself (spawn + wait-for-socket-ready), modeled on the codex app-server's daemon-supervisor pattern — the user should never have to think about "is the daemon running."
- `ziggy doctor` — diagnostic command: is the daemon running, is the socket reachable and correctly permissioned, is the profile lock held by a live PID (detect and report stale locks from a crashed daemon), basic provider-auth presence check.

## Design (locked decisions binding this stage)

- Resident-daemon, one-per-profile — locked (Q2/Q3). This is what makes "connect from anywhere" possible without an always-on heartbeat: the daemon is idle (zero LLM calls) except when actively serving a turn or a triggered automation.
- Attach transport v1 is local-only: Unix socket, 0600 permissions, and no non-loopback daemon-side network listener. S5 may start a token-authenticated HTTP webhook listener on `127.0.0.1` only. "Connect from anywhere" is otherwise a Gateway concern (S6) — Gateways make outbound connections to Telegram/etc., not inbound connections into the daemon. A WS listener with bearer-token auth for remote TUI/GUI is explicitly deferred; the protocol itself must stay transport-agnostic so adding that listener later is additive, not a redesign.
- The attach protocol is modeled on OpenAI Codex's app-server (`docs/REFERENCES.md`) for its subscription/fan-out/disconnect-survives/replay design — not literally imported, ziggy's version is scoped to what S1's protocol types already define.

## Verification growth

Extend `tests/testkit` with deterministic socket peers, fiber barriers, connection/event schedules,
process crash/lock fixtures, and service-manager fakes. Register races for replay-to-live handoff,
subscribe/unsubscribe versus append, disconnect during a Turn, concurrent Sessions, simultaneous
approval responses, stale locks, socket permissions, and auto-start contention. Evidence includes
wire/event timelines, sequence assertions, process/lock state, fault schedules, and replay commands.
A separate Sol medium agent in an independent run and context hunts gaps/duplicates, double
writers, disconnect-as-cancellation, late approval effects, and non-loopback exposure.

## Acceptance criteria

- [ ] `ziggy serve` starts a daemon that creates `<profile>/.runtime/ziggy.sock` at `0600`.
- [ ] Starting a second `ziggy serve` against the same profile fails fast with a clear "already running (pid N)" error.
- [ ] Two separate Client connections can both call `session/subscribe` for the same Session and both receive the same live events.
- [ ] Closing one Client's connection mid-Turn does not stop the Turn; the Session log continues to append; a fresh connection can call `session/subscribe` and see the Turn complete.
- [ ] A client that disconnects and reconnects can request replay from a given `seq` and receives exactly the events it missed, in order, with no duplicates and no gaps.
- [ ] Two different sessions' turns can run concurrently without one's tool execution blocking the other's event delivery.
- [ ] An approval request sent to 2 subscribed clients: the first response wins and is applied; the second client subsequently receives a `resolved` event and its own late response is a no-op.
- [ ] `ziggy service install` produces a working launchd plist (macOS) or systemd unit (Linux) that starts the daemon; `ziggy doctor` correctly reports daemon-up/down and a stale lock left by a killed daemon.
- [ ] Auto-start: running any daemon-dependent CLI command with no daemon running transparently starts one before proceeding, with no manual `ziggy serve` step required.
- [ ] The harness, S2 plan checklist, and scenario/stage manifests include every landed daemon behavior and concurrency/fault scenario; `verify:s2` and `verify:all` pass with schema-valid redacted evidence and resolved findings from verification/review by a separate Sol medium agent in an independent run and context.

## References to consult

- `docs/research/` codex app-server report (transport/framing, full method surface, subscription/attach/disconnect/replay model, minimal-subset recommendation) — the primary design reference for this stage.
- `docs/REFERENCES.md` for the exact codex-rs `app-server` source paths (`opensrc path github.com/openai/codex`).
- `docs/CONSTITUTION.md` rule 1 (sole writer) and rule 5 (clients render, never mutate) — this stage is where both become enforced by process/protocol design, not just convention.

## Suggested agent workflow

For each slice, follow the `docs/VERIFICATION.md` through-loop: dedicated Sol medium scouting/task-decomposition run and context → red scenario → separate Sol medium implementation run and context → independent Sol medium deterministic verification/evidence/review run and context. The implementing run must not be the verifying run.

1. One codex `exec` (sol-medium) task: socket server skeleton + NDJSON framing + `initialize` handshake, wired to the S1 in-process Session engine (single Session, single Client, no fan-out yet) — get the simplest possible round-trip working first.
2. One codex `exec` (sol-medium) task, after 1: multi-client subscription/fan-out + disconnect-survives-turn + replay-from-seq.
3. One codex `exec` (sol-medium) task, after 1: profile lock (single-writer enforcement) + `ziggy doctor`.
4. One codex `exec` (sol-medium) task, after 1: `ziggy service install` (launchd + systemd templates) + `ziggy serve` + daemon auto-start-from-CLI.
5. Independent Sol medium verification/review pass in a separate run and context, focused specifically on disconnect/replay/fan-out concurrency — hunt for sequence gaps/duplicates and any window where an event can be dropped before subscription registration; convert applicable findings to deterministic regression scenarios.
6. The independent Sol medium verifying run exercises the multi-client acceptance scenarios above with real socket connections, not mocks.

## Non-goals

- No remote/WS attach transport — local Unix socket only. The S5 loopback-only webhook listener is a separate ingress surface. Note the protocol-agnostic requirement so remote attach remains additive later.
- No real TUI/GUI — a minimal test client (raw socket + protocol SDK) is sufficient for this stage's own testing.
- No extensions, no automations, no gateways.
- No Cloudflare/remote "world" — filesystem storage only (Cloudflare adapter is S7, must pass the same S0 contract tests when it lands).
