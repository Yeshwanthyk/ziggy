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
  The stable main Session, additional user-created Sessions, and Automation-run Sessions are all
  Sessions. Session pinning is not currently a defined capability.
- **Memory** — the retained-facts store, distinct from and outliving any single Session's
  transcript. `MEMORY.md` and `USER.md` exist from S1; person-scoped `memory/people/` files
  arrive at S6 and are part of v1.
- **Provider** — a wire adapter for one model backend (Anthropic, OpenAI, OpenAI-compatible,
  Codex subscription, etc.), supplied via pi-ai. A Provider makes single model calls; it never
  owns a loop.
- **Extension** — an installable unit adding Skills, declarative Commands, and/or Tools to a
  Profile, authored by default as manifest + SKILL.md, optionally with a supervised subprocess
  Command or small in-process `defineTool` escape hatch.
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
- **Command** — a manifest-declared Session Tool backed by a daemon-supervised subprocess with a
  bounded fixed argv prefix, closed argument mode, cwd policy, and timeout. Approved bytes execute
  from a private daemon-owned snapshot. It is neither a shell command nor in-process Extension code.

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
- **Effect ownership**: keep total, deterministic computation as plain synchronous TypeScript.
  Anything that can fail, perform I/O, observe time, own mutable runtime state, run concurrently,
  be interrupted, or acquire a resource is an Effect. Production orchestration must not expose or
  compose native `Promise`s, `async` functions, manual cleanup stacks, or detached background work.
- **Effect boundaries**: host and vendor callbacks may use Promise or callback APIs only inside a
  small, named adapter that immediately wraps them with `Effect.tryPromise`, `Effect.callback`, or an
  appropriate platform service. Run Effects once at the executable edge with
  `BunRuntime.runMain`; tests cross the boundary only through `tests/testkit/effect.ts`. Do not call
  `Effect.runPromise`, `Effect.runSync`, or `Effect.runFork` in library or application modules.
- **Effect architecture**: model fallible domain errors with `Schema.TaggedErrorClass`, define
  capabilities with `Context.Service`, construct them with explicit `Layer.effect`, and acquire
  resources with `Effect.acquireRelease` or `Effect.acquireUseRelease`. Use structured fibers
  (`Effect.forkScoped`, `FiberSet`) so interruption and shutdown have one owner. Never use
  `Effect.orDie`, `Effect.ignore`, `Effect.ignoreCause`, or defects to erase a recoverable domain
  failure. `Effect.exit` and `Effect.either` are only for code that deliberately inspects every
  failure case, such as aggregating independent finalizer failures; they are not error suppression.
- **Effect remediation**: the repo-local skills under `.agents/skills/` are the required playbooks
  for typed errors, Schema boundaries, runtime boundaries, client wrappers, tests, and TypeScript
  safety. When a lint rule identifies an Effect problem, use the matching skill to fix the design;
  do not suppress the rule or route around it.
- **TypeScript**: strict. No `any`. No `!` non-null assertion. No `as` type assertion (use
  proper narrowing, Schema decode, or a typed constructor). If you think you need one of these,
  the type is wrong — fix the type.
- **Lint/format**: oxlint + oxfmt, enforced in CI. Run `bun run check` before considering anything
  done. It must cover formatting, repo-local skill validation, blocking Effect lint, Effect lint
  fixtures, Effect-aware TypeScript, tests, `knip`, package boundaries, and compiled-executable
  smoke. `knip` catches dead exports/deps — keep it clean, it's how we keep the core small.
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
