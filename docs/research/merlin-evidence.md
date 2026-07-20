# Merlin lessons — EVIDENCE ONLY, never imported as code or architecture

This document exists so ziggy's decisions can be checked against what the user's own prior
iteration already tried, learned, and (in several cases) explicitly reversed. Per D1, none of
merlin's code, schemas, or in-progress architecture is imported into ziggy — this is prior-art
evidence only, re-derived from a clean slate.

Date: 2026-07-19
Source: `/Users/yesh/code/personal/merlin` (private, local-only, Go-based).

## 1. The three phases

Merlin's own commit/doc history shows three successive framings of the same product vision,
visible directly in its ADR titles and superseded-by chains:

1. **Claw** — the original Go kernel/CLI name, predates the "profile is the assistant" framing.
   `docs/adr/0002-evolve-the-go-kernel-in-place.md` explicitly chose to keep evolving the Claw Go
   kernel rather than adopt a TypeScript/Bun proof-of-concept that had been prototyped in parallel
   (`../ziggy-bak`), and explicitly forbids importing that prototype's source.
2. **Merlin** — the repo's working name during the six-primitive redesign (ADR 0003-0006), where
   "claw" survives only as legacy/internal naming outside the "strict Profile" boundary.
3. **Ziggy** — merlin's _own_ chosen name for its target architecture and eventual command
   (`docs/adr/0004-use-ziggy-names-at-the-strict-profile-boundary.md`: "the command and package are
   `ziggy` and `cmd/ziggy`, the Runtime is `ZiggyRuntime`, and strict Profile control state is
   `.ziggy`"). Note: this means the _name_ ziggy predates this project — this repo is a clean-slate
   re-derivation of a vision merlin had already named and partially built toward in Go, not a
   coincidence of naming.

## 2. Primitive glossary and ADRs (merlin's own, for comparison against ziggy's 7)

Merlin's final primitive count was **six**: Profile, Session, Memory, Gateway, Extension,
Automation (`docs/adr/0005`). Ziggy's is **seven** — it adds Provider as an explicit first-class
primitive (merlin folded provider selection into Runtime/Session config rather than naming it).

- **ADR 0001** — _Keep generative GUI and sandboxing out of the Ziggy kernel_ (accepted, later
  partially superseded by 0005). Canvas is explicitly not a primitive: "generative presentation
  belongs to the GUI Client and its contract still needs to be shaped; baking a renderer-neutral UI
  model into Ziggy would make the kernel heavier." Sandbox is explicitly not a primitive either —
  "isolated execution can be supplied by an optional Extension—similar to Executor—through the
  same discovery, readiness, invocation, and evidence boundaries as other capabilities." Direct
  precedent for ziggy also treating Executor as just another extension rather than a core noun.

- **ADR 0002** — _Evolve the Go kernel in place_ (accepted). Chose continuity over a rewrite;
  explicitly forbids importing the parallel TS/Bun prototype (`../ziggy-bak`) or a `../jeeves`
  reference repo as source. (Ziggy inverts this choice deliberately — D1/D2 — but the ADR's
  boundary-drawing discipline, "read-only design evidence only, no source import," is exactly the
  posture this document itself follows toward merlin.)

- **ADR 0003** — _Use a cwd-local Profile with one Runtime writer_ (accepted). "A Profile is one
  self-contained directory representing one assistant, and every Run executes with that directory
  as its working directory. The target has exactly one authoritative resident Runtime process
  executing and writing a Profile; all Clients, Gateways, and Automations attach or submit to that
  owner instead of starting a competing fallback." This is the direct ancestor of ziggy's D4
  (resident-first, one daemon per profile) and of the sole-writer constitutional invariant —
  **including the same tension ziggy's own constitution now has to resolve**: merlin's ADR already
  distinguishes "Profile-wide ownership lock" (who may _execute/mutate_) from "transient ownership,
  endpoint, and cache state" (explicitly called out as "replaceable and does not become Profile
  history") — i.e., merlin's own ADR already implicitly separates durable-authoritative state from
  other Profile content, which is exactly the distinction ziggy's C1/C2 fixes need to make explicit.

- **ADR 0004** — _Use Ziggy names at the strict Profile boundary_ (accepted, supersedes 0002's
  naming deferral). Pure naming-cutover discipline; not architecturally load-bearing for this repo
  beyond confirming provenance of the name.

- **ADR 0005** — _Use Profile as the assistant and Session as a primitive_ (accepted, supersedes
  0001's primitive enumeration). The single most important merlin correction: **"One Profile
  represents one assistant, so Ziggy removes the nested durable Agent resource."** Before this ADR,
  merlin had a durable `Agent` resource nested under `Profile` with its own precedence chain
  (`Run → Agent → Profile`); this was removed by breaking cutover in favor of `Run override →
Profile default`. Session became the sixth primitive, "owns append-only transcript and
  Run/effect evidence," while "Memory narrows to scoped retained facts and recall." The ADR is
  explicit that this is a correction of a prior conflation: **Memory = retained facts,
  Session = transcript**, stated as two separate ownership domains for the first time here. Also:
  "Gateway identity and Session routing are independent from Memory-scope authorization. Profile
  owns Person records and the distinguished owner; Gateways own identity edges, and primary
  authorization fails closed." — direct ancestor of ziggy's S6 owner/Person identity design.
  "Multiple independent assistants require multiple Profiles, even if a future host multiplexes
  them" — matches ziggy's "one profile = one daemon, no global registry" decision exactly.

- **ADR 0006** — _Use concurrent per-Session lanes with ephemeral admission queues_ (proposed, not
  accepted — merlin never finished implementing this). "The resident Runtime will hold Profile
  ownership for its process lifetime and run up to four configurable Sessions concurrently, while
  each Session admits at most one active Run." Notable design points, all relevant to ziggy's S1/S2:
  - "New direct Client input steers an active Run in the same Session at a safe provider/tool
    boundary and continues under the same Run ID; Gateway and Automation inputs to a busy Session
    queue FIFO" — steer vs. queue distinguished by _source_, not just presence of an active run.
  - "Admission queues live only in resident Runtime memory. Queued-but-not-started input is
    explicitly lossy on Runtime crash; active Runs still reconcile from Session evidence." — an
    explicit lossy/durable boundary ziggy should state the same way rather than pretending queues
    are durable.
  - "Client disconnect does not cancel a Run. Clients may reconnect and inspect or resume streaming
    the Session." — same invariant as ziggy's constitutional #8 (disconnect never kills work).
  - "Delivery intent and outcome are canonical Session records. A Runtime-owned durable outbox
    projection retries by idempotency key without rerunning the model." — relevant precedent for
    ziggy's Automation broadcast-rules delivery design (S5).
  - "Reply routes are captured per submission/Run, never inferred from a mutable Session 'last
    route.'" — directly informs ziggy's Gateway resume-handle design (avoid inferring routing from
    mutable last-known state, per the Telegram lesson below).

## 3. Architecture merlin ended with, by subsystem

- **Kernel**: single compiled Go binary (`cmd/ziggy`), macOS arm64 + Linux amd64/arm64
  (ADR 0002). Runtime = `ZiggyRuntime`. `.ziggy` is strict-Profile control state.
- **Sessions**: JSONL append-only per session, `Store.GetOrCreate`/`Store.Append`, parent-chain
  context building (`session.BuildContext`) — same "walk the tree" shape pi-mono uses, independently
  arrived at. `internal/session/jsonl.go` fsyncs one JSON object per line.
- **Runtime/session-key resolution**: `SessionKeyFor` — room-linked key overrides platform-native
  chat keys (`room:<roomID>`), else per-channel keys like `telegram:<account>:dm:<chatID>`.
- **Web/GUI (Merlin Projects)**: a browser dashboard that bridges into Claude/Codex CLI sessions via
  tmux panes, later moved to JSONL polling (see §5).
- **Legacy Codex app-server integration**: `GPT55CodexModel()`/`NewCodexAppServerProvider()` spawn
  a child `codex app-server` process; Merlin's web process hydrates displayed messages "from the
  Claw runtime transcript JSONL for the runtime session" rather than trusting app-server's own
  thread state as canonical — i.e., app-server output gets _projected into_ the Runtime's own
  transcript rather than the Runtime treating app-server as an alternate source of truth. This is
  the concrete precedent for ziggy's "providers never own the loop" invariant (#4): even when
  wrapping a full external agentic loop (app-server), merlin still routes its output back through
  its own canonical Session record rather than ceding transcript ownership.

## 4. Canvas (`ziggy.tldraw`) content summary

Merlin's repo root includes a tldraw canvas (`ziggy.tldraw`) used as a working design surface. Per
prior inspection in this project's design phase, it laid out a north-star statement, staged build
sequence, and an explicit warning against architecture "gravity wells" — i.e., against organically
letting one subsystem (in merlin's case, Memory, and separately the web Projects UI) absorb
responsibilities that belong to a different primitive. This warning is the direct ancestor of
ziggy's own constitutional invariant that "no state may have two writable authorities."

## 5. Lessons and pain points (with merlin file evidence)

1. **Agent-vs-Profile redundancy, corrected.** ADR 0005 removed a nested durable `Agent` resource
   that duplicated Profile identity/config, collapsing to "one Profile = one assistant." Ziggy never
   introduces this resource in the first place (no `Agent` noun in the 7-primitive vocabulary).

2. **Memory-vs-Session conflation, corrected.** Pre-ADR-0005 merlin let Memory and Session overlap;
   ADR 0005 is the explicit correction: Memory = retained facts only, Session = transcript owner.
   This is merlin's single most-repeated architectural correction and is why ziggy locks this
   separation from day one (D3, constitutional invariant #2) rather than discovering it later.

3. **Second-authority retirement ("lossless" derived-context engine).** ADR 0005: "Lossless Claw
   may provide a derived context engine but cannot own canonical Sessions or Memory facts." Merlin
   built a full-text-search/"lossless" derived index and had to explicitly demote it from being a
   second writable authority to being a read-only projection over canonical Session/Memory data.
   Direct ancestor of ziggy's invariant #3 ("no state may have two writable authorities").

4. **Codex app-server loop ownership.** See §3 above — app-server output is hydrated into the
   canonical transcript rather than trusted as an alternate source of truth, evidence for ziggy's
   invariant #4 and for treating codex app-server as a _protocol-shape template_ rather than a
   provider ziggy delegates the loop to.

5. **Telegram reply-threading / memory bug** (`reports/telegram-memory-deep-dive.md`, full
   root-cause writeup). Summary of the actual bug: Telegram's inbound adapter discards the
   replied-to message body — `InboundFromUpdate` stores only `ReplyToID: replyToID(msg.ReplyToMessage)`
   (`internal/adapters/telegram/adapter.go:71-109`), and `replyToID` returns _only_ the numeric
   `message.MessageID`, dropping the nested `ReplyToMessage`'s text/sender/timestamp/media entirely
   even though the Telegram API delivers all of it. `InboundTurn` (`internal/channel/channel.go:17-33`)
   has no field for reply text/author/media at all, so nothing downstream (`inboundText`,
   `runtime.SendInput`, transcript append) can ever see it, regardless of session-key correctness.
   Separately, group-chat policy filtering (`RequireMention`) drops non-mentioned messages _before_
   they ever reach `HandleInbound` or get persisted (`internal/adapters/telegram/polling.go:52-73`),
   so "what were we just discussing" fails in groups because the chatter was never recorded, not
   because of a session-key bug. The report's root-cause framing is important for ziggy: this was
   **not** a session-key/memory-scope resolution bug (the sessions were correctly and consistently
   keyed by chat/topic) — it was a data-loss bug at the adapter boundary, where a richer upstream
   message shape got collapsed to a bare numeric id before it ever reached the runtime. The
   recommended fix path (inject a bounded quoted-reply block into the turn text, cap it, prefer
   explicit provenance over inferred "last route") is exactly why ziggy's Gateway design (S6) keeps
   the _resume handle_ (which conversation this is) and the _inbound message's own referenced
   content_ as separate, explicitly-carried fields rather than trusting a numeric id to survive
   the adapter boundary, and why "reply routes are captured per submission/Run, never inferred from
   a mutable Session 'last route'" (ADR 0006) is treated as a hard rule, not a nice-to-have.

6. **tmux fragility.** `LOG.md`: Merlin's web dashboard originally bridged into coding-agent CLI
   sessions by tailing tmux panes ("Bridge Claude check-ins to Claude JSONL transcripts instead of
   tmux pane tails," "Replace manual Claude Check in with 1.5s JSONL auto-polling," "Recover Claude
   project sessions when the tmux session/window is missing"). tmux panes proved unreliable as a
   state source — sessions/windows could disappear out from under the dashboard. The fix was to
   stop treating the terminal multiplexer as a data source at all and read the durable JSONL
   transcript directly instead. Direct precedent for why ziggy's attach protocol (D5) is a proper
   structured RPC/event protocol over a socket, never a terminal-scraping integration, and why any
   background/tmux-based execution (per the user's own delegation-tooling defaults) must still
   treat the durable transcript, not the terminal session, as ground truth.

7. **Destructive-setup footguns.** `PLAN.md` gotchas: `"claw setup --yes" clobbers AGENTS.md/SOUL.md
with work defaults → needs non-destructive seeding fix someday`, plus stray `claw init` artifacts
   (SOUL.md, agents/, skills/claw-ops/, .claw/) appearing at the repo root from misdirected runs,
   requiring manual `find <dir> -delete` cleanup because `rm` alone was interactive/unsafe there.
   Direct precedent for ziggy's S3 requirement that `ziggy init` be explicitly non-destructive
   (never overwrite an existing SOUL.md/AGENTS.md without an explicit flag).

8. **One-writer invariant, hard-won.** Threading through ADR 0003 ("exactly one authoritative
   resident Runtime process executing and writing a Profile"), ADR 0005's demotion of the lossless
   index, and ADR 0006's "Runtime-owned durable outbox," merlin's most-repeated invariant across its
   whole design history is: no state may have two writable authorities. Every other lesson above is
   ultimately a specific instance of this rule being violated (Agent vs. Profile identity, Memory vs.
   Session content, lossless index vs. canonical Session, app-server thread state vs. canonical
   transcript, dashboard's tmux view vs. canonical JSONL) and then corrected. This is why it is
   ziggy's constitutional invariant #3, stated context-free rather than as a per-subsystem patch —
   and why ziggy's own C1/C2 review findings need to resolve _which_ Profile content that rule
   actually covers (authoritative conversational state) versus which Profile content is legitimate
   durable configuration that non-Runtime processes may need to write under mediation (setup,
   extension install, direct file edits) — a distinction merlin's ADR 0003 had already started to
   draw ("transient... state... does not become Profile history") but never fully formalized.
