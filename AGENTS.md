# What ziggy is

Ziggy is a folder that is an assistant: one Bun/TypeScript runtime wrapping the published
`@earendil-works/pi-coding-agent@0.82.0`. Pi owns the agent loop, providers, sessions, and TUI;
Ziggy owns Profile policy and composition.

# Architecture

Dependencies point inward: faces -> application -> domain.

- Faces translate CLI or UI input into application calls.
- Application services orchestrate Effect-native capabilities and domain values.
- Domain code owns Profile concepts, invariants, and typed failures.
- Core runtime code may import Pi packages only under `src/adapters/pi/`.
- Repository-owned `extensions/*` are isolated Pi packages and may import Pi at their entrypoints.
- Only entrypoints execute Effects. `BunRuntime.runMain` in `src/main.ts` is the only production
  execution edge.

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
- Never overwrite human-owned Profile files such as `SOUL.md`.
- Treat `docs/research/minimal-ziggy-scout.md` as the specification.
- Treat `docs/research/pi-sdk-surface.md` as the source for Pi API facts.
