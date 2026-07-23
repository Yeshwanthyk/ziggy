# Decisions

This is the founding decision log for ziggy. Every entry below was made and locked during the
2026-07-19 design session (research via subagents + a 13-question grilling pass). Status on every
entry is **LOCKED (2026-07-19)** unless a later doc supersedes it — if you're an agent building a
stage and think a decision here is wrong, raise it, don't silently override it.

See also: [NORTH-STAR.md](./NORTH-STAR.md) (vision these decisions serve), [CONSTITUTION.md](./CONSTITUTION.md)
(the invariants distilled from them), [REFERENCES.md](./REFERENCES.md) (source repos cited below),
[ROADMAP.md](./ROADMAP.md) and [plans/](./plans/) (where each decision gets built).

## Table of contents

| #   | Decision         | One-line                                                     |
| --- | ---------------- | ------------------------------------------------------------ |
| D1  | Clean-slate spec | merlin is evidence only, never imported                      |
| D2  | Runtime          | Bun + `bun build --compile`, no `--minify`                   |
| D3  | Memory           | file-based, hard caps, reject-at-cap, frozen snapshot        |
| D4  | Residency        | resident daemon, one per profile                             |
| D5  | Attach protocol  | codex-app-server-modeled, NDJSON, unix socket v1             |
| D6  | Loop ownership   | ziggy owns the loop; pi-ai is per-call only                  |
| D7  | Providers        | everything pi-ai has, incl. codex-sub; no delegated engine   |
| D8  | Extensions       | tiered: manifest+skills default, typed-tool escape hatch     |
| D9  | Automations      | frontmatter files, fresh session/run, wake-gates, broadcast  |
| D10 | No heartbeat     | automations wake the agent; nothing polls on a timer         |
| D11 | North star       | open-source ambition; repo private until explicitly changed  |
| D12 | v1 client        | rich TUI (pi-tui) + CLI                                      |
| D13 | Repo layout      | 4-package Bun workspace + curated extensions/                |
| D14 | License/posture  | Apache-2.0, repo private until directed, binaries at v1      |
| D15 | Effect version   | `effect@4.0.0-beta.99`, pinned submodule                     |
| D16 | Per-turn context | stable prefix / volatile suffix, ~1-3k fixed overhead        |
| D17 | Build order      | S0-S7, v1 release line after S6                              |
| D18 | World semantics  | semantic storage; atomic Memory batches; torn logs fail loud |

---

## D1 — Clean-slate spec, merlin as evidence only

**Context:** The user has a prior project, merlin, exploring the same vision (docs/adr, plans,
telegram/memory bugs already hit in production).
**Options:** (a) fork/extend merlin, (b) start clean and treat merlin as a lessons-learned corpus.
**Decision:** (b). Ziggy imports zero code and zero design documents from merlin. Merlin's ADRs,
plans, incident reports, and Extension implementations are read as evidence of capabilities and
failure modes, never as a spec. In S4, a Merlin Extension **port** means reimplementing an accepted
user-facing capability from scratch through the smallest existing Ziggy mechanism: an Extension
containing Skills and/or Tools, a Blueprint, an Automation, or a Gateway. Ziggy's contracts,
directory layout, trust tiers, state authority,
and lifecycle always define the target. Reference material, scripts, and assets are reviewed and
re-authored under a manifest-declared Ziggy Skill root; they are not copied merely because Merlin
bundled them. No Merlin compatibility layer, manifest dialect, runtime hook, or source layout is
preserved, and a candidate that does not fit is deferred, merged, or
dropped rather than widening Ziggy around it.
**Rationale:** merlin's own docs show unresolved architectural debt (dual-write memory, coupled
session/memory-scope keys causing the Telegram bug). Starting clean lets those lessons become
invariants (see CONSTITUTION.md) instead of being inherited as code.
**Evidence:** `docs/research/merlin-evidence.md`.

## D2 — Runtime: Bun single-file executable

**Context:** North star requires "drop an exe in a folder" distribution with no separate install
step.
**Options:** Node + pkg/nexe, Deno compile, Bun compile.
**Decision:** Bun, using `bun build --compile`. Do **not** combine with `--minify` (known crash,
effect-smol#2126, when paired with Effect v4 beta).
**Rationale:** Empirically verified (codex sol-low experiment) that Bun-compiled binaries can
dynamically `import()` on-disk `.ts`/`.js` plugin files at runtime — with nested relative imports,
`node:` builtins, adjacent `node_modules` resolution, and `new Worker(pathOnDisk)` all working,
with or without `--bytecode`. This is what makes the D8 extension escape hatch technically viable
inside a compiled binary rather than just in dev mode.
**Evidence:** `docs/research/bun-compiled-plugin-loading.md`.

## D3 — Memory: file-based, hard caps, reject-at-cap

**Context:** Need durable, cache-friendly, human-readable memory that doesn't silently grow
unbounded or get compacted away without the user knowing.
**Options:** vector-store consolidation ("dreaming", openclaw's approach), unbounded append,
hard-capped files with rejection on overflow (hermes's approach).
**Decision:** File-based: `MEMORY.md` and `USER.md` exist from S1; person-scoped
`memory/people/<id>.md` files arrive at the S6 Gateway stage and are part of v1. A single
`add/replace/remove` tool. Hard character caps enforced by **rejection at write time**, not silent
truncation. The files are loaded once at Session start as a **frozen snapshot**
into the stable/cacheable prefix of the prompt — disk writes happen immediately, but the in-flight
session's prompt string does not change mid-session.
**Rationale:** Rejection forces the agent (or user) to consciously prune, rather than silently
losing older memories to truncation or an opaque consolidation job. Frozen-snapshot-per-session is
the key prompt-cache-friendliness trick borrowed from hermes: mutating memory mid-session would
bust the cached prefix on every write.
**Evidence:** `docs/research/openclaw-hermes.md`, `docs/research/per-turn-context-and-memory.md`.
**S1 contract amendment:** `MEMORY.md` is capped at 2,200 Unicode code points and `USER.md`
at 1,375. The tool operates on Hermes-style delimited entries and rejects delimiter injection.
The frozen snapshot is persisted in the canonical `session-started` event so a resumed Session
keeps the exact stable prompt it started with after process restart. S1 exposes no mid-Session
snapshot invalidation path; a new Session is the refresh boundary.

## D4 — Resident-first: one daemon per profile

**Context:** User wants to reach the assistant from anywhere (TUI/GUI/gateways) with steer,
follow-up, background, and queue semantics — not a stateless CLI that reinitializes per call.
**Options:** stateless CLI re-invoked per interaction, single global multi-profile daemon, one
resident daemon per profile folder.
**Decision:** One resident daemon per Profile. The daemon is the sole process writer for
machine-owned state; owner-authored moldable files remain directly editable and are reloaded by
the daemon. The daemon owns a Unix socket under `.runtime/` inside the Profile; there is no global
cross-Profile registry or router in v1.
**Rationale:** A profile folder is the unit of identity and durability (see D13, CONSTITUTION.md
invariant 1). Making the daemon own exactly one profile keeps the write-authority story simple:
no cross-profile locking, no shared mutable state between unrelated assistants.
**Evidence:** grilling Q2/Q3 (session decisions), `docs/research/eve.md` (world/session shape).

## D5 — Attach protocol modeled on codex app-server

**Context:** Multiple concurrent clients (TUI, GUI, gateways) need to attach to a running session,
send steer/interrupt, and receive a live event stream — including reattaching after a disconnect
without killing in-flight work.
**Options:** design from scratch, adopt JSON-RPC 2.0 wire format, model on OpenAI Codex's
`app-server` (custom NDJSON framing + handshake).
**Decision:** Model the protocol on codex app-server's shape: NDJSON framing (not JSON-RPC 2.0),
an `initialize` handshake followed by the methods `session/start`, `session/resume`,
`session/list`, `session/subscribe`, `session/unsubscribe`, `turn/start`, `turn/steer`,
`turn/interrupt`, and `approval/resolve` (`turn/steer` takes an `expectedTurnId`
optimistic-concurrency precondition), event envelopes carrying sequence number + timestamp for
replay, per-Session multi-connection
subscription sets (fan-out to every attached client), **disconnect ≠ kill** (the turn keeps
running headless), and approvals that fan out to all subscribers with first-response-wins plus a
`resolved` broadcast to the rest. Transport v1 is a unix domain socket; gateways are the remote-reach
layer on top of it, not a competing transport.
**Rationale:** This is the one piece of the whole design that had a working, battle-tested
reference implementation to study directly (Rust source, not just docs). It independently solves
exactly the reconnect/fan-out/approval problems ziggy needs.
**Evidence:** `docs/research/codex-app-server.md`.
**Important nuance:** this is a **design model for ziggy's own protocol**, not a provider
integration. See D7 — pi-ai already covers Codex-subscription auth as a normal wire provider, so
ziggy does not run or supervise an actual codex app-server process. See CONSTITUTION.md invariant 4.
**S1 contract amendment:** Every event carries its `sessionId`, preserving the fixed four-field
canonical envelope while allowing one connection to demultiplex multiple Sessions without a
wire-only wrapper. Calling `turn/start` while a Turn is active queues a one-at-a-time follow-up and
returns `disposition: "queued"`; no separate `turn/follow-up` method is added. Approval decisions
are the closed v1 union `"approve" | "deny"`.

**S3 contract amendment:** Attach protocol v2 adds idempotent `session/ensure` with the literal
`sessionId: "main"` and advertises `stableMainSession` during initialization. The daemon lazily
materializes `sessions/main.ndjson` on the first ensure; `ziggy init`, daemon startup,
`session/list`, and `session/resume` never create it. Attach v1 frames fail with
`version-mismatch`; canonical Session NDJSON remains schema version 1. `session/list` remains a
pure query over all persisted Sessions, and Session pinning is deferred without adding pin state or
pin/unpin methods.

## D6 — Loop ownership: ziggy owns the loop, pi-ai is per-call only

**Context:** Need to decide whether the agentic loop (tool-call orchestration, steer/follow-up
mailbox, context assembly) is ziggy's own code or delegated to an existing library/process.
**Options:** delegate the full loop to pi-agent-core, delegate to a codex-app-server subprocess,
own the loop natively and use a provider library only for the wire-level model call.
**Decision:** Own the loop. `pi-ai` (`@earendil-works/pi-ai`) is used strictly for its
`streamSimple(model, context, options)` per-model-call surface — it is not an agent loop and is
not asked to be one. Ziggy's own Effect-based loop implements steer/follow-up mailboxes,
tool-call hooks, and parallel tool execution — shaped like pi-agent-core's `AgentEvent`
discriminated union, but implemented natively rather than imported.
**Rationale:** pi-ai's per-API `stream`/`streamSimple` modules are lazily loaded (`api/*.lazy.ts`)
so a Bun-compile only bundles the providers actually imported; it exposes `Model<Api>` as plain
data, first-class `baseUrl` override (covers OpenAI-compatible endpoints for free), and
`cacheRetention`/`sessionId` prompt-cache controls ziggy needs anyway for D3's frozen snapshot.
Pin the exact version — pre-1.0, fast churn (~30 releases / 10 weeks observed).
**Evidence:** `docs/research/pi-ai-provider-layer.md`, `docs/research/pi-mono.md`.

## D7 — Providers v1: everything pi-ai has, no delegated engine

**Context:** Original design called for a special-cased "codex app-server as a delegated engine"
when the user authenticates via ChatGPT Plus/Pro subscription rather than an API key, requiring
dual-loop mediation and approval-bridging.
**Options:** build the delegated-engine subsystem, or check whether pi-ai already covers
Codex-subscription auth as an ordinary wire provider.
**Decision:** No delegated engine. `pi-ai`'s `openai-codex-responses` wire module already
implements ChatGPT Plus/Pro OAuth and talks to the Codex backend as a normal per-call provider,
same shape as any other `Model<Api>`. Provider surface for v1 = the full set pi-ai supports
(Anthropic, OpenAI completions/responses, OpenAI-compatible via `baseUrl`, Codex subscription,
Google, Bedrock, etc.) with no ziggy-side special casing.
**Rationale:** This was discovered mid-session by grepping pi-ai's source directly rather than
assuming; it deleted an entire planned subsystem (dual-loop mediation, approval bridging for a
supervised codex-app-server child process) with no functional loss.
**Evidence:** `docs/research/pi-ai-provider-layer.md`. The codex-app-server research (D5) is _not_
wasted — it's repurposed as ziggy's own attach-protocol model instead of a provider integration.

## D8 — Extensions: tiered, manifest-first with a typed escape hatch

**Context:** Need a way for users/agents to add capability (tools + skills, optionally pinned to a
specific provider/model/thinking level) without turning ziggy into a plugin-registry sprawl or
requiring every extension author to write TypeScript.
**Options considered:** pure markdown/skills only (no code), pure in-process plugin API (pi-style),
subprocess-only tools (hermes-style), a tiered model combining markdown-first with a narrow code
escape hatch.
**Decision:** Three explicit capability tiers. `skills[]` is declarative content with no execution.
Manifest-v2 `commands[]` exposes daemon-supervised subprocesses as Session Tools, with a fixed argv
prefix, closed argument mode, explicit `extension | profile` cwd policy, bounded total argv and
timeout, and no shell or interpolation. Approved executable bytes run from a private daemon-owned
snapshot so a final path mutation cannot change what is spawned. `tools[]` remains the single
in-process `defineTool` ABI, loaded via Bun's
runtime dynamic `import()` (proven viable by D2). Both executable tiers require install-time user
approval; Command approval binds the fixed argv prefix and disclosed dynamic-argument policy, not
arbitrary future argv. Setup/doctor entries remain structured argv, never shell strings, and receive
separate approval before spawn. Manifest v1 remains byte-contract compatible and cannot declare
Commands; manifest v2 requires an explicit `commands` array and writes approval schema v2, with no
automatic migration between versions. Installed trees are digest-sealed and revalidated at every
Skill load, Tool import, or subprocess execution; a version or content change requires reinstall
and reapproval. Extensions get **no** loop hooks, no custom providers, no ability to register their
own extensions — those
stay core-only. No Merlin candidate, including `executor`, is preselected to ship: each goes through
the same closed migration-ledger disposition and independent review. Long-tail integrations that
don't justify a maintained adapter use flue-style markdown "blueprints" the agent applies as an
edit script.
**Rationale:** This is a deliberate departure from `docs/research/extension-mechanisms.md`
Section C, which recommends subprocess-only execution. Ziggy's single-user trust posture, the
install-time approval gate, empirical Bun dynamic-import viability, and pi's production precedent
justify one narrow in-process ABI. The boundary stays explicit and small, while markdown-first
means most Extensions never need code at all. The 47 Merlin Extension packages are migration
candidates, not architectural inputs: each receives a closed-world capability and leanness review,
and only accepted behavior is rebuilt against this boundary.
**Evidence:** `docs/research/extension-mechanisms.md` (full comparison across pi/openclaw/hermes/
flue/eve), `docs/research/bun-compiled-plugin-loading.md` (what made the escape hatch technically
sound rather than merely theoretical).

## D9 — Automations: files, fresh session per run, wake-gates, broadcast rules

**Context:** Need scheduled/webhook-triggered work (crons, reminders, background jobs) that can
pin its own provider/model/thinking/skills/prompt independently of the main chat session, and that
doesn't waste tokens running checks that find nothing to do.
**Options:** continuing/resumed session per automation run, fresh session per run with state
passed through Memory; poll-and-check-inside-the-agent vs. a cheap pre-check gate outside the
agent entirely.
**Decision:** Automations are files in the profile folder with frontmatter (schedule/webhook
trigger, wake-gate command, pinned provider/model/thinking/skills/prompt, broadcast rules for
where results get delivered). Each run gets a **fresh session** — no continuing session state.
Anything that needs to persist across runs goes through Memory explicitly. A **wake-gate**
(hermes's `cron/scheduler.py` model) runs before the agent/prompt is constructed at all; only an
explicit `{"wakeAgent": false}` skips the run, making a no-op check genuinely $0, not just
suppressed output.
**Rationale:** Fresh-session-per-run keeps automations from silently accumulating unbounded
context over months of daily runs, and forces cross-run state to go through the one place it's
supposed to live (Memory), keeping there being no second durable-state authority.
**Amendment — webhook ingress:** v1 webhook ingress is a daemon-owned HTTP listener bound only to
`127.0.0.1`. It starts only when at least one enabled Automation has a webhook trigger. Each hook
uses `/hooks/<name>` with its own token authentication. Remote exposure is explicitly the owner's
own tunnel or reverse proxy, never a daemon-owned public listener.
**Evidence:** `docs/research/per-turn-context-and-memory.md` (wake-gate mechanism, exact source
lines), `docs/research/openclaw-hermes.md`.

## D10 — No LLM heartbeat

**Context:** Always-on heartbeat loops (openclaw-style) burn tokens/logic on every tick even when
nothing needs doing.
**Options:** always-on heartbeat with an internal emptiness check, no heartbeat at all with
automations as the sole trigger source.
**Decision:** No heartbeat. Automations (D9) are the only thing that wakes the agent; there is no
process that periodically constructs a prompt "just to check."
**Rationale:** Directly stated by the user as a hard requirement ("i dont want heartbeat... ziggy
is going to ensure no token waste"), and is the difference between openclaw's heartbeat
(still burns some tokens/logic before deciding to skip) and hermes's wake-gate (skips before any
agent construction).
**Evidence:** `docs/research/openclaw-hermes.md`, `docs/research/per-turn-context-and-memory.md`.

## D11 — North star: open-source product, day one

**Context:** Distribution/positioning question — internal tool vs. public product from the start.
**Decision:** Ziggy is built as an open-source product from S0, not an internal tool later
open-sourced.
**Rationale:** User's explicit choice (grilling Q1, "Open-source product day one").
**Evidence:** see NORTH-STAR.md.

**Amendment (2026-07-19; later user directive):** The product ambition remains, but repository
visibility does not: Ziggy remains private until the user explicitly says to make it public. This
supersedes the public-from-S0 and public-from-first-commit parts of D11.

**Operational amendment (2026-07-20):** Hosted CI is disabled while the repository remains
private. Local `verify:sN` and `verify:all` runs remain the hard correctness gates. CI is restored
only when the user explicitly chooses the later publication point.

## D12 — v1 client surface: rich TUI + CLI

**Context:** What ships as the primary v1 human-facing surface, given gateways/GUI are later
stages.
**Options:** thin CLI only with a later TUI, rich TUI (pi-tui-based) in v1 alongside CLI one-shot
commands.
**Decision:** Rich TUI in v1, built on `@earendil-works/pi-tui` (differential-rendering, agent-
agnostic), plus simple CLI one-shot commands. GUI is explicitly a later stage (S7).
**Rationale:** User's explicit choice (grilling Q10). pi-tui exists and is agent-agnostic, so
reuse rather than rebuild.
**Evidence:** `docs/research/pi-mono.md`.

**S3 contract amendment:** `ziggy ask` streams only its accepted Turn's model text to stdout and
ends success with exactly one newline. Exit codes are `0` success, `1` known runtime failure, `2`
usage, `3` outcome unknown, and `130` local interruption. Setup may retry once only before any
`turn/start` write; after a write without a correlated response, the Client never resends. After
correlated acceptance it may reconnect and replay from the last fully applied sequence without
resending. The TUI is steer-first: active-Turn Enter steers, Alt+Enter or F2 selects a queued
follow-up, Ctrl+X interrupts explicitly, Ctrl+P opens the Session picker, Escape dismisses overlays,
and Ctrl+C or quit detaches without interrupting daemon work. Reconnect uses the existing
`replayThroughSeq` watermark; no replay-complete frame or durable operation identity is added in S3.

## D13 — Repo layout: 4-package workspace + curated extensions

**Context:** How to split the codebase so packages have clean dependency direction and clients
(TUI, gateways) can stay dependency-free per D5/D8.
**Decision:** At S0, a Bun workspace with 4 packages — `core` (daemon, session engine, memory, loop),
`protocol` (attach-protocol types + framing, dependency-free), `tui` (pi-tui-based client), `ziggy`
(the CLI entrypoint / compiled binary) — plus a curated `extensions/` directory for maintained
first-party Extensions selected through the Extension review process. First-party Gateways join
later, at their stages, as additional leaf workspace packages such as
`packages/gateway-telegram`; each depends only on `protocol`.
**Rationale:** User's explicit choice (grilling Q11, "4 packages + pi-tui"). Keeps `protocol` as
the hub other packages/gateways depend on without pulling in `core`'s implementation weight —
mirrors flue's proof that channel/client packages can have zero runtime dependency on the engine.
**Evidence:** `docs/research/flue.md` (hub-and-spoke dependency direction, exports-subpath
discipline).

## D14 — License and release posture

**Context:** Legal/distribution posture for a public repo containing an in-progress design.
**Decision:** Apache-2.0. "Source-available first" interpreted concretely as: public repo starting
at S0, but compiled binary releases withheld until the v1 line (after S6) — not an actual
non-compete or source-available license variant.
**Rationale:** User's explicit choices (grilling Q12 "Source-available first", Q12b "Apache-2.0").
Avoids the ambiguity of an actual SSPL/BUSL-style license while still not shipping unpolished
binaries early.
**Evidence:** grilling Q12/Q12b.

**Amendment (2026-07-19; later user directive):** Ziggy remains private until the user explicitly
says to make it public. This supersedes the public-repository timing above without changing the
Apache-2.0 license choice. Compiled binary releases remain deferred to v1 after S6 unless separately
changed.

## D15 — Effect v4 beta, pinned submodule

**Context:** Need a concurrency/effect-system foundation for the daemon loop, session engine, and
platform adapters (local now, Cloudflare later).
**Options:** Effect v3 (stable, `latest` dist-tag), Effect v4 beta (`beta` dist-tag, schema/platform
merged into core), hand-rolled alternative.
**Decision:** `effect@4.0.0-beta.99`, vendored as a pinned git submodule at
`vendor/effect` (tag `effect@4.0.0-beta.99`, commit `6184a7dc53cb9310e299b65ad6d6c712c2cbf202`) so
agents can check real source/docs (`ai-docs/src/`, `migration/`, `packages/effect/src/`,
`packages/platform-bun/src/`) rather than hallucinating v3-era APIs. A docs-check rule in S0
enforces consulting the submodule before writing Effect code.
**Rationale:** v4 merges schema/platform into core `effect` and ships native Bun adapters
(`BunRuntime`, `BunHttpServer`, `BunSocket`, `BunFileSystem`, `BunChildProcessSpawner`) that
directly serve the daemon/socket/child-process needs of D4/D5/D8. It's a beta, not stable semver —
pinning exactly (not `^`/`~`) is required given fast churn. Known caveat: don't combine
`bun build --compile --minify` (crash, effect-smol#2126) — see D2.
**Evidence:** `docs/research/effect-v4-status.md`.

## D16 — Per-turn context: stable prefix / volatile suffix

**Context:** Fixed per-turn overhead in reference systems is dominated by uncapped tool-schema
JSON (4-20k tokens observed in hermes/openclaw); need a concrete design to keep ziggy's fixed
overhead minimal and prompt-cache-friendly.
**Decision:** Split every prompt into a **stable prefix** (tool schemas from a deliberately small
static toolset, plus the frozen-per-session SOUL.md/MEMORY.md/USER.md snapshot from D3, with only
date-only — not time-of-day — freshness markers) and a **volatile suffix** (conversation history,
compaction). Target fixed overhead: ~1-3k tokens, versus the 4-20k observed elsewhere. The main
lever is toolset size, not clever caching alone.
**Rationale:** Directly mirrors hermes's three-tier system prompt (`agent/system_prompt.py`,
`agent/prompt_builder.py`) and openclaw's `CONTEXT_FILE_ORDER` + `SYSTEM_PROMPT_CACHE_BOUNDARY`
pattern, adapted to ziggy's smaller toolset goal.
**Evidence:** `docs/research/per-turn-context-and-memory.md` (exact file/line references).

## D17 — Build order: S0-S7, v1 after S6

**Context:** Need a stage order an AI agent can execute hand-in-hand with the user, with a clear
point where a v1 binary release happens.
**Decision:** Eight stages — S0 Foundation, S1 Waist (session engine + memory), S2 Daemon
(resident service + socket + fan-out), S3 Face (init + TUI + CLI), S4 Molding (extensions +
blueprints), S5 Autonomy (automations + observability), S6 Reach (Telegram gateway — first leaf
client, proves the dependency-free-client pattern), S7 Elsewhere (Cloudflare world adapter, GUI,
more gateways). **v1 binary release ships after S6**, not after S7.
**Rationale:** User's explicit choice (grilling Q13, "v1 after S6 (Recommended)") — a useful,
reachable-from-anywhere assistant exists once one real gateway proves the client pattern; the
Cloudflare world adapter and additional gateways/GUI are additive, not blocking.
**Evidence:** see `ROADMAP.md` and `plans/s0-foundation.md` through `plans/s7-elsewhere.md`.

## D18 — Semantic World contract and failure semantics

**Context:** S0 needs a contract harness that can prove local and later remote implementations preserve Ziggy's authorities without freezing a generic filesystem API or weakening crash behavior.
**Decision:** The World storage seam is semantic: Session-log operations and Memory-document operations, never generic byte paths or revisioned transactions. A batch replacing multiple Memory documents is crash-safe atomic: after failure and recovery, readers observe either every old document or every new document, never a mixed set. An implementation may use a private journal/staging protocol, but that machine-owned structured state is version-stamped. A partial or torn final Session NDJSON line fails loud; Ziggy never automatically ignores, truncates, or repairs it. Repair may be added only as an explicit owner command.
**Rationale:** Semantic operations preserve Session and Memory authority across filesystem and remote implementations. Atomic batches prevent contradictory retained facts after a crash. Failing loud on torn append-only evidence avoids silently rewriting the Session authority.
**Evidence:** S0 semantic World contract harness and user-locked build decisions, 2026-07-19.
