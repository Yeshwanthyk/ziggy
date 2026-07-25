# Ziggy build log

Chronological; newest at the bottom. One entry per logical block of work.

## 2026-07-25

**Spec cleaned.** Rewrote `docs/research/minimal-ziggy-scout.md`: dropped evidence labels, Starman archaeology, and verification bureaucracy. Settled the open decisions:

- `init` creates `SOUL.md` only; Pi-owned files appear when Pi needs them. Profile names resolve under `~/.ziggy/profiles`, paths work anywhere.
- Memory: `MEMORY.md` assistant-wide; `memory/users/<id>.md` loaded only in 1:1s; `memory/groups/<id>.md` shared per group, the only extra memory in groups.
- First gateway channel: Telegram. All faces (TUI/CLI/gateway channels) hit the same client-neutral core; nothing client-gated.
- Extension proof is skills-first; TS extensions after.

**Pins verified on npm.** `@earendil-works/pi-coding-agent@0.82.0` (latest published), `effect@4.0.0-beta.99`, `@effect/platform-bun@4.0.0-beta.99`, `@effect/tsgo@0.21.0`, `typescript@7.0.2`, `oxlint@1.75.0`, `oxfmt@0.60.0`, `bun-types@1.3.14`. Local bun is exactly 1.3.13.

**Scouts dispatched** (codex gpt-5.6-luna high): Pi SDK embed surface → `docs/research/pi-sdk-surface.md`; Starman reuse survey → `docs/research/starman-reuse.md`.

**Operational:** e2e test profiles live under `/Users/yesh/Documents/personal/dump`. Implementation subagents: codex gpt-5.6-sol medium. Build order: scaffold → Profile → Provider → Session → Memory → Extension → Gateway+Telegram → Automation, one commit per logical block.
