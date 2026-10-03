# What ziggy is

Ziggy is a folder that is an assistant: one Bun/TypeScript runtime wrapping the published
`@earendil-works/pi-coding-agent@0.99.1`. Pi owns the agent loop, providers, sessions, and TUI;
Ziggy owns Profile policy and composition.

# Architecture

The target layout is in `docs/plans/tight-core/README.md` §4; code moves there one concept at a time.

- `src/platform/` holds shared low-level pieces with no Ziggy concepts: `file-lock.ts` (the one
  SQLite lock), `atomic-write.ts` and `paths.ts` (`ZiggyPaths`). It imports only `effect`,
  `node:*`, `bun:*` and other platform files.
- The core is `profile/`, `session/` and `extensions/`. `agents/` and `memory/` are modules built
  on it, and `resident/` and `cli/` sit on top. Dependencies point down that list; the core never
  imports agents, memory or resident.
- Code outside a concept folder imports only its `index.ts`.
- Pi packages may be imported only in `src/adapters/pi/` and the files marked `[Pi]` in §4.
  Repository-owned `extensions/*` are isolated Pi packages and may import Pi at their entrypoints.
- Until a concept moves, the old rule holds for it: faces -> application -> domain, with adapters
  at the edges.
- Only entrypoints execute Effects. `BunRuntime.runMain` in `src/main.ts` is the only production
  execution edge; the one written exception is the Pi tool-callback bridge (see
  `effect-runtime-boundaries`).

`ziggy/import-boundaries` in `tooling/oxlint` enforces the platform, folder-index and Pi rules.

# Toolchain

- `effect@4.0.0-beta.99`
- `@effect/platform-bun@4.0.0-beta.99`
- `typescript@7.0.2` native `tsc`
- `@effect/tsgo` patch for Effect Language Service diagnostics
- `oxlint@1.75.0`
- `oxfmt@0.60.0`
- Bun `1.3.13`

Use `bun run typecheck`, `bun run lint`, and `bun run fmt`.
`bun run check` — fmt + lint (incl. tooling/oxlint Effect rules) + typecheck; must pass before commit.

# Effect practices

Read the focused guidance before changing Effect code:

- `.agents/skills/effect-runtime-boundaries/SKILL.md`
- `.agents/skills/effect-schema-boundaries/SKILL.md`
- `.agents/skills/effect-typed-errors/SKILL.md`

When in doubt about Effect v4 idioms or good practices, read the pinned Effect source in vendor/effect (git submodule, 4.0.0-beta.99) and align code with what the library itself does.

# Working agreements

- Keep `LOG.md` updated per logical block.
- Commit in logical blocks.
- No tests for the sake of tests; add focused tests only for real invariants.
- Core tests live in `test/` mirroring `src/` and import Ziggy through `ziggy/...` package exports.
- Never overwrite human-owned Profile files such as `SOUL.md`.
- Treat `docs/research/minimal-ziggy-scout.md` as the specification.
- Treat `docs/research/pi-sdk-surface.md` as the source for Pi API facts.
