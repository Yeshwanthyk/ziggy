# S3 — Face

## Goal

Give ziggy a real face: a profile-scaffolding command, starter personalities, a rich terminal client, and CLI one-shots — talking to a real daemon over a real provider for the first time. This is the first stage where a human can actually sit down and use ziggy.

## Current implementation state

The current worktree contains the complete S3 implementation. Findings-bearing deterministic
`verify:s3` and `verify:all`, real API-key and browser-OAuth journeys, a real Luna-high model call,
and the human TUI journey all pass.

Completed and independently verified:

- Inherited S2 deterministic closure: real-socket cross-Session concurrency, replay-cursor
  hardening, compiled-runtime detection, and native macOS service lifecycle evidence. Linux native
  service behavior remains explicitly unavailable on this Darwin host; deterministic systemd
  contracts pass.
- Non-destructive Profile initialization: strict JSONC preflight, canonical Profile identity,
  private modes, three embedded Voices (`clear`, `warm`, `operator`), concurrency/failure cases,
  and compiled-binary proof.
- Deterministic Provider/auth behavior: strict Profile config loading, daemon-owned bounded
  credential persistence, full-catalog `pi-ai` composition, filesystem Session runtime binding,
  negotiated attach auth, API-key/OAuth fake-boundary coverage, compiled OAuth loading, secret
  redaction, and Provider failure projection.
- Effect-native runtime ownership: typed failures, scoped Profile lock and daemon resources,
  structured Session/auth fibers, one executable runtime edge, named host adapters, blocking
  Effect lint, and a compiled lifecycle scenario covering readiness and cleanup.

Task #3 is closed. Independent post-migration review found one compiled-shutdown proof gap:
the lifecycle scenario discarded the daemon exit status and stderr. The registered regression now
requires pinned Effect's intentional-SIGTERM contract (interruption-only exit `130`), rejects any
unexpected exit, and retains only bounded redacted stderr. A fresh independent review marks the
finding fixed with no open findings. The findings-bearing `verify:s3` and subsequent `verify:all`
pass 19 scenarios against the Effect-native implementation.

Task #4's Client/TUI pause-gate review and implementation are complete. Attach protocol v2, the
stable main Session, shared scoped Client, CLI one-shots, Session list, protocol-only TUI, and live TUI
adapter pass deterministic verification. A disposable live run then used a real Anthropic API-key
login and user-authorized import of existing Codex OAuth credentials with
`openai-codex/gpt-5.6-luna` at `high`. The compiled `ask` path returned a real response with exactly
one final newline and persisted a complete schema-v1 Turn.

The same human TUI journey found two deterministic gaps that scripted immediate-replacement tests
had missed: a daemon absent for one second exhausted the old one-shot reconnect, and a fresh TUI
could overflow while replaying an 883-envelope Session. `S3-LIVE-001` and `S3-LIVE-002` are fixed
with bounded Effect-owned reconnect, candidate-private replay, interruption-safe correlation, and
bounded end-to-end socket/Client backpressure. Regressions now replay 900 contiguous unique
envelopes beyond all default queue/byte capacities. The rebuilt live TUI replayed the 883-envelope
Session, progressed through `RETRY 4 · #883` while the daemon was absent, and returned to writable
`READY` after restart without visible duplication. Full `bun run check` passes 552 tests. A final
fresh disposable Profile then completed Ziggy's compiled production `openai-codex` browser OAuth
exchange without importing credential bytes, persisted a private refresh-capable credential, passed
`doctor`, and returned exactly `ZIGGY OAUTH LIVE\n` from real `gpt-5.6-luna`. The daemon, OAuth
driver, and disposable credentialed Profile were deleted after metadata-only evidence was retained.

## Entry gate — inherited S2 closure

S2's implementation is present and its deterministic `verify:s2` / `verify:all` gates pass, but
S3 must not assume every end-to-end product claim is already closed. Before building the Face,
the next session must inspect the live S2 implementation and close or explicitly disposition these
inherited gaps:

1. [x] Add a deterministic real-socket scenario proving two different Sessions can run concurrently:
       block one Session in Provider/tool work and prove the other Session continues its Turn and event
       delivery independently.
2. [x] Harden the replay cursor boundary. A safe-integer `sinceSeq` beyond the current durable tail must
       not later receive live envelopes whose `seq` is below that requested cursor. Prefer rejecting it
       with the existing `unsafe-sequence` protocol error unless live implementation evidence supports a
       simpler invariant-preserving rule.
3. [x] Run native service-definition smoke where the host permits it: macOS `plutil` plus a launchd
       user-domain load/start/stop check locally, and Linux `systemd-analyze` plus user-manager behavior
       in a Linux environment. macOS passed against a disposable compiled Profile service; because this
       host is Darwin, Linux systemd tools, user-manager behavior, and lingering remain unprobed and
       explicitly `unavailable-on-host`.
4. [x] Exercise S2 auto-start through S3's first real daemon-dependent Client command. A compiled
       `ask` against an absent daemon crosses detached start, attach v2 readiness, original-intent
       retry, and one durable Turn; a barrier-controlled absent-to-stale race refuses startup.
5. [x] Run independent S2 deterministic verification/review for the concurrency, cursor, service,
       compiled-runtime, and lifecycle changes; resolve every finding and retain schema-valid redacted
       evidence.
6. [x] Reconcile the final S2 product-path checklist after compiled `ziggy ask` proves auto-start
       exactly once. Native and live behavior remain separate and are not inferred from deterministic
       Provider tests.

Known S2 constraints that are not second authorities and should not be rediscovered as surprise
design changes: lock ownership uses schema-stamped PID/token metadata rather than an OS advisory
lock (PID reuse can conservatively look live); `session/resume`'s returned `SessionSummary.lastSeq`
may trail its authoritative `replayThroughSeq` during a concurrent append; detached auto-start
currently surfaces a bounded readiness timeout rather than child stderr. Preserve these constraints
unless S3's real Client path demonstrates that one blocks a required user journey.

## Deliverables

- `ziggy init [path]` — scaffolds a new profile folder:
  - `ziggy.jsonc` (profile config: default provider/model, thinking-level defaults, other top-level settings).
  - `SOUL.md` — the profile's personality/instructions file, seeded from a chosen starter voice template.
  - `memory/` (empty, ready for `MEMORY.md`/`USER.md` to be created on first write).
  - `sessions/` (empty).
  - `extensions/` (empty).
  - `automations/` (empty).
  - `credentials/` — created with `0600`/`0700` permissions for provider auth material.
  - **Non-destructive**: `ziggy init` on a folder that already has a `SOUL.md` (or other profile files) must never clobber them — prompt or no-op instead. (This is a direct lesson from merlin — see `docs/REFERENCES.md`.)
- Production daemon Session composition — replace S2's deliberately unavailable runtime factory
  with Profile-config-driven Provider/model/auth resolution and the real filesystem Session runtime.
  The daemon remains the loop owner; pi-ai remains a Provider wire adapter and never becomes a
  second loop. A Session must still freeze its prompt/Memory/tool snapshot through the existing S1
  path before its first Turn.
- 3–4 starter voice templates (distinct `SOUL.md` starting points — e.g. a neutral/minimal assistant, a warm personal-assistant tone, a terse engineering-focused tone; exact set is DECIDE-AT-BUILD with the user) selectable via `ziggy init --voice <name>` or an interactive prompt.
- Attach protocol v2 and stable main Session — reserve literal Session ID `main`; add idempotent
  `session/ensure` with `{ sessionId: "main" }`; lazily materialize `sessions/main.ndjson` through
  the daemon on first ensure; advertise `stableMainSession`; reject attach v1 while leaving Session
  NDJSON schema v1. `ziggy init`, daemon startup, `session/list`, and `session/resume` never create
  the main Session.
- `packages/tui` — rich terminal Client built on `pi-tui`, depending **only** on
  `packages/protocol` (never on `packages/core` — enforced by the package graph). It streams an
  in-flight Turn, steers or queues follow-up input, switches between all Sessions, handles
  approvals, and replays correctly from the last fully applied sequence after reconnect.
- CLI one-shots in `packages/ziggy`: `ziggy ask "<prompt>"` streams only the accepted Turn's model
  text against the stable main Session and exits under the locked outcome contract;
  `ziggy sessions list` purely lists all persisted Sessions; `ziggy service
<install|start|stop|status>` wraps S2's service commands; `ziggy doctor` exposes S2 readiness.
- Provider auth flows surfaced to the user: API-key-via-env-var path documented and checked by `doctor`; OAuth login command(s) (`ziggy auth login <provider>`) wired to whatever `pi-ai` exposes for OAuth providers (Anthropic Pro/Max, `openai-codex-responses` for Codex/ChatGPT Plus/Pro) per `docs/REFERENCES.md`.
  - Deterministic Provider-runtime/auth behavior is implemented: strict Profile config loading, daemon-owned schema-stamped credential authority, singleton full-catalog `builtinModels` composition, real filesystem Session runtime binding, bounded attach auth prompts/status, API-key/OAuth fake-boundary coverage, generic Provider/auth failure projection, and compiled Bun OAuth-loader smoke. Owner config is validated before readiness and reloaded when creating each new Session; existing Session runtimes retain their already selected Provider/model settings. Daemon/kernel/Provider resource composition is Effect-native. Live API-key/OAuth/model calls remain manual and are not claimed by deterministic evidence.

## Design (locked decisions binding this stage)

- Rich TUI ships in v1 — not CLI-only (Q10, locked). The TUI is a pure attach Client: it renders
  and sends protocol operations; it never mutates Session or Memory state directly (constitution
  rule 5).
- `tui` depends only on `protocol`, never on `core` or `ziggy`. A callback-shaped TUI Client port is
  implemented in `packages/tui`; the Effect/Unix transport adapter lives in `packages/ziggy`.
- Attach protocol v2 adds `session/ensure` and `stableMainSession`; attach v1 fails loud. The
  canonical Session envelope and NDJSON schema remain v1. The existing `replayThroughSeq` watermark
  is sufficient for replay completion, so S3 adds no replay-complete frame.
- The stable main Session is `sessions/main.ndjson`, created only by daemon-owned `session/ensure`.
  Session listing is a pure query over all persisted Sessions. Pinning is deferred and has no S3
  state or protocol surface.
- Provider layer ships the full `pi-ai` catalog (Q9, locked) — `ziggy auth login` should not be hand-built per provider; lean on whatever `pi-ai` already provides for credential storage/OAuth flows, adapted to ziggy's own `credentials/` file location if `pi-ai`'s default storage location doesn't fit the per-profile-folder model.
- Non-destructive `ziggy init` is a hard requirement, not a nice-to-have — sourced directly from a merlin lesson-learned.
- Core runtime and daemon lifecycle are Effect-native. Bun/filesystem/`pi-ai` Promise APIs are wrapped
  once at their boundaries; daemon-scoped resources use `Layer.effect` or `Effect.acquireRelease`;
  Session runtime creation is an Effect service; interruption and finalization are represented in the
  Effect scope. Effect execution belongs only at the executable edge and the central test adapter;
  native Promise APIs remain isolated in named host/vendor adapters.

## Verification growth

Extend `tests/testkit` with fixture-owned Profile trees, scripted terminal rendering/input,
simulated Provider/Auth adapters, and disconnect/reconnect controls. Register non-destructive init,
strict pre-mutation validation of existing JSONC config, canonical Profile identity, initializer
races/failures, distinct Voices, concurrent stable-main ensure and restart, strict attach v1 rejection,
forbidden `tui -> core|ziggy` edges, one-shot write/outcome boundaries, and streaming/steer/approval/
watermark-replay behavior. Evidence includes
Profile diffs, render snapshots, protocol traces, package-graph output, and separate manual live-
Provider smoke records. A separate Sol medium agent in an independent run and context reviews
Client-only mutation, secret leakage, buffered rendering, replay duplication, and any deterministic
test that reaches a live service.

## Acceptance criteria

- [x] `ziggy init ./my-profile` produces the full directory listed above; running it again on the same folder does not overwrite an edited `SOUL.md`.
- [x] Existing `ziggy.jsonc` is validated before any mutation: supported JSONC comments are accepted, malformed/unknown/invalid config fails closed, and valid owner bytes and modes remain unchanged.
- [x] Profile initialization canonicalizes existing ancestor and final-component filesystem aliases before creating or returning the Profile path, while rejecting a symbolic link in the final Profile component.
- [x] Same-process concurrent initializers converge through exclusive creation; a child-process invalid-config winner is rejected before scaffold entries are added; and a deterministic pre-create failure proves loud failure and safe retry. Concurrent valid initializers across separate processes, create-operation fault cleanup, and host permission-denial behavior remain unclaimed.
- [x] `ziggy init --voice <name>` (or interactive equivalent) seeds `SOUL.md` from the chosen template. Each of at least 3 Voice templates differs in its stated persona summary, tone directives, and default verbosity section; a scripted diff check confirms those sections are non-identical across templates.
- [x] Deterministic Provider/auth contracts cover strict Profile configuration, bounded daemon-owned credential persistence, model resolution, real filesystem Session runtime construction, negotiated/cancellable auth interaction, API-key and OAuth fake boundaries, compiled OAuth loading, metadata-only status, and secret-safe failures/evidence.
- [x] Daemon/kernel/Provider composition is Effect-native: scoped Profile lock, shared Provider/auth resources, per-Session runtime factory, attach server, interruption, and ordered finalization are represented by Effect; only external Promise APIs are wrapped at boundaries.
- [x] Manual API-key login succeeds end-to-end for at least one real Provider. The disposable
      Anthropic Profile used the production hidden TTY prompt and persisted only a mode-0600,
      schema-v1 credential document.
- [x] Manual OAuth login succeeds end-to-end for at least one real Provider. A fresh disposable
      Profile ran the compiled production `openai-codex` browser flow without importing existing
      credential bytes, completed the PKCE localhost callback and token exchange, persisted a
      mode-0600 schema-v1 refresh-capable credential, passed `doctor`, and returned an exact real
      `gpt-5.6-luna` response.
- [x] After the live API-key login and Codex OAuth import, `ziggy doctor` reports the real Provider
      authentication state without exposing credential material.
- [x] `ziggy ask "hello"` against a real, authenticated Provider ensures the stable main Session and
      streams a real `gpt-5.6-luna` response with exactly one final newline and empty stderr.
- [x] The live Provider Turn is inspected in `sessions/main.ndjson` and proven schema-v1, contiguous,
      and complete per S1/S2; the recorded step names `openai-codex/gpt-5.6-luna` and the Turn ends
      `completed`.
- [x] With no daemon running, the first compiled `ziggy ask` transparently auto-starts the Profile
      daemon, completes attach v2 initialization, and retries setup once only before any `turn/start`
      write. After a write without a correlated response it exits outcome-unknown without resending,
      so the Profile records one Turn rather than zero or two.
- [x] Compiled process scenarios prove exits 0, 1, 2, 3, and SIGINT 130 with bounded stderr, transport finalization, barrier-controlled stale-socket refusal, and no daemon Turn interruption.
- [x] Two different Sessions run concurrent scripted Turns over separate real socket Clients; a barrier-blocked Provider/tool call in one Session does not block the other Session's event delivery or completion.
- [x] A subscribe/resume request with `sinceSeq` beyond the durable tail is rejected or otherwise proven never to receive a later live envelope below that cursor.
- [x] Native service smoke is recorded for supported hosts: launchd validation/lifecycle on macOS and systemd unit validation/user-manager lifecycle on Linux, with unavailable host capabilities reported rather than simulated as success.
- [x] Deterministic controlled Providers drive `ZiggyTuiComponent` through the production TUI interpreter and shared Attach Client over real Unix sockets. The scenario proves stable-main replay, token streaming, steer, exactly-once queued follow-up, active-Turn interrupt, local-first and remote-first approval resolution, A-to-B-to-A replacement with stale callback rejection, disconnect without Turn cancellation, last-applied-cursor replay/live overlap without duplication, blocked retry mutations, outcome-unknown composer retention, and quit/Ctrl+C cleanup without daemon interruption. Supporting interpreter contracts prove bounded serialized command execution, exact Attach calls, overload reporting, generation-safe callbacks, idempotent cleanup, and cleanup-failure propagation.
- [x] A human terminal journey opens the stable main Session with a real Provider; observes token-by-token streaming; uses active-Turn Enter to steer, Alt+Enter/F2 for queued follow-up, Ctrl+X to interrupt, Ctrl+P for all Sessions, and Escape only to dismiss overlays; and after restart verifies replay without duplication from the last canonical sequence rather than fetching from zero. The final rebuilt TUI replayed 883 envelopes to `READY`, retained `#883` through four bounded reconnect attempts while the daemon was absent, and returned to writable `READY` after restart.
- [x] `packages/tui`'s `package.json` has zero dependency on `packages/core`, proven by the deterministic package-graph gate; hosted CI remains disabled.
- [x] `ziggy sessions list` is a pure query that shows every persisted Session in deterministic
      creation-time/Session-id order, including `main` once a main-dependent Client has ensured it.
      Listing never creates `main`; no pin state or pin/unpin protocol ships in S3.
- [x] The harness, S3 plan checklist, and scenario/stage manifests include every landed deterministic Face behavior and negative/reconnect scenario; findings-bearing `verify:s3` and `verify:all` pass with schema-valid redacted evidence and consolidated resolved review findings. Real Provider/Auth and human TUI evidence remain separate and cannot waive deterministic failures.

## References to consult

- pi-tui (`@earendil-works/pi-tui` — check `docs/REFERENCES.md` / pi-mono `packages/tui`) — differential-rendering, keybindings, native modifier detection to build on rather than reimplement.
- merlin (`/Users/yesh/code/personal/merlin`, reference-only) — specifically whatever lesson documented the profile-init/SOUL.md-clobbering pitfall; cite the exact file in the implementation PR.
- `docs/research/` pi-ai-as-provider-layer report — for `ziggy auth login`'s credential-storage and OAuth-flow integration points.
- `docs/CONSTITUTION.md` rule 5 (clients render, never mutate) — the TUI/core dependency boundary is the concrete enforcement mechanism for this rule.

## Current execution plan

Every orb follows `docs/VERIFICATION.md`: dedicated scout/decomposition context → red deterministic
scenario → separate implementation context → independent verification/evidence/review context. The
implementing run never verifies its own work.

### Completed orbs

1. **S2 closure** — concurrency, cursor safety, compiled daemon detection, service lifecycle, native
   macOS smoke, and independent verification.
2. **Profile initialization** — non-destructive scaffold, Voices, JSONC validation, canonical identity,
   permissions, compiled proof, and independent verification.
3. **Provider/auth behavior** — config, CredentialStore, `pi-ai` catalog/model resolution, filesystem
   Session composition, attach auth, CLI login/doctor integration, OAuth compiled loading, security
   hardening, and independent deterministic verification.
4. **Effect lifecycle closure** — typed Effect APIs across runtime, Memory, World, Profile,
   credentials, Provider/auth, daemon, attach, service, and CLI orchestration; scoped acquisition and
   ordered cleanup; blocking production lint; centralized test execution; and compiled daemon
   lifecycle proof.

### Task #4 Client orb split

The pause-gate review is complete. Implement in this order:

1. register the red stable-main scenario, then land attach protocol v2 and daemon-owned
   `session/ensure`;
2. build the shared scoped Effect Attach Client and Unix transport in `packages/ziggy`, leaving
   dependency-free `packages/protocol` as pure types/codecs;
3. register CLI/TUI red scenarios serially in the shared registry/manifest;
4. implement `ziggy ask`/`ziggy sessions list` and the pure TUI reducer/renderer in parallel;
5. wire TUI live transport, streaming, steering, approvals, Session switching, and reconnect replay;
6. run integrated independent verification and the separate manual live journey.

The CLI and pure TUI implementations may run in parallel only after the shared Session/protocol/Client
contracts land. They must not concurrently edit `packages/ziggy/src/cli.ts`, the scenario registry,
the S3 manifest, or this plan; the integration owner reconciles those shared files.

## Locked Client contracts for task #4

- **Stable main Session:** attach v2 reserves literal `main`; idempotent `session/ensure` with
  `{ sessionId: "main" }` lazily materializes `sessions/main.ndjson` through the daemon and advertises
  `stableMainSession`. Concurrent first Clients converge through the Session registry. The Session log
  is the only durable existence authority; init, startup, list, and resume do not create it.
- **Session listing:** `session/list` remains a pure query over all persisted Sessions. Main-dependent
  Client commands ensure `main` first. Pinning and pin state are deferred beyond S3.
- **One-shot output:** `ziggy ask` streams only its accepted Turn's model text to stdout, ending success
  with exactly one newline; diagnostics use stderr. Exit codes are `0` success, `1` known runtime
  failure, `2` usage, `3` outcome unknown, and `130` local interruption. Setup retries once only while
  `turn/start` is untouched. After a write without correlated response it never resends; after
  correlated acceptance it reconnects/replays from the last fully applied sequence without resending.
- **Shared Attach Client:** `packages/protocol` owns only dependency-free types, codecs, constants, and
  pure helpers. `packages/ziggy` owns the shared scoped Effect Client and named Unix transport adapter,
  then adapts it to a callback-shaped port owned by `packages/tui`.
- **Simple isolated TUI:** compose exact pinned `@earendil-works/pi-tui` directly. Do not embed
  `pi-coding-agent`, Pi RPC, Pi's loop, Session manager, themes, packages, or Extension runtime. The
  Ziggy TUI never reads or writes `~/.pi` or `~/.agents`, ships a small Ziggy-owned theme seam, and
  reserves user-installable Ziggy Extension UI contributions for S4.
- **Controls and reconnect:** idle Enter starts a Turn; active Enter steers; Alt+Enter or F2 queues a
  follow-up; Ctrl+X interrupts; Ctrl+P opens the all-Session picker; Escape dismisses overlays; Ctrl+C
  and quit detach without interrupting daemon work. Connecting/replaying/live/disconnected/retrying/
  outcome-unknown states are explicit. Replay applies contiguous envelopes through
  `replayThroughSeq`; no replay-complete frame or durable operation identity is added.

## Non-goals

- No extensions loaded yet (S4) — the TUI/CLI talk to a daemon with session+memory only.
- No automations (S5).
- No gateways (S6) — TUI/CLI only, local Unix socket only.
- GUI client is out of scope — post-v1 (S7).
