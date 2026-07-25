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

**Scaffold shipped** (codex sol). `package.json` (exact pins), `tsconfig.json` (strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess), `src/main.ts` usage stub, `.gitignore`. Gotchas found at install: `@effect/tsgo` ships an `effect-tsgo` patcher CLI, not a `tsgo` bin — typescript@7.0.2 itself provides native `tsc`; script is `tsc --noEmit` and `effect-tsgo patch` layers Effect LS diagnostics onto the binary (re-run after fresh installs). Bun blocked protobufjs/@google/genai lifecycle scripts (transitive from Pi's gemini provider) — harmless. typecheck/lint/fmt all green.

**Scout reports landed** (codex luna). `docs/research/pi-sdk-surface.md`: exact embed signatures; corrections vs the brief — `sessionManager` goes to `createAgentSessionFromServices` (not the services factory); prompt/steer/abort/subscribe live on `runtime.session`; `initTheme()` is mandatory before `InteractiveMode`; clean profile scoping = `no*` flags + `additionalSkillPaths`/`additionalExtensionPaths`; `extensionFactories` is the inline-tool hook for Memory. `docs/research/starman-reuse.md`: adapt-worthy — raw Effect-Schema Telegram client (long-poll, no SDK dep), owner-link binding (1:1→primary memory, group→conversation memory), memory caps/reject-on-overflow, automation frontmatter format, three SOUL starter voices.

**Primitive 1: Profile — shipped** (codex sol, two blocks). `ziggy init <name|path>` (names → `$ZIGGY_HOME/profiles/<name>`, default `~/.ziggy`; paths anywhere; exclusive-create SOUL.md, never clobbers, idempotent) and `ziggy profiles`. Per hsey's steer: a profile is just a dir with SOUL.md — added `$ZIGGY_HOME/profiles.list` registry (machine-owned, one abs path per line; init appends, list unions registry + default dir, prunes stale entries). Proof ran: double init byte-identical; buddy-at-arbitrary-path listed; stale entry pruned.

**Tooling aligned with starman** (minus its custom-lint bureaucracy, per spec). `vendor/effect` git submodule pinned at `6184a7dc` (= 4.0.0-beta.99, same as starman). Stock `.oxlintrc.json` / `.oxfmtrc.json` (printWidth 100). Three adapted skills in `.agents/skills/`: effect-runtime-boundaries (rewritten: Effect throughout the app architecture, BunRuntime.runMain sole edge), effect-schema-boundaries, effect-typed-errors. `AGENTS.md` contract + `CLAUDE.md` symlink; rule recorded: when in doubt, read vendor/effect and align. Note: codex sandbox can't create `.agents/` or run git/network — skills staged in a visible dir and moved into place; submodule added by orchestrator.

**Primitive 2: Provider — in flight** (codex sol). `ziggy run <profile> <prompt>`: one non-persistent no-tools prompt via `SessionManager.inMemory`, profile-local auth/models, `runPrintMode` streaming; typed ProfileNotInitialized/ProviderConfig/ProviderCall errors. Live-model e2e will run from the orchestrator (codex has no network); no env API keys present locally — e2e will copy a credential from global `~/.pi/agent/auth.json` into a dump-dir profile to prove profile-local auth.
