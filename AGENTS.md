# AGENTS.md

Read this before writing any code in this repo.

## What ziggy is

Ziggy is a personal-agent runtime: a single Bun-compiled executable that, dropped into a
folder, turns that folder into a Profile — a SOUL.md, a Memory, a set of Extensions, and a
resident runtime — reachable from any Client (CLI, TUI, GUI, Gateway) at any time, doing
nothing and costing nothing until it has real work to do. The folder is the durable Profile;
agent refers to the loop behavior that acts within it. The core is deliberately small.
Everything durable is a file. See `docs/NORTH-STAR.md` for the vision and
`docs/CONSTITUTION.md` for the invariants this codebase is not allowed to violate.

## Vocabulary contract

Naming drift is a bug. Use these words and only these words for these concepts, in code,
comments, commits, and docs.

**The seven primitives**

- **Profile** — a folder on disk that is the whole identity of one ziggy: config, SOUL.md,
  voices, sessions, memory, extensions, automations, runtime socket. Path is identity.
- **Session** — one durable conversation: an append-only transcript plus its live turn state.
  The main session, pinned sessions, and automation-run sessions are all Sessions.
- **Memory** — the retained-facts store, distinct from and outliving any single Session's
  transcript. `MEMORY.md` and `USER.md` exist from S1; person-scoped `memory/people/` files
  arrive at S6 and are part of v1.
- **Provider** — a wire adapter for one model backend (Anthropic, OpenAI, OpenAI-compatible,
  Codex subscription, etc.), supplied via pi-ai. A Provider makes single model calls; it never
  owns a loop.
- **Extension** — an installable unit adding Skills and/or Tools to a Profile, authored by
  default as manifest + SKILL.md, optionally with a small in-process `defineTool` escape hatch.
- **Gateway** — a dependency-free leaf client speaking only the attach protocol, bridging ziggy
  to an outside surface (Telegram, Signal, Discord, ...).
- **Automation** — a file with frontmatter that triggers a fresh Session run on a schedule or
  webhook, gated by a wake-gate, pinned to its own provider/model/skills/prompt.

**Supporting nouns**

- **Turn** — one user-message-in, agent-response-out cycle within a Session.
- **Step** — one unit of work inside a Turn (a model call, a tool call).
- **Run** — one execution of an Automation, always a fresh Session.
- **Client** — anything that attaches to the daemon over the attach protocol and renders state.
  Clients never mutate; they only attach, subscribe, and send input.
- **Voice** — a starter `SOUL.md` template offered by `ziggy init`. Per-Session persona pinning
  is not a v1 concept.
- **Wake-gate** — a cheap pre-check (often $0, no LLM call) an Automation runs before deciding
  whether its trigger firing actually warrants doing anything.
- **Broadcast** — the rule set on an Automation or Gateway describing where a Run's output gets
  delivered.

If you need a new noun, check this list first. If it overlaps an existing one, reuse the
existing one — do not invent a synonym.

## Engineering rules

- **Runtime**: Bun. Build the distributable with `bun build --compile`. Never combine
  `--compile` with `--minify` (Bun minifier crash on `Stream.mkUint8Array`,
  effect-smol#2126 — confirmed in `docs/research/effect-v4-status.md`). Use `--bytecode` freely;
  it's orthogonal and safe.
- **Effect**: pinned exact to `effect@4.0.0-beta.99` and `@effect/platform-bun@4.0.0-beta.99`.
  Do not add `@effect/platform` or `@effect/schema` — those are v3-only legacy packages and will
  silently conflict. Before writing any non-trivial Effect code, consult the submoduled
  `vendor/effect` at that exact tag: `vendor/effect/ai-docs/src/` for narrative patterns and
  `vendor/effect/migration/` for what changed from v3 (services, forking, schema, scheduling).
  When in doubt, grep `vendor/effect/packages/effect/src/` — it is the authoritative source.
- **TypeScript**: strict. No `any`. No `!` non-null assertion. No `as` type assertion (use
  proper narrowing, Schema decode, or a typed constructor). If you think you need one of these,
  the type is wrong — fix the type.
- **Lint/format**: oxlint + oxfmt, enforced in CI. Run them before considering anything done.
  `knip` catches dead exports/deps — keep it clean, it's how we keep the core small.
- **Recurring issues**: when implementation repeatedly encounters and fixes the same issue class,
  call out the pattern and propose an enforceable lint rule or check. Do not add it until the user
  explicitly approves the proposal.
- **Dependencies**: `pi-ai` and `pi-tui` (`@earendil-works/*`) are pinned exact, never range-
  pinned — they are core waist dependencies, not incidental libraries. Any new dependency needs
  a reason stronger than convenience.
- **Storage/world interfaces**: every interface that touches disk or an external boundary
  (Session store, Memory store, Provider wire calls, attach-protocol transport) gets a contract
  test that any implementation must pass, not just unit tests against the one implementation
  you wrote.
- **Schema evolution**: machine-owned structured files carry an explicit schema-version stamp,
  including Session NDJSON, `ziggy.jsonc`, `extension.json`, Gateway resume maps, and credential
  files. Human-owned markdown is exempt, except Automation files, whose frontmatter carries a
  `version` field. On mismatch, fail loud and refuse to proceed — do not write a migration
  framework. Migrations, when needed, are one-off scripts invoked deliberately, not automatic
  runtime upgrades.
- **Tests**: non-trivial logic changes ship with tests. A failing test that exposes a real bug
  is acceptable to land — fix the bug, not the test.
- **State discipline**: before adding a new persisted field or file, check
  `docs/CONSTITUTION.md` — if it's not Session transcript or Memory, it probably shouldn't be
  durable, and it definitely shouldn't be a second writable authority for something that
  already has one.

## Where things are

- `docs/NORTH-STAR.md` — the vision, the shape, what ziggy is not.
- `docs/CONSTITUTION.md` — the numbered invariants and why each one exists.
- `docs/ROADMAP.md` — the S0–S7 build ladder and the v1 release line.
- `docs/plans/` — one build plan per stage, scope + definition-of-done + links, for agents
  picking up a stage of work.
- `docs/research/` — primary-source research this design is built on (pi-mono, openclaw,
  hermes-agent, flue, eve, codex app-server, Bun compiled-plugin loading, Effect v4 status).
  Every non-obvious architectural choice should be traceable to something in here.
- `docs/DECISIONS.md` — the full decision log: every locked decision from the design
  grilling session, in order, with rationale.
