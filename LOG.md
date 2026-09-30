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

**Primitive 2: Provider — shipped + proven live** (codex sol). `ziggy run <profile> <prompt>`: no-tools prompt through the single Pi adapter (`src/adapters/pi/pi-agent.ts`), profile-local auth/models (agentDir = profile), SOUL.md as system prompt, `runPrintMode` streaming; typed ProfileNotInitialized/ProviderConfig/ProviderCall errors. Live proof in dump profile (`~/Documents/personal/dump/ziggy-e2e/pal`, anthropic credential copied from global pi auth into profile `auth.json`): prompt answered, exit 0. Sandbox smoke proved clean single-line error paths with no auth/network.

**Primitive 3: Session — shipped + proven live** (codex sol). Persistent JSONL sessions under `<profile>/sessions/` via `SessionManager.create`; `-c/--continue` uses Pi-native `SessionManager.continueRecent`; bare `ziggy <profile>` opens Pi `InteractiveMode` (initTheme first; tools ON — the profile folder is the agent's cwd/world; `run` stays no-tools). Live proof via tmux: TUI turn ("quokka") → exit → `ziggy run -c` answered "quokka" from the same JSONL session.

**Primitive 4: Memory — shipped + proven live** (codex sol). `MEMORY.md` (2200 cps) + `memory/users/<id>.md` / `memory/groups/<id>.md` (1375 cps, starman-proven caps); ChatContext (local→owner 1:1, user, group) decides admission — user memory never loads in groups; docs appended to system prompt; `memory_write` custom Pi tool does whole-doc atomic replace (tmp+rename), reject-on-overflow with actionable tool errors; ids come from context, never the model. `run` exposes only memory_write; TUI gets default tools + memory_write. Unit smokes: atomic create, overflow-preserves-file, group/person scope fences — all PASS. Live proof: "genmaicha" saved to `memory/users/owner.md` via the tool in one session; a fresh session recalled it from prompt context alone.

**Primitive 5: Extension — shipped + proven live** (codex sol). `additionalSkillPaths`/`additionalExtensionPaths` admit only `<profile>/skills` and `<profile>/extensions` (included only when the dirs exist); `noSkills`/`noExtensions` keep every global/project path out. Live proof in TUI: `/skill` autocomplete showed exactly `skill:haiku-mode` (the planted profile skill — none of the many global `~/.agents/skills` leaked), and invoking it produced the haiku.

**Primitive 6: Gateway + Telegram — shipped** (codex sol, high effort). `ziggy gateway <profile>`: resident long-poll loop over raw Bot API (no SDK dep; strict Effect Schemas on responses; bot token redacted from all errors). Fail-closed auth: only `ownerUserId` messages processed. private → ChatContext user:<id>, group/supergroup → group:tg<abs(chatId)> (so user memory loads in 1:1s, group memory in groups). One persistent Pi runtime per chat under `sessions/telegram/<chat-key>/` (continueRecent → gateway restarts resume each chat); per-chat serialization via semaphore; replies chunked at 4096; retriable errors (network/5xx/429) back off capped at 30s, auth errors fail clean; SIGINT/SIGTERM → scoped disposal, exit 0. Reply extraction mirrors Pi print mode (`message_end` assistant text, `agent_settled` terminal), with `bindExtensions` + rebind on session replacement. Sandbox-verified: config errors, backoff, redaction, signal exit; **live round trip needs a real bot token in `<profile>/telegram.json` — pending from hsey**.

**Primitive 7: Automation — shipped + proven live** (codex sol). `automations/<id>.md` with flat hand-parsed frontmatter (version/gate/telegram-chat; unknown keys fail closed; no YAML dep) + prompt body. `ziggy wake <profile> <id>`: gate runs via `/bin/sh -c` in the profile cwd (30s timeout, minimal env); explicit decline (nonzero exit) stops before ANY Pi construction; spawn-failure/timeout fail open with a warning. Wake gets a fresh session under `sessions/automations/<id>/`, memory-only tools; result to stdout + optional telegram broadcast (chunked, reusing gateway helper). Live proof: `gate: exit 1` → "gate declined — no model call", zero session artifacts; `gate: test -f SOUL.md` → fresh session, live one-line result.

**Analysis round** (codex sol med, per hsey). Stateful-systems audit → `docs/research/stateful-audit.md` (top findings: shared MEMORY.md is last-writer-wins with stale-snapshot lost updates; Telegram delivery is at-least-once — restart mid-batch double-replies; memory loaded once per runtime so resident gateway chats go stale; local `owner.md` vs telegram numeric id splits person identity; registry append races). Extension compat → `docs/research/extension-compat.md` (merlin/starman lossless-claw + smart-memory bundles won't load — non-Pi manifests; smart-skills doesn't exist as an implementation; headless faces' `tools: ["memory_write"]` allowlist tool-deadens all extension tools; Pi's process-global extension cache means gateway keeps stale extension code until restart). All 9 executor-derived effect/ts skills now in `.agents/skills/`. Analysis only — no core changes applied.

**Wrap.** All seven primitives shipped, each behind its walking-skeleton proof; e2e ran against `~/Documents/personal/dump/ziggy-e2e/pal` (visible-file profile tree: SOUL.md, auth.json, memory/, sessions/, skills/, automations/). Spec Surface synced with the shipped CLI. Outstanding: live Telegram round trip needs a real `botToken`/`ownerUserId` in `<profile>/telegram.json`; TUI still shows Pi branding (rebrand = later polish); gateway gives channel chats memory-only tools by design.

**Starman coverage audit** (10 codex sol sweeps: 6 over every starman package + docs, 4 over openclaw/hermes-agent references) → `docs/research/starman-coverage-audit.md`. All seven primitives covered vs starman; real gaps ranked: no auth/doctor/sessions-list CLI, no profile lease (gateway+TUI concurrent), memory LWW (every reference at least locks; hermes flock+reread-under-lock is the model), Telegram offset/claims not persisted (starman's `telegram-host.json` is the smallest port; hermes drops backlog on cold start instead), stale memory in resident handles (openclaw re-reads per turn; hermes rebuilds on staleness triggers). Extension answer: port starman's 40 bundles as plain Pi SKILL.md dirs in a catalog; install = copy into `<profile>/skills/`; steal hermes' `.bundled_manifest` (update-unchanged / preserve-modified / don't-resurrect) if a sync command ever exists; no manifest/registry/scanner. Wake-gate note: ziggy's exit-code gate is stricter than both references (they skip only on exact `{"wakeAgent": false}`); scheduler-when-due should copy hermes' advance-before-run claims + starman's trigger-tuple dedupe.

**Discord gateway vertical slice.** Added `ziggy discord <profile>` without dependencies: strict profile config, raw Discord REST calls through global `fetch`, and Gateway v10 over Bun's global `WebSocket`. The socket owns Identify/Resume, heartbeats and zombie detection, session sequencing, fatal close classification, guarded reconnects with capped backoff, and clean shutdown. The application slice admits only the configured owner, maps DMs and guild channels into valid memory contexts, preserves one serialized persistent Pi chat per channel, chunks replies at 2000 Unicode code points, and retries retriable sends. Shared `GatewayConfigError` moved to `src/domain/gateway.ts`; Telegram behavior and automations remain unchanged.

**Slack gateway vertical slice.** Added `ziggy slack <profile>` without dependencies: strict profile config, raw Slack Web API calls through global `fetch`, and Socket Mode over Bun's global `WebSocket`. The socket owns connection URL refresh, envelope acknowledgements, event deduplication, guarded reconnects with capped backoff, fatal authentication classification, and clean shutdown. The application slice validates the bot identity, admits only the configured owner, maps DMs and channels into valid memory contexts, preserves one serialized persistent Pi chat per channel, keeps threaded replies in their source thread, chunks replies at 4000 Unicode code points, and retries retriable sends. Telegram, Discord, and automations remain unchanged.

**Memory entry operations.** Replaced whole-document memory writes with all-or-nothing add/replace/remove batches over `§`-delimited entries. The Pi adapter now serializes concurrent writers with stale-lock recovery, rereads under the lock, fsyncs temporary files before rename, and strips storage delimiters from prompt rendering. Added domain semantics and real-tool concurrency/overflow coverage.

**Provider auth flow** (codex sol). `ziggy auth <profile>` prints per-provider status (configured type + source via `ModelRuntime.checkAuth`, available login kinds); `ziggy auth <profile> <provider> [--type api_key|oauth]` runs Pi's own provider login (`ModelRuntime.login`) against profile-local `auth.json` — every pi-ai provider, api-key and OAuth (`registerBunOAuthFlows` from `@earendil-works/pi-ai/bun-oauth`, module-guarded). Terminal `AuthInteraction` adapter: raw-mode no-echo secrets, numbered selects, auth-url/device-code notifications, abort-signal aware. Typed errors AuthProviderUnknown/AuthTypeUnsupported/AuthFlowFailed; default type = oauth only when api-key login is absent. Live smoke: status against the dump profile listed the full provider catalog and detected the existing anthropic OAuth credential; no secrets printed.

**Channel delivery hardening.** Used the cached Hermes source through `opensrc` as the behavioral reference: cold Telegram boot drops pending updates while reconnects preserve them; Discord and Slack bound recent transport IDs and close superseded sockets. Ziggy now performs a retryable Telegram tail poll at offset `-1` before admitting normal traffic, advances past that tail without opening Pi or sending, and uses a shared bounded recent-ID helper for Discord and Slack socket redelivery. Deterministic vertical-loop tests now prove owner-only inbound message → persistent chat → Pi prompt → outbound reply for Telegram, Discord, and threaded Slack, including socket/chat finalization. Live external round trips remain intentionally unclaimed because no disposable channel credentials are configured in the dump Profile.

**Live Merlin skill catalog.** Replaced the draft in-repo/first-six catalog direction with live discovery from sibling `../merlin`: extension-owned `extensions/*/skills/*` entries win collisions, then top-level `skills/*` contributes the remaining IDs. `ziggy skills list` reports installed and available skills; `ziggy skills add` copies the complete skill tree through a sibling staging directory and refuses replacement unless `--force` is explicit. Service tests cover collision precedence, nested assets, overwrite refusal, whole-tree replacement, and sorted listing. Current Merlin proof: 65 payloads collapse to 61 unique IDs.

**Dump vertical-slice proof.** Initialized `/Users/yesh/Documents/personal/dump/ziggy-vertical-slices/pal`, copied the existing disposable Pi auth/model settings without exposing credentials, listed all 61 Merlin skills, installed `humanizer`, and byte-compared the installed tree with its Merlin source. The actual Pi SDK `InteractiveMode` opened as Pi v0.82.0, displayed `humanizer` in loaded resources, switched to the configured OpenAI `gpt-5.6-terra` model, and completed the prompt with `ziggy tui ok`.

**Final blocker closure.** Replaced the hand-rolled stale memory-lock takeover with per-document SQLite `BEGIN IMMEDIATE` locks under the machine-owned `.runtime/memory-locks/` tree: concurrent writers still serialize, process/connection teardown releases the OS lock without an orphan marker, and no opaque files sit beside human-owned Markdown. Discord Gateway startup now fails immediately on HTTP 401/403 instead of retrying invalid credentials forever. Focused regression coverage and the full gate are green.

**Plans reduced to vertical slices.** Replaced the five long research-style plan documents with a compact shipped/next/later queue. The active order is Profile lease → sessions → doctor → scheduler; live disposable channel proofs can happen as credentials arrive, and durable delivery journaling stays deferred until gateways are load-bearing.

**Primitive comparison refreshed.** Compared all seven Ziggy primitives against the current Merlin and Starman checkouts plus cached Hermes and OpenClaw sources. Added one compact status map and corrected the active queue to Profile path identity → per-turn memory freshness → Profile lease → configured automation delivery failure → sessions → doctor → scheduler. Provider, Session authority, and Extension catalog stay Pi-owned; durable gateway delivery, attach/RPC, richer registries, and broad lifecycle machinery remain deferred.

**Current-directory Profile entry.** Bare `ziggy` now opens the current working directory through the same TUI and typed Profile-initialization path as explicit Profile targets; commands and explicit names/paths are unchanged.

**Local main chat and fresh memory.** TUI and `run -c` now continue the same Pi-owned main chat under `sessions/local/main/`, while plain `run` still starts a fresh root session. Profile memory moved from runtime construction into a hidden inline `before_agent_start` extension that rereads only the ChatContext-admitted files every turn; read failures produce an explicit fail-closed turn prompt instead of being swallowed by Pi's extension runner.

**Owner memory across gateways.** Authenticated Telegram, Discord, and Slack owner DMs now use the canonical `owner` memory identity while retaining their transport-specific chat keys and session directories; group/channel memory and owner-only admission are unchanged.

**Ziggy TUI and live skill roots.** Removed the abandoned MCP adapter/config slice without retaining dependency or lockfile changes. Ziggy now loads Profile-local skills first, every sorted `../merlin/extensions/*/skills` root next, and `../merlin/skills` last through Pi's native loader; Profile-local declared-name collisions win and ambient skills remain disabled. Removed generic `<profile>/extensions` TypeScript loading. Added one hidden fixed Pi extension that brands the TUI title/header/footer only. Real dump proof: `/Users/yesh/Documents/personal/dump/ziggy-e2e/pal` opened with the Ziggy chrome and Pi reported 62 skills from 49 explicit roots, including Profile `haiku-mode`, Merlin `humanizer`, and top-level `extension-authoring`.

**Finish-line audit refreshed.** Cloned current Hermes Agent (`ad6df5e`) and OpenClaw (`49c62f3`) into disposable `/tmp` checkouts and recorded the narrow automation/ownership/visibility/shutdown evidence in `docs/research/finish-line-reference-audit.md`. Filtered out reference-scale machinery that Ziggy has not earned: no general run ledger, lifecycle state machine, or automatic Profile-wide lease. Updated the active queue to truthful configured automation delivery → explicit scheduler-ownership decision → claim-before-wake cron → sessions → doctor. Compaction, per-turn memory, canonical owner memory, and skill/TUI composition remain complete; canonical Profile identity and symlink rejection remain rejected.

**Repository-owned Pi package loading.** Removed the sibling repository and environment-variable composition path. Ziggy now discovers sorted `extensions/*/index.ts` entries and package skill roots from its own repository, with Profile skills first and top-level repository skills last. Pi remains the loader, and every tool registered by those explicit extensions is mechanically activated in print, gateway, and automation runtimes while TUI keeps its normal tool set. Profile skill listing and installation use the same repository root.

**Top-level Pi skills.** Added concise repository-native guidance for authoring and using Ziggy Pi packages, six reusable daily/weekly routine skills without foreign blueprint metadata, and Google Mail/Calendar skills backed by one relative helper with explicit environment-based credentials. Removed duplicate ownership from the migration plan: GitHub, Linear, and memory-management guidance belongs with its executable package.

**Skill-only Pi packages.** Ported the 34 useful skill-only capability folders into repository-owned Pi packages and replaced the old extension-marketplace guidance with one `pi-packages` capability. Every package has a native `package.json`; scripts, references, templates, and licenses now live under the owning skill so Pi's relative-path contract and Profile whole-tree copies agree. Removed foreign runtime paths, commands, environment assumptions, and duplicate tool aliases. Pi loaded all 35 package skills with no diagnostics.

**Lossless Claw on Pi sessions.** Added four native Pi recall tools over a rebuildable SQLite/FTS projection of the current Profile's recursive `sessions/**/*.jsonl` tree. The projection uses Pi header IDs, retains message/tool text plus Pi compaction and branch-summary entries, marks the final active branch, refreshes changed/deleted files transactionally, and keeps concurrent processes on WAL. Pi JSONL remains read-only and authoritative; no second compactor, summary DAG, watcher, or memory store was added.

**Connected-service Pi tools.** Ported Executor's five catalog/call/resume operations plus GitHub and Linear as native Pi tools that run in the Profile cwd with bounded output, cancellation, and source timeouts. Ported the self-improvement capability without foreign hooks: its native tool creates an explicit Profile skill scaffold from a durable `.learnings` entry. Each capability is an independent Pi package with progressive skill guidance.

**Profile skill and memory workflows.** Added Smart Memory as a skill-only workflow over freshly injected scoped memory, Lossless Claw session evidence, and Ziggy's existing `memory_write` authority. Added Skill Curator with exactly three Pi tools to list, read, and atomically create or explicitly replace Profile-local Agent Skills. The curator validates Agent Skill frontmatter and adds no registry, backup store, or repository-package mutation path.

**Local command Pi tools.** Ported browser automation, diff rendering, GitHub PR triage, Open Computer Use, and Exa web search as five native Pi tools with package-local helpers. Each runs from the Profile cwd, keeps generated artifacts under the owning `.runtime/<id>/` directory, bounds model-visible output, and preserves cancellation and timeouts. Focused tests exercise the real helper contracts without external credentials.

**Pi package integration complete.** The repository now contains 47 native Pi packages with 57 skills, 10 executable entrypoints, and 19 tools. Production composition and whole-package manifest loading both pass through Pi without diagnostics; Profile skills retain first collision precedence. Every face uses Pi's normal tool surface plus `memory_write` and package tools, without a Ziggy-owned allowlist. Packages do not hard-depend on one another: agents compose available capabilities, while Self Improvement owns no learning store or mutation path. Root formatting, lint, and typecheck now cover executable package code.

**Truthful configured automation delivery.** A manual wake still runs the model once and prints its local reply first. When `telegram-chat` is declared, missing or invalid `telegram.json` now fails through `AutomationDeliveryUnavailable` instead of logging a skipped delivery and returning success; Telegram API failures remain typed. Automations without delivery are unchanged. Focused filesystem-and-fake-agent tests cover ordering, one prompt, both configuration failures, no-delivery success, and API error preservation; no retry, receipt, outbox, ledger, scheduler, lease, or registry was added.

**Portable package cwd proofs.** Agent Browser's wrapper test now compares the spawned process cwd with the Profile's physical directory while continuing to assert that Ziggy passes the original Profile spelling into package runtime paths. Telephony's default-path test applies the same rule to Python's `Path.cwd()`. Both cover macOS `/var` → `/private/var` normalization without changing Profile identity or production behavior.

**Gateway-owned scheduler reference.** Compared OpenClaw and Hermes scheduler ownership and run observability in `docs/research/openclaw-hermes-scheduler-observability.md`. Both host scheduling inside an existing Gateway instead of a scheduler-specific OS service. The reduced Ziggy shape is one portable ticker hosted by any resident gateway or `scheduler run`, with a short cross-process tick lock, consume-before-dispatch occurrence claims, an immutable run ledger, explicit missed ranges and unknown interrupted runs, and read-only `status`/`runs` commands. launchd, systemd, generation fencing, drift repair, and the startup fuse stay out of scope.

**Profile-selected extension packages.** Added offline shelf list/show and atomic Profile add/remove commands backed only by canonical `extensions.json`. Runtime composition now validates manifests and selections before Pi starts, keeps `pi-packages` plus `extension-authoring` mandatory, admits only selected package resources, and captures paths for the runtime lifetime. Focused tests cover fail-closed decoding, precedence, offline metadata, no-op byte preservation, canonical replacement, direct imports, and all 19 tools.

**Profile extension resource hardening.** Runtime discovery now rejects a missing or wrong-type mandatory `extension-authoring` skill and manifest-declared symlinks that physically escape their package.

**Optional package isolation.** Runtime construction now reads the Profile selection first and validates only `pi-packages` plus selected packages. Full-shelf scanning remains limited to offline catalog commands and repository proofs, so an unfinished or broken unselected package cannot block unrelated Profiles.

**Progressive automation force-run and fanout.** Kept `ziggy wake <profile> <id>` as a write-free manual force-run while replacing the application wake path with one reusable `run(..., { kind: "manual-force" })` operation. Automation definitions now require a validated cron/timezone schedule and strict broadcast policy with canonical Telegram, Discord, and Slack targets; `broadcasts.json` supplies ordered `all` targets and `origin` is persisted explicitly. Gates fail closed on spawn, wait, and timeout failures; model output is still printed once before runtime target resolution and sequential delivery. Runs now return bounded decline, resolution, and per-target outcomes, and the CLI derives safe stderr status plus exit code without exposing adapter causes. Focused tests cover strict parsing, gate cleanup, fresh one-call execution with no Profile artifacts, post-reply resolution, deduplicated fanout, partial failure continuation, and CLI rendering.

**Effect-native full-repository audit.** Eight read-only scouts plus a final verifier inspected all current core sources, tests, executable extensions/scripts, custom lint/config surfaces, and the pinned Effect 4.0.0-beta.99 submodule. The consolidated report at `docs/research/effect-native-full-audit.md` identifies the remaining inward Promise/filesystem leaks, Promise-shaped channel sockets, raw-fetch policy conflict, Pi memory Promise island, typed-error and cleanup gaps, lint blind spots, intentional Pi/executable/test boundaries, and separate extension reliability/security fixes. Current tests, typecheck, and `bun run check` pass.

**Automation operator projections designed.** Defined the smallest read-only `ziggy automations status <profile>` and `runs <profile> [id]` surfaces in `docs/plans/automation-operator-projections.md`: explicit heartbeat freshness, separate scheduler/tick state, deterministic next due and latest-run fields, fixed 10-run history, ordered per-target delivery rows, stable bounded text, create-disabled database absence behavior, and filesystem snapshots proving queries create or mutate nothing. No scheduler, database, or command code was added.

**Durable automation scheduler engine.** Added the Profile-local schema-v1 scheduler ledger, recorded manual and scheduled runs, transactional cursor claims, missed-range and startup recovery, a scoped 60-second-capped timer, and read-only `automations status`/`runs` projections. Scheduled execution remains dormant until the Gateway hosts the engine in Slice 4.

**Slice 3 automation correctness correction.** Added local PID ownership and dead-owner-only recovery, one truthful terminal persistence attempt, absolute scan-failure re-arming, completion-ordered latest errors, and fail-closed persisted projection decoding. Focused and full repository proofs pass.

**Unified resident Gateway.** Composed one Profile-owned `ziggy gateway` host for the automation scheduler and configured channels, with typed channel isolation, scheduler-fatal supervision, scoped shutdown, owner contention, and SIGINT lock cleanup. Focused and CLI subprocess proofs pass.

**External E2E lifecycle correction.** Recovered proven-dead automation owners before manual admission and on every resident scheduler scan, kept live owners untouched, and propagated fatal lifecycle database failures through scheduler supervision while preserving truthful terminal writes and no replay. Focused lifecycle and real-process loopback proofs pass.

**Effect audit extended through the resident scheduler commits.** Four additional read-only scouts reviewed all nine commits after `7e41cfd`, the 21-file delta, current state transitions, tests, and pinned Effect source. Updated `docs/research/effect-native-full-audit.md` for the 124-file checkout with the durable SQLite/Gateway strengths and new gaps: interruption between claim commit and worker registration, interruption around terminal publication, unbracketed chat acquisition, PID-only owner identity, Gateway release/handoff races, direct application-to-adapter dependencies, coarse Promise-owned definition discovery, swallowed cleanup failures, weak write-side transition contracts, and the stale Slice 3 plan. Full tests and `bun run check` pass.

**Standalone extension hardening.** Lossless Claw and Skill Curator now fail closed on symlink escapes; telephony secrets and skill archives publish privately and atomically; Agent Browser, Diffs, and Open Computer Use bound subprocess trees with escalation; Open Computer Use cleans failed calls files; and Here Now bounds every curl operation and cleans temporary responses. Focused external-symlink, unchanged-bytes, process-descendant, missing-executable, and hanging-curl regressions pass.

**Effect audit adjudicated at d8718c1.** Closed the stale scheduler-plan and audit-accuracy records, kept the scheduler/chat/schema/Pi/socket corrections, and deferred PID identity, adversarial Gateway unlink semantics, Profile filesystem extraction, and deeper lint/type-provenance work where no current collision witness justifies a new authority or abstraction. Corrected finite Schema suggestions; current typecheck remains exit-0 with five intentional informational suggestions documented in the audit.

**Effect audit closeout.** Replaced the superseded gap inventory with a current disposition matrix, commit/test/vendor evidence, live file/method inventory, exact residual order, and a concise scheduler-plan addendum. Full check, 182 Bun tests, all helper suites, and diff validation pass.

**Profile agent discovery (TUI-only).** Added a schema-derived `agents/*.md` contract with strict
version/description/provider-model/thinking/tools metadata, kebab-case filename IDs, and required
Markdown bodies. The filesystem adapter discovers physical files safely with signal-aware,
sequential Effect reads, preserves typed causes, treats a missing directory as empty, and rejects
symlink roots/files. `openTui` alone admits the discovered specialists; the hidden TUI extension
registers `/agents` and keeps the command inert outside TUI mode. Added domain, filesystem, TUI
extension, and openTui admission proofs; gateways, automations, and selected extension loading are
unchanged.

**Runnable Profile specialist (TUI-only).** Added an Effect-native `agent_run` bridge that resolves
exact Profile registry models/auth and thinking levels, inherits active parent settings when
metadata is omitted, intersects declared tools with admitted parent tools, and excludes
`memory_write` plus `agent_run`. Each call uses captured Profile resources, a Pi in-memory child
session, `promptForAssistantText`, signal-aware interruption, and acquire/use/release disposal;
child answers return model, thinking, tools, and nested session usage metadata. The hidden TUI
extension keeps Ziggy chrome everywhere it is intended but admits `/agents` and `agent_run` only
for `openTui`; fake-runner tests cover strict input, failure rendering, and compact/expanded
results.

**Runnable specialist contract hardening.** Corrected the TUI-only `agent_run` slice so Profile agent metadata is authoritative with parent fallback only for omitted provider/model/thinking fields, and missing tools means no child tools. The public schema now accepts only `agent` and `prompt`; internal requests can only narrow the Profile allowlist. Selection validates all declared/requested tools (including memory, agent, and discussion blocks) as typed failures and uses Pi's `getSupportedThinkingLevels`. Child transcript usage now aggregates exact Pi `Usage` values from assistant and nested tool-result messages, publishes it on `AgentToolResult.usage`, and expanded rendering uses real newlines. Added selector, strict-tool, thinking, inheritance, narrowing, usage, and rendering regressions.

**Agent selection UX (TUI-only).** Added deterministic leading `@agent-id` validation before model calls, clear unknown-agent guidance via `/agents`, and Pi-native `@agent` autocomplete with descriptions without changing slash completion. Valid selections preserve the user task and add honest model-guided `agent_run` instructions; TUI system guidance now lists specialist descriptions and delegates only on clear matches. Non-TUI faces remain unchanged. Focused extension tests cover autocomplete, rejection, selection, ordinary dispatch guidance, and non-TUI silence.

**Bounded specialist discussions (TUI-only).** Added `agent_discuss` beside `agent_run` only in the TUI runtime: 2-4 unique sorted Profile agents, one or two sequential rounds, zero child tools, bounded Unicode-safe prompts/transcripts, cancellation, stop-on-failure, and parent synthesis guidance without a hidden provider call. Discussion details include each bounded answer/model record and immutable combined Pi usage; compact and expanded renderers expose calls, tokens, cost, and newline transcripts. Focused fake-runner tests cover schema/bounds, ordering, prior-output wiring, failure, cancellation, usage, rendering, and existing non-TUI silence.

**Specialist integration correction.** Discussion input now rejects whitespace-only topics before any child call, bounds the complete discussion tool output by Unicode code points, and preserves exact immutable combined usage on typed partial-failure results (including zero completed-call usage). Focused and full repository proofs remain green.

**Automation specialist routing.** Automation bodies now share the Profile leading `@agent-id` parser with TUI input, reject malformed tags with the source path, and strip valid tags into an explicit specialist task. Passed gates route tagged runs through `ZiggyAgent.runSpecialist`, which discovers agents, reuses strict Profile policy selection with parent fallback, executes one in-memory child answer, and brackets host/child cleanup; untagged runs retain the fresh openChat path. Stable specialist failure categories are projected and rendered through top-level errors. Focused domain, automation, TUI, and specialist lifecycle tests pass.

**Cron specialist integration correction.** Preserved Pi's `AgentSessionRuntime.services` getter instead of assigning to it, and added a real SDK runtime regression. Direct specialist runs now let strict Profile provider/model selection proceed even when the host has a parent model fallback diagnostic; leading tags use identical literal-position semantics in TUI and automation, while untagged automation prompts retain their prior fresh-session path.

**Canonical Hermes Agent primary-source inventory.** Resolved `NousResearch/hermes-agent` as the canonical product while preserving the unexplained `hermes-agent-org/hermes` collision and separating first-party companion repos. Added `docs/research/hermes-primary-surface.md` with exact-commit claims for installation, profile/session/memory ownership, agents and subagents, skills/plugins, cron and its `wakeAgent` gate, runtime/tool/hook primitives, OpenAI API versus ChatGPT Codex auth, optional Codex app-server semantics, auth-isolation caveats, and the absence of a defined Hermes “CLA” concept.

**Live Ziggy–Hermes core parity experiment.** Created disposable Ziggy and Hermes Profiles under `Documents/personal/dump`, exercised both through profile setup, ChatGPT/Codex `gpt-5.6-luna` high-reasoning runs, specialist/delegation paths, and forced local automations, and retained inspectable evidence in each workspace. Added `docs/research/ziggy-hermes-core-parity-live.md`: Ziggy's core loop is already competitive and materially smaller, while the priority gaps are cross-face specialist admission, persisted Pi lineage for specialist automations, a settled Profile Agent contract, and the minimum model/agent/automation/session/doctor CLI spine—not Hermes' custom runtime, databases, mutable memory, or agent fleet.

**Profile agent lineage and complete CLI plan.** Added `docs/plans/profile-agent-session-lineage-and-cli.md`. The plan makes every production Profile agent execution a saved Pi session, links nested children to their TUI/gateway/print parent without merging child context, removes the in-memory tagged-automation path, admits agent tools through one face-neutral runtime, and then lands a typed CLI spine with help/version, Pi-backed model controls, doctor, guided safe init, agent and automation creation/inspection, session lineage projections, and a `serve` alias over the existing resident owner. Marked the older CLI queue as superseded while preserving its read-only session and doctor requirements.

**Profile agent session lineage and face parity.** Every production `agent_run` and `agent_discuss` participant now runs in a persistent Pi child whose header points to the parent session; bounded parent tool details retain the child ID/file and nested usage while the complete transcript stays isolated in Pi JSONL. Direct Profile agent and tagged automation execution now use one useful saved root under an explicit run directory, return a client-neutral session reference, and contain no production `SessionManager.inMemory` host. Profile agent discovery, optional tools/catalog guidance, and leading-mention preparation are shared by TUI, print, gateway chats, and untagged automations; malformed or unknown mentions fail before provider work, while child memory writes and recursion remain blocked. Real-SDK tests prove direct-root persistence, child headers/transcript isolation, and one-root behavior; boundary tests cover all face admission and automation run routing.

**Typed CLI spine.** Replaced raw `process.argv` branching with one Schema-backed decoder and typed command union. Added stable general and command help, version aliases, explicit `tui`, exact arity, reserved-command failures, and retained bare Profile shorthand plus every existing command shape. `src/main.ts` remains the sole production Effect execution edge and reads the package version directly from `package.json`.

**Pi-backed model controls.** Added `models status`, `models list [--provider]`, and `models set <provider>/<model> [--thinking]` over Profile-local Pi `ModelRuntime` and `SettingsManager`. Model IDs and supported reasoning levels come from Pi's catalog, settings writes flush and drain Pi errors before success, output omits credentials, and a real-SDK regression reloads the persisted Profile defaults without any Ziggy model registry or settings parser.

**Profile agent CLI.** Added typed `agents create/list/show/validate/run` commands over the authoritative `agents/*.md` files. Creation is exclusive and produces a valid model-inheriting, tool-free specialist; listing is stable; show exposes metadata plus the Profile-relative editing path without instruction text. Validation isolates malformed siblings and checks effective Pi model/thinking/auth plus permanently blocked specialist tools where those checks are safely read-only. Direct runs delegate to the existing persistent root specialist operation under a fresh Profile session directory, so failures retain Pi-owned session evidence.

**Automation definition CLI.** Moved reusable Markdown definition enumeration out of the SQLite adapter and added typed `automations create/list/validate` commands over authoritative `automations/*.md` files. Exclusive creation writes a parser-proven UTC starter with `broadcast: none` and no gate; output explains that it remains manual-only and scheduled model calls stay blocked until a gate is added. Catalog and validation preserve stable file order, report invalid siblings independently, label missing-gate definitions `manual-only`, and leave `.runtime` and scheduler SQLite absent.

**Transcript-free session lineage CLI.** Added recursive `sessions list/show` projections over one Pi adapter. The adapter Schema-decodes only safe header/entry metadata, resolves root/child links, aggregates assistant, nested tool, and summary usage once, and derives completed/failed/aborted/incomplete state without returning prompts, replies, thinking, tool arguments, or tool output. It rejects symlinked session roots/files and uses no-follow reads; missing roots remain missing, malformed files fail typed, and filesystem snapshots plus subprocess tests prove list/show create and rewrite nothing. Pi v0.82.0 `SessionManager.open/list` are intentionally not used because open may migrate/rewrite and list is non-recursive and transcript-oriented.

**Preferred resident `serve` command.** Added `ziggy serve <profile>` as the preferred name over the unchanged `ResidentGateway.run` application owner. `ziggy gateway` remains a compatibility alias; both names host an automation-only Profile when no channels are configured, preserve the existing owner lock and channel branches, and use identical interrupt-only clean teardown. Help and architecture docs now lead with `serve`.

**Read-only Profile doctor.** Added ten stable, independently evaluated health checks for the Profile/SOUL boundary, Pi settings and auth, Profile agents, automation definitions, bounded memory, selected extensions and skills, present gateway configs, shallow Pi session headers/parent links, and the resident runtime directory. Checks reuse their owning decoders, report only bounded metadata, return failure only for errors, and preserve the complete Profile tree byte-for-byte in focused tests.

**Resumable safe Profile setup.** Guided `init` now runs only on an input/output TTY, creates only a missing `SOUL.md` plus missing empty `agents/` and `automations/` directories, rejects non-regular and symlinked SOUL paths, reports registry writes, resumes existing auth/model choices, persists explicit provider/model/thinking choices through the existing Auth and Pi Models services, and finishes with doctor plus an exact launch command. `--minimal` retains file-only initialization, while `--non-interactive` never prompts and fails with a resume command when required setup is missing. Focused tests cover strict boundaries, registry propagation, non-interactive setup, whole-tree init idempotency, and unchanged human-owned bytes.

**Doctor Pi probe correction.** Split read-only Auth and Models status probes from their writable command/setup counterparts. Doctor now injects non-persisting Pi credential and model stores while still using Pi's provider/model catalog and Profile settings, so checking a minimal Profile no longer creates `auth.json` or `models-store.json`. Adapter tests and a real CLI whole-tree comparison prove the correction.

**Read-only operator projection integration.** Routed model/auth status, model listing, and Profile-agent validation through non-persisting Pi projections, eliminating the empty `auth.json` and `models-store.json` files found by disposable CLI tree snapshots. Doctor now consumes the final recursive, no-follow session metadata projection instead of its earlier shallow header parser, so lineage warnings and malformed-session failures match `sessions list/show`.

**Pi lazy session guarantee correction.** Corrected the session contract to Pi v0.82.0's public guarantee: `SessionManager.create` allocates persistent mode and a target path, but JSONL materializes only with the first assistant message. A real-SDK regression proves that a user message alone still leaves no file; pre-response failure or cancellation can therefore leave no JSONL, and Ziggy does not fabricate transcript entries to force one.

**Round 2 live parity evidence closeout.** Reviewed both retained 25-step Ziggy/Hermes reports and disputed raw evidence for model-authored automation tool calls, saved Profile-agent root/child lineage, transcript-free session projections, byte-identical read-only checks, automatic resident runs, clean shutdown, doctor, and the bounded TUI retry. Every required Ziggy journey passed; the first TUI probe was incomplete evidence rather than a runtime defect and its retry passed. Updated the live comparison with exact evidence paths, per-step PASS/partial status, preserved authority differences, and residual operator limits. No production or test code changed because no concrete Ziggy defect was found.

**Gap 08 resident supervision.** Added read-only `ziggy serve status <profile>` over the existing owner file and PID-liveness authority. The Bun boundary now distinguishes stopped, running, and stale records, rejects malformed or symlinked ownership as typed failures, and creates or changes no runtime state. Stable CLI output keeps resident process truth separate from scheduler heartbeat health and persisted automation run history. Added focused adapter, face, decoder, and subprocess proofs plus placeholder-only launchd/systemd operating recipes; no tick, installer, daemon protocol, socket, or second scheduler was added.

**Gap 07 progressive automation lifecycle.** Made the Profile filename the sole active/paused authority: `<id>.md` is active and `<id>.paused.md` is paused. Added typed `automations pause`/`resume` commands backed by exclusive same-directory hard-link then source-unlink transitions, exact-byte preservation, symlink rejection, destination collision refusal, and fail-closed active/paused conflict discovery. List and validate now render lifecycle; manual wake reports paused explicitly; scheduler scans clear paused cursors, reject conflicts, leave already claimed/running work alone, and restart resumed schedules from a fresh future occurrence. Added focused domain, filesystem, application, CLI, and scheduler proofs plus `docs/operations/automations.md`; Profile Markdown remains policy authority, SQLite remains projection/run truth, and supervised `serve` remains the only internal tick owner.

**Hermes/OpenClaw service supervision research.** Compared pinned primary Hermes and OpenClaw launchd/systemd/Task Scheduler implementations, runtime health, locks, shutdown/recovery, and gateway-hosted scheduling against Ziggy’s supervised `serve`, read-only status, scheduler heartbeat, run ledger, and conservative owner lock. Saved the report to `docs/research/hermes-openclaw-service-supervision.md`; no production code changed.

**Serve and scheduled automation finish plan.** Defined the remaining resident milestone in `docs/plans/serve-automations-finish.md`: a crash-safe scoped resident lease, owner-fenced scheduled claims with one explicit database migration, narrow per-Profile launchd/systemd user-service commands, combined read-only status, and clean-stop/hard-crash live proof. The plan keeps Markdown definitions, Pi sessions, the existing run ledger, one scheduler owner, and no public tick, retry engine, daemon protocol, or service registry.

**Resident serve automation finish verified.** Reviewed the complete implementation against the finish plan and corrected one live launchd integration defect: `launchctl print` reports an unloaded label with exit 113 plus `Could not find service`, which Ziggy had rendered as unknown and therefore made every successful macOS stop time out. The retained red proof exits 1 with `readiness: not-reached`; the correction classifies only launchd's explicit missing-service response as stopped, and the rerun reports `readiness: ready`. Updated the serve and automation operations guides for managed lifecycle commands, independent status facts, crash fencing, no replay, Pi session authority, and macOS protected-folder access.

**Disposable LaunchAgent proof.** Retained all evidence under `/Users/yesh/Documents/personal/dump/ziggy-core-parity/serve-automation-finish/`. The first Profile at the exact Documents path exposed macOS TCC blocking launchd-owned Bun directory enumeration; no privacy setting was changed, and that agent was uninstalled. The complete proof then used `/Users/yesh/.ziggy/profiles/serve-automation-finish-live` with evidence retained back under the requested workspace: install `--no-start`, automatic start, one `openai-codex/gpt-5.6-luna` high run scheduled 208 seconds ahead, completed Pi root session metadata, clean restart from PID 40595 to 45970, a paused definition with zero admissions, fresh resume admission at the next future minute, hard kill of active run owner 45970, automatic return as PID 47156, old run fenced `unknown/process-start`, unchanged single run after 70 seconds, separated service/process/scheduler/run status, and uninstall with launchctl exit 113, no plist, no owner projection, and byte-identical retained Profile/runtime/session hashes. The killed gate's orphaned `sleep 300` helper was explicitly terminated after recovery evidence; Ziggy did not replay or adopt it. Final verification: focused serve/automation suite 92 passed, `bun run check` passed, full Bun suite 311 passed, and Here Now, telephony, and skill-creator helper suites passed (1 shell proof plus 4 and 10 Python tests).

**Profile extension multi-select restored.** Reintroduced the previously proven Pi custom checklist against Ziggy's current repository-owned package shelf. `/extensions` now lists all optional packages, preserves the Profile's selected set, toggles any number with Space, and atomically saves the complete validated selection on Enter; it explicitly asks the operator to reopen because current runtime resource paths remain startup-owned. Shared full-set validation keeps CLI add/remove semantics canonical, and focused component, TUI command, filesystem runner, and Profile mutation tests cover multi-selection, required-package exclusion, sorted persistence, and no-op byte preservation.

**Built-in automation manager.** Added a hidden Profile TUI `/automations` extension over the existing automation definition and scheduler services. Operators can inspect scheduler state, choose definitions, view metadata, edit complete validated Markdown, inspect fixed run history, and pause or resume without introducing another policy store or tick owner. TUI callbacks enter one scoped Effect worker; validated saves use expected-source conflict refusal plus same-directory atomic replacement, so invalid drafts and ordinary concurrent edits preserve authoritative bytes. Focused application, filesystem, bridge, and TUI tests cover the new surface.

**Executable self-discovery research.** Documented Ziggy, exact Pi 0.82.0, and arbitrary dependency knowledge obligations in `docs/research/executable-self-discovery.md`. The Squarey test currently uses a native launcher and launchd service that still execute Bun against the development checkout; a direct standalone compile loses `extensions/` under `$bunfs`. Recommended release choices are an immutable versioned resource sidecar or, for a literal one-file download, a hashed embedded pack extracted to a read-only content-addressed cache, with exact-version network lookup only as a fallback.

**Live Slack gateway setup guide.** Added `docs/operations/slack.md` as a reusable, secret-free setup and operations guide based on the working Squarey Socket Mode setup path: blank app, app and bot token scopes, message events, App Home, installation, owner member ID, strict private `slack.json`, doctor/restart/log verification, DM and channel test procedures, memory/session/extension behavior, PATH caveats, troubleshooting, rotation, and removal. The verification record distinguishes proven configuration/startup from the still-required message round trip. Linked the guide from the root README and resident operations guide so it can become a future docs-site page without depending on machine-specific paths or credentials.

**Slack standard Markdown delivery.** Changed the Slack Web API boundary to send Pi's standard Markdown through `chat.postMessage.markdown_text` instead of the mrkdwn-parsed `text` field, fixing visible `**bold**` delimiters while preserving threads and the existing 4,000-code-point chunk boundary. A focused adapter regression proves the exact outbound JSON, and gateway plus automation delivery tests remain green.

**Slack native working status.** Added best-effort `assistant.threads.setStatus` feedback at accepted-message admission, using an existing thread root or the inbound message timestamp. The gateway sets `is thinking...` before opening or prompting Pi and clears it through an uninterruptible acquire/use/release finalizer on success, failure, or cancellation; status API failure never blocks the actual turn. Slack's March 2026 contract permits channel-based apps to use this with the existing `chat:write` scope and no AI split-view migration. Focused adapter and gateway tests prove exact JSON, source-thread selection, normal cleanup, and failure cleanup.

**Apple Reminders query latency correction.** Replaced the native skill's list-by-list, per-reminder Apple Event scan with application-wide `whose` predicates for incomplete and day-bounded due reminders, while retaining concise list-aware output and the absolute system `osascript` boundary. The exact tomorrow query completed against the live Reminders store in 4.99 seconds with output suppressed, versus roughly 4 minutes 16 seconds for the original Squarey turn. Registered the package in complete-catalog proof and renamed its skill `apple-reminders-native` so it can coexist with the existing `remindctl` package without a Pi skill-name collision.

**Slack client-visible working fallback.** Added an immediate `Working on that…` message for every accepted event before the turn waits for its chat permit or opens Pi. The gateway retains Slack's returned message timestamp and replaces the same message with the first final Markdown chunk; overflow continues as ordinary posts, while failed or cancelled turns replace the placeholder with an explicit failure notice. Placeholder failure remains best-effort and cannot block the model turn. Focused adapter and gateway tests prove the post/update JSON and success/failure lifecycle.

**Explicit Slack channel activation.** Added optional Profile `channelMode: "mention" | "always"` policy. Mention mode admits only owner-authored channel, private-channel, or MPIM events containing the authenticated bot's exact Slack mention and strips that token before prompting Pi; direct messages remain active. Existing three-field configurations preserve the previous always-on behavior, while the operations guide recommends mention-only for shared channels. Focused configuration and gateway tests cover both modes, invalid policy, empty mentions, and DM independence.

**Slack reliability and live E2E milestone.** Proved the installed Squarey resident through the logged-in macOS Slack client: a DM rendered one edited Markdown reply, and `#all-presh` answered an owner message without an app mention under the live three-field Profile's compatibility `always` mode. A post-restart two-turn test visibly progressed from `Working on that…` plus `Queued behind an earlier request…` to two edited final replies, and a real thread reply created and used a distinct thread-root Pi session directory without transcript inspection. Hardened the path with admission-before-ACK for valid Socket Mode events, bounded operation-aware delivery retries that never replay ambiguous new-message posts, thread-root Pi sessions for actual channel threads while preserving channel group memory, queued placeholders, 30-second native-status heartbeats, broadcast-mention escaping, line/word-aware 4,000-code-point splitting, and content-free socket/admission diagnostics. Focused queue-overflow, retry, session, output-safety, queue-feedback, heartbeat, and lifecycle tests cover the new invariants.

**Slack reaction feedback.** Added a best-effort source-message reaction lifecycle: 👀 on admission, removal at settlement, then ✅ for success or ❌ for failure. A missing `reactions:write` permission disables reaction attempts for the current resident process after one content-free diagnostic and never blocks status, placeholder, model, or final delivery. The HTTP adapter owns `reactions.add`/`reactions.remove`; focused adapter and gateway tests prove exact request JSON and both settlement paths, and the Slack operations guide now includes the required bot scope and reinstall step. After the operator added `reactions:write` and reinstalled Squarey, a fresh resident live probe observed `eyes` followed by `white_check_mark` on a completed DM. A controlled restart during a second active DM observed `eyes` followed by `x`, the placeholder edited to `I couldn't complete that request.`, and a healthy replacement resident. The proof used only the existing history scope; no `reactions:read` expansion was needed.

**Content-free Slack runtime health.** Added a strict atomic `.runtime/slack-health.json` projection for connection freshness, bounded failure categories, and turn counters without message, routing, token, timestamp, or session content. Existing `serve status` and `doctor` surfaces now report Slack independently from supervisor, process, and scheduler health; observation writes remain best-effort and cannot block a turn. Socket connection-state observation has explicit queue cleanup. Live Reminders E2E also exposed Slack telephone-link markup entering prompts, so inbound visible labels and entities are normalized once while real bot-mention admission remains anchored to the raw event.

**Durable Slack ingress.** Added a dedicated strict `.runtime/slack-ingress.sqlite` journal that commits accepted messages before Socket Mode ACK, deduplicates both the logical Slack message and optional event ID, replays prior-owner received/running rows with bounded concurrency, and fences running/terminal transitions by a resident UUID. Terminal rows never replay, clear prompt text immediately, and retain only a bounded set of routing/deduplication facts. Ambiguous outbound delivery settles as `unknown` without retry. Connection-local ACK fencing prevents a stale socket from acknowledging after reconnect. The design deliberately promises durable at-least-once ingress, not exactly-once model execution or Slack delivery.

**Complete executable implementation packet.** Added `docs/plans/standalone-executable-and-source-lookup.md` for a fresh coding session. The selected shape keeps repository manifests as authoring input, generates a statically linked extension/embedded-skill catalog, removes runtime checkout discovery, closes helper and exact Pi asset compatibility, makes resident services self-launch, and proves one copied macOS arm64 artifact without Bun, `node_modules`, sidecars, or checkout access. Exact Ziggy/Pi source is fetched only through a bounded, hash-verified read-only lookup at pinned public release coordinates; it is never runtime code. Marked the earlier sidecar-first research recommendation as superseded.

**Slack scoped stop command.** Added exact owner-only `stop` and `/stop` commands after ordinary DM/channel mention normalization, with plain `stop` as the reliable Slack-composer form. Each scheduled queued or running turn registers a per-chat generation and cancellation signal before its scoped fiber starts; stop advances only that chat or thread, interrupts all older turns outside the semaphore, and lets Pi's existing Effect cleanup abort an active session. Cancelled journal rows settle under the resident owner fence, queued cancellations never reach Pi, stale completions cannot publish final content, stopped placeholders and reactions remain client-visible, feedback failures cannot delay cancellation, and the next message proceeds on a fresh generation. Content-free health reports cancellation separately from failure. Focused tests cover authorization, normalized channel commands, running and queued cancellation, durable cancelled settlement, thread isolation, absent late replies, fresh post-stop work, and bounded replay.

**Slack bounded image input.** Added owner-authorized, file-only-capable Slack image admission for up to four PNG, JPEG, WebP, or GIF files at 5 MiB each. The strict v2 ingress journal migrates exact v1 databases, replays bounded private-file metadata, and erases it with prompt text at terminal settlement. The Slack adapter accepts only private `files.slack.com` HTTPS URLs, checks metadata, response MIME, `Content-Length`, and a bounded byte stream, redacts URL/token failure details, and passes successful images through Pi's typed `AgentSession.prompt` image option. Unsupported, oversized, excess, missing-scope, and download-failed attachments become bounded metadata notices without failing the text turn. Focused socket, SQLite migration/replay/erasure, HTTP guard/redaction, Pi interruption, and gateway handoff tests cover the slice.

**Slack progressive placeholder and tool status.** Added a Ziggy-owned Pi progress contract that maps bounded assistant text and sanitized tool lifecycle events without exposing Pi SDK event types. Slow turns now coalesce text into rate-bounded edits of the existing working placeholder and show native `Using <tool>…` thread status through one serialized, bounded progress owner; final placeholder replacement and overflow chunks remain authoritative. Scoped shutdown, per-chat generation fences, synchronous bounded queues, and a per-chat status permit prevent cancelled or stale work from publishing later progress and make stop wait behind older in-flight status writes before clearing every deduplicated cancelled-request target, while intermediate Slack failures remain best-effort and never make final delivery ambiguous. Focused tests cover Pi mapping and cleanup, elapsed-plus-growth throttling, broadcast-token escaping, tool-update flood coalescing, parallel-safe terminal status, final ordering, stopped-generation suppression, blocked-write clear ordering, distinct DM targets, and shared channel-thread deduplication.

**Per-channel Slack activation.** Replaced the Profile-wide channel switch with strict channel-ID overrides. Every public channel, private channel, MPIM, and its threads now defaults to mention-only activation; only a channel explicitly mapped to `"always"` accepts unmentioned owner messages. DMs remain active, every mention-only thread request must mention the bot, and invalid channel IDs, global policy, unknown modes, and unknown fields fail closed. Focused schema and gateway tests cover default behavior, explicit overrides, mention stripping, thread inheritance, and DM independence.

**Thread-first Slack channel conversations.** Every accepted top-level channel request now uses its source timestamp as both the Slack reply root and Pi thread-session identity. Working, progressive, final, overflow, failure, cancellation, and stop output stays under that request; later accepted Slack thread replies reuse the same session, while separate root discussions keep independent transcripts and queues. Direct-message routing and channel-scoped group memory remain unchanged.

**Thread-first Discord boundary and operator UX.** Compared the current OpenClaw and Hermes Agent opensrc snapshots with Ziggy's recent Slack lifecycle work, recording revision limits and the selected boundary-preserving slices in `docs/research/discord-gateway-upstream-comparison.md`. Top-level guild requests now create native Discord threads keyed as independent Pi sessions while follow-ups reuse that thread and parent-channel group memory; DMs remain unchanged. The Discord face owns queued/working/progressive/failure/stopped message edits, Unicode-aware delivery, disabled outbound mention parsing, exact per-conversation `stop`, and generation fencing against stale completion. The REST adapter now owns channel lookup, source-message thread creation, receipt-backed sends, and edits. The socket publishes content-free connected/reconnecting/failed/stopped lifecycle events, and a strict atomic `.runtime/discord-health.json` projection feeds independent `doctor` and `serve status` rows with freshness and turn counts. Focused tests cover REST contracts, thread isolation/continuity, queue promotion, scoped cancellation, progress bounds, socket lifecycle, projection decoding, and operator rendering; attachments, slash commands, and broader account policy remain explicitly deferred.

**Live Discord installation and cancellation correction.** Configured the Squarey Profile through the existing Kiri Discord application without exposing credentials, restarted the managed resident, and proved `connected` plus bot-online state in the desktop client. Computer Use E2E proved native-thread creation, same-thread session continuity, independent sessions for two roots, edited working/final states, and scoped cancellation of one running plus one queued request. The live stop exercise exposed a stale `queuedTurnCount` when a queued fiber was cancelled before semaphore admission; cancellation events now carry that admission fact and settle both counters, with focused health and gateway regressions. The Discord operations guide retains the exact secret-free proof and its deferred boundaries.

**Discord-native reaction and typing feedback.** Reused the narrow lifecycle invariants already proven by Ziggy's Slack face while implementing only Discord mechanisms observed in the OpenClaw/Hermes references. The Discord HTTP adapter now owns native typing plus bot-owned reaction add/remove endpoints. A root request reacts on its actual source channel while typing targets the created native thread; follow-ups keep both targets in the thread. Each accepted turn moves 👀 to ✅, 🛑, or ❌, and exact `stop` acknowledges its source with ✅. Typing renews only while the scoped Pi turn is active. Per-channel non-retriable feedback denials stop repeated attempts without blocking placeholders, model work, delivery, health, or other channels. Focused adapter and gateway tests prove exact REST contracts, source-versus-delivery routing, typing lifecycle admission, reaction ordering, and cancellation feedback. Live Computer Use exposed Discord's per-route rate window when remove-👀 and add-terminal happen back-to-back; reaction feedback now honors `retry_after` for at most three attempts. The corrected rerun visibly proved 👀 plus native typing, 🛑 cancellation, ✅ stop acknowledgement, and a ✅ successful `DISCORD-NATIVE-OK` turn with settled health.

**Slack existing-thread context hydration.** Added a typed, cursor-paginated `conversations.replies` boundary that fetches the channel-thread root and prior replies immediately before each accepted mention, excluding the triggering message and later working output. The gateway projects at most 200 messages and 30,000 Unicode code points as explicitly untrusted context, while Pi injects it into only the active system prompt behind a generation fence instead of duplicating it into the durable transcript or Profile memory. A bare mention inside a thread now means review and help with that discussion; a bare top-level mention asks what help is wanted. Focused adapter, gateway, pagination, security-projection, routing, and Pi prompt tests cover the slice.

**Slack thread transport and historical-image correction.** Live `#daily` use exposed two gaps in the first hydration slice: Slack ignored the JSON POST arguments for `conversations.replies`, and a file-bearing reply followed by a separate Squarey mention lost the earlier files. The adapter now uses Slack's GET query contract, strictly decodes bounded prior-file metadata, and the gateway merges current images first with the most recent distinct historical thread images under the existing four-image and 5 MiB guards. The reproduced live thread now returns three prior PNGs through the corrected adapter, and focused HTTP plus gateway tests cover the exact paste-images-then-mention workflow.

**Durable Discord ingress and restart replay.** Added a dedicated strict `.runtime/discord-ingress.sqlite` journal at the Discord gateway boundary, leaving Pi, Profile policy, the resident owner, and other channel faces unchanged. Each resolved DM/thread message is committed by source message ID before scheduling Pi, claimed by one resident UUID, and settled as completed, failed, cancelled, or unknown; terminal settlement erases prompt text and bounds retained terminal routing facts to 1,000 rows. Startup recovers foreign-owner running rows and schedules replayable work in admission order before new socket intake, while duplicate Gateway delivery is rejected before Pi. The contract is explicitly at-least-once after conversation resolution—not exactly-once model execution or delivery—and native top-level thread creation remains before the journal because the Discord-assigned thread ID owns session identity. Focused SQLite, gateway, and supervisor tests cover strict-schema failure, owner fencing, duplicate suppression, recovery, ordered replay, cancellation/terminal settlement, prompt erasure, and retention.

**Discord bounded image input and native app proof.** Added owner-authorized, file-only-capable Discord image admission for up to four PNG, JPEG, WebP, or GIF attachments at 5 MiB each. The strict v2 ingress journal migrates exact v1 databases, replays bounded attachment metadata, and erases it with prompt text at terminal settlement. The adapter accepts only Discord CDN attachment paths, validates metadata, response MIME, `Content-Length`, and bounded streamed bytes without sending the bot token, and passes successful images through Pi's typed prompt image option; unsupported, oversized, excess, malformed, and failed attachments become bounded notices. Socket, HTTP, SQLite migration/replay/erasure, and gateway handoff tests cover the slice. A managed Squarey restart preserved the live v1 terminal row while upgrading to v2, and Computer Use through `/Applications/Discord.app` uploaded a file-only synthetic PNG: Kiri correctly identified its yellow background, blue rounded rectangle, and red circle, the source settled with ✅, status returned to zero active/queued work, and the terminal row retained neither prompt text nor attachment metadata.

**Discord-native slash controls.** Added strict Gateway decoding and deduplication for Discord application-command interactions plus narrow, owner-only global `/status` and `/stop` definitions. Startup registration compares and upserts only Ziggy's two owned definitions without bulk-overwriting unrelated commands; interaction callbacks are private, mention-safe, and omit bot authorization. Commands remain thread/DM scoped, top-level guild use points the owner into a work thread, and `/stop` shares the exact text-stop cancellation and generation fence without opening Pi. Native macOS Discord E2E selected both commands through the Apps picker and received the expected private zero-work responses. Temporary guild duplicates were removed while preserving the existing `kiri-*` command set so the picker exposes one polished Ziggy command surface.

**Consolidate Apple Reminders packages.** Removed the legacy `remindctl`-driven `apple-reminders` extension and renamed the native `apple-reminders-native` package (typed `apple_reminders_*` tools over fixed AppleScript) into its place under the original `@ziggy/apple-reminders` name, restoring the plain skill name without a Pi collision. The complete-catalog proof now lists one Apple Reminders package and resolves it through the production extension path.

**Remove obsolete Kiri Discord commands.** Gateway READY now carries the connected guild IDs into application-command reconciliation. The Discord adapter deletes only the exact legacy `kiri-bind`, `kiri-run`, `kiri-diff`, `kiri-status`, and `kiri-queue` definitions at global and connected-guild scope, keeps unrelated command names untouched, and still idempotently repairs Ziggy's global `status` and `stop` definitions. Focused socket, HTTP adapter, and gateway tests cover guild discovery, precise deletion, unrelated-command preservation, and startup wiring.

**Discord ambiguous-delivery and orderly-restart recovery.** Replaced the unbounded gateway retry loop with four-attempt idempotent retries and non-replaying ambiguous POST delivery; only explicit rate limits permit a new-thread or new-message POST retry. Network, server, and invalid-response outcomes after durable admission now select the existing `unknown` terminal state. Orderly resident interruption requeues unfinished owned ingress with prompt and attachment metadata intact, while explicit stop remains terminal `cancelled`; startup foreign-owner recovery still covers abrupt process loss. Focused gateway response-loss/restart tests and the SQLite replay-payload invariant cover both corrections.

**OpenClaw and Hermes multi-agent routing study.** Added a source-pinned comparison of each system's durable agent unit, operator and inbound selection, routing precedence, session/state isolation, bot-mention behavior, fallback rules, and delegation security. The study distinguishes OpenClaw's named agents and binding resolver from Hermes' Profile/home boundary and optional multiplex routes, and records that neither system treats arbitrary free-form `@agent-name` text as a general durable-agent selector.

**Repository extension shelf pruning.** Removed eleven obsolete or superseded extension packages, including duplicate channel guidance, duplicate GitHub issue tooling, the retired PR-triage helper, and unused standalone skill bundles. Updated complete-catalog expectations, helper test commands, and the standalone executable plan so production resource proofs describe the remaining shelf exactly.

**Terminal secret-input ownership correction.** Stopped the secret prompt from changing stdin's process-global encoding and flow state. The terminal adapter now owns only raw-mode toggling and its temporary data listener, leaving the surrounding Pi/readline runtime responsible for stream encoding, resume, and pause behavior.

**Type-safety Oxlint rules added.** Ported the anti-slop rule set into Ziggy's existing `.mjs` plugin layout as `ziggy/*` next to `ziggy/no-unsafe-typescript-syntax`, without a separate `anti-slop` plugin or `@oxlint/plugins`.

**Type-safety source cleanup.** Renamed Effect service `*Shape` identifiers to `*Api` (and SQLite `*Shape` fingerprints to `*Fingerprint`) so `ziggy/no-shape-in-symbol-names` can stay an error. Replaced runtime `typeof` / `"code" in cause` probes with `fileSystemCauseDetails`, named adapter request/runtime types, Schema decoding at Pi/session boundaries, and explicit optional-object construction instead of empty-object spreads. Targeted disables remain only at Pi `ToolDefinition.execute`, JSON.stringify encode, Reflect.apply schema-rejection tests, and untyped Pi TUI test doubles. `bun run check` is green.

**Profile-owned extension admission.** Restored the Profile as an executable extension owner without enabling ambient Pi discovery. A selected ID now resolves from `<profile>/extensions/<id>/` before the bundled repository catalogue, while the existing `extensions.json` remains the explicit admission authority and unselected broken packages cannot block runtime startup. The TUI merges Profile-owned and catalogue choices with Profile precedence; CLI add validates either source, and remove can recover a selected ID after its catalogue package is retired. Updated the required authoring guidance to create generated packages only inside the Profile and aligned the architecture and standalone-executable plans. Focused filesystem, application, TUI, and real Pi loading tests prove a Profile-only tool package, Profile-over-catalogue collision precedence, stale-selection recovery, canonical selection, and existing catalogue behavior.

**Self-improvement package consolidation.** Replaced the four overlapping repository packages `self-improving-agent`, `smart-memory`, `skill-curator`, and `skill-creator` with the single optional `self-improvement` package. Updated the complete Pi catalog and helper-test command so retired package paths and Curator tool names cannot remain as runtime or test dependencies. The package catalog guidance now distinguishes bundled packages from Profile-owned installs and documents the replacement's bounded learning boundary.

**CLI catalogue, Curator automation, and Profile-local install.** Added a Schema-decoded embedded `catalog.json`, Profile-only staged package installation, checksum-pinned GitHub archive support, safe source-tree validation, and a fail-closed standalone-only `ziggy update`. Package manifests may declare Ziggy-owned automation templates; add installs them without overwriting either lifecycle form, and remove pauses only definitions carrying the matching extension owner. The new `self-improvement` package observes three distinct successful foreground sessions before arming a UTC Curator automation, writes visible dated Markdown logs plus compact state, uses native `[learned]` memory entries, and can create or hash-fenced update only Profile-local Curator-managed skill packages. Squarey was installed through the real CLI and a fresh resource load resolved both extension and skill paths from its Profile while its running resident, existing memory, SOUL, and weather automation remained untouched.

**TUI catalogue lifecycle slice.** Routed the existing `/extensions` checklist through the same catalogue operations used by the CLI. The selector now labels bundled, GitHub-approved, and Profile-local choices; installs newly selected catalogue entries before the single canonical selection write; and deactivates extension-owned automations before removing their IDs. Pi receives the catalogue capability at runtime construction, Profile-owned packages retain display precedence, and the TUI still requires reopening because its resource paths are fixed when the Pi runtime is created. Focused tests cover a catalogue-only install, Profile precedence, lifecycle calls, and the unchanged full-set selection contract.

**Single catalogue authority slice.** Populated repository-root `catalog.json` with every approved bundled package and made it the only approval and listing source. The repository `extensions/` folder is now package storage rather than an implicitly scanned catalogue: list/show expose only approved entries, installs reject unlisted repository folders, and runtime selection accepts either an approved ID or a real Profile-local package. CLI and TUI retain the same small list/show/add/remove lifecycle, while `extensions.json` remains only the Profile's active-selection record.

**GitHub catalogue standalone implementation plan.** Replaced the obsolete static-optional-extension executable packet with one selected local-first plan. The target executable compiles Ziggy, Pi, Effect, TypeBox, and two core skills; reads public metadata from GitHub `catalog.json`; installs immutable checksum-pinned extension assets only into Profiles; loads installed packages offline; and self-launches without Bun or the checkout. The packet records requirements, authority, schemas, archive/import limits, a complete CLI/TUI/runtime/release breadboard, nine demonstrable vertical slices, logical commit boundaries, public GitHub bootstrap order, clean-room and Squarey gates, rollback rules, and the later Durable Object plus Bun Container handoff.

**Catalog and self-improvement type-safety cleanup.** Renamed leftover Effect service `*Shape` APIs to `*Api` (`ExtensionArchiveClientApi`, `ExtensionCatalogApi`, `ZiggyReleaseClientApi`, `SelfUpdateApi`, `PiAgentApi`) so `ziggy/no-shape-in-symbol-names` stays an error. Removed a leftover conflict marker in `src/adapters/pi/pi-agent.ts`. Kept catalog wiring for `extensionCatalog` in Pi runtime construction on the existing mutable `ProfileRuntimeResourceLoaderOptions` builder without empty-object spreads. Put automation `owner` onto the `Object.fromEntries` optional-field construction in `src/domain/automation.ts`. In `extensions/self-improvement`, replaced runtime `typeof` / `Record<string, unknown>` probes with Typebox `Check` at JSON/frontmatter/session-entry boundaries, named `SessionEntry` / `ReviewLogInput` / `ExtensionWriteInput`, and built optional tool inputs in separate statements instead of conditional empty-object spreads. `bun run check` is green.

**Compile-in bundled extensions.** Restored the compile-all decision: approved shelf packages are generated into the executable instead of being copied from a checkout or downloaded from GitHub. A catalog generator emits metadata, Bun `type: "file"` embeds, and Pi factory imports. `extensions list/show` read that metadata; `extensions add` selects an ID already in the binary and provisions owned automations from embedded files without copying the package. Runtime loads Profile-owned paths plus selected bundled factories and embedded skills, with required `pi-packages`, `extension-authoring`, and `ziggy-operations`. Profile-local packages still win on collision.

**Compile-in skill copy.** Corrected required `pi-packages` guidance so `extensions add` selects a compiled ID and provisions owned automations from embeds instead of installing an approved remote package into the Profile.

**Compile-in Squarey executable.** `skills list/add` now read generated bundled metadata and copy skill files from embeds; they no longer scan a checkout. Compiled factories load helper scripts through Bun `type: "file"` imports (AppleScript, Python, and wrapper bins). Removed Squarey's Profile-local `self-improvement` copy so the selected ID loads from the executable. Replaced `/Users/yesh/commands/ziggy` with the compiled Mach-O (old bun launcher backed up at `/tmp/ziggy-commands-backup-f3a46e66`). Launchd now self-launches `[ziggy, serve, squarey]`. Live Squarey `doctor` reports `3 bundled factories, 0 Profile extension entrypoints`; Discord and Slack connected. Human SOUL, memory, selection, and Curator automation bytes were unchanged.

**Compiled TUI theme embeds.** Added `src/adapters/pi/tui-themes.ts` to Bun-embed Pi's builtin `theme/dark.json` and `theme/light.json` from the package `dist/` layout. Bun compile flattens those `type: "file"` JSON imports to hashed names under `/$bunfs/root`, and `copyFileSync` cannot read that filesystem, so compiled `openTui` `readFileSync`s the embeds, writes a temp `theme/` layout, and sets `PI_PACKAGE_DIR` only in that process. Source mode leaves the env unset. `providerError()` no longer maps TUI/runtime throws to a missing `models.json`; `"open interactive mode"` prints the real cause. AppleScript stays a factory helper, not a skill file. Replaced `/Users/yesh/commands/ziggy` with the new Mach-O (previous backup `/tmp/ziggy-commands-backup-tui-themes`) and ad-hoc re-signed it because in-place replace of the running launchd path was SIGKILL until `codesign -s - --force`. Compiled Squarey TUI opened (`Ziggy · squarey`); doctor still green; SOUL, MEMORY, selection, and Curator automation hashes unchanged. Resident serve left on the previous process.

**Squarey default model to DeepSeek Flash.** Pointed Squarey at `opencode-go/deepseek-v4-flash` with thinking `high`, matching the `pideep` alias. Profile already had an `opencode-go` API key; no credential rewrite. Doctor resolves that model with auth configured. Restarted the Squarey resident so Discord and Slack pick it up.

**Profile model remains authoritative on reopen.** `ziggy models set` writes only the Profile's Pi-managed `settings.json`; it never rewrites historical session JSONL. Every newly constructed Ziggy runtime now passes that configured model and thinking level explicitly to Pi, so new and resumed TUI or gateway sessions consistently adopt the Profile selection instead of restoring an older transcript model. Already-running in-memory chats retain their current model until their TUI is reopened or their resident process restarts.

**Pi family upgrade to 0.84.1.** Pinned `@earendil-works/pi-coding-agent@0.84.1` and refreshed the lockfile so `pi-agent-core`, `pi-ai`, `pi-tui`, and the new `pi-client`/`pi-protocol`/`pi-telemetry` members resolve at 0.84.1. Extension peer pins now match that coding-agent version and Pi's bundled `typebox@1.3.7`. AGENTS.md and the spec pin facts were updated; in-process `message_update` still carries cumulative `message`, builtin theme paths are unchanged, and no adapter source repair was required. Existing compile-all catalog and Profile-authoritative model/TUI-theme work was left in the dirty tree. Not committed; Squarey binary and `~/.ziggy` were not touched.

**Compiled Pi TUI asset lease and provider bootstrap.** Compiled `openTui` now leases Pi 0.84.1 builtin theme, clankolas, and export-html embeds into a temporary `PI_PACKAGE_DIR` layout, restores env, and removes the tree on exit; source mode still leaves Pi's npm layout. Compiled Ziggy startup registers Bun OAuth flows and the Bedrock provider, and redirects only missing Photon WASM reads to the embedded file. Source mode keeps Pi's npm layout and filesystem behavior.

**Offline pinned Pi docs lookup.** Generator `tooling/generate-pi-docs.mjs` embeds `@earendil-works/pi-coding-agent@0.84.1` `README.md` plus `docs/*.md` as Bun file assets (no examples, images, source, or network). Hidden `pi_docs` (list/search/read) reads those embeds with query/path/line/result/byte bounds. Every Profile runtime registers the factory; `bun run check` includes `--check` drift. SOUL and core skills were not changed.

**Standalone compile-all build and clean-room smoke.** Added `tooling/build-standalone-executable.mjs` (`build:binary` / `build:binary:dev`) and `tooling/smoke-standalone-executable.mjs` against the current compile-all architecture: no source manifests or `source_lookup`. Development builds record dirty worktree entries; release still requires a clean tree. The sidecar records artifact identity, Bun 1.3.13 / darwin-arm64 compile args, lock/catalog/Pi-docs fingerprints, and `releaseReady`. Smoke copies only the binary, isolates HOME/TMPDIR/XDG/ZIGGY_HOME/PATH, denies network and every git worktree, and checks real CLI list/show/add for bundled `self-improvement` without a Profile copy, plus copied-binary `skills add <profile> curator` materializing SKILL.md bytes. Doctor now reports readable pinned Pi docs version/fingerprint/count. `/dist/` is ignored. Did not install a binary, edit `~/.ziggy`, restart Squarey, or commit.

**Compiled bundled skill copy.** `copyBundledSkill` now stages Bun/embedded skill files with `readFile` + `writeFile` (preserving mode) instead of `copyFile`, which ENOENTs on compiled `$bunfs`. Atomic staging, collision, and `--force` semantics are unchanged. Focused profile test asserts curator/here-now destination bytes; smoke scripts `smoke:binary` and `smoke:binary:dev` were added.

**Installed the verified Pi 0.84.1 binary for Squarey.** Built the dirty-tree development artifact, passed 433 tests, the full check, and checkout/network-denied one-file smoke, then ad-hoc signed and atomically installed it at `/Users/yesh/commands/ziggy`. Reapplied `opencode-go/deepseek-v4-flash` with thinking `high` through `ziggy models set` and restarted the managed resident. Doctor reports embedded Pi 0.84.1 docs, compiled factories/skills, configured auth, and connected Discord/Slack with empty queues. The prior binary is recoverable at `/Users/yesh/commands/ziggy.backup-20260813T160031Z`.

**Console Go tool-schema compatibility.** Kept the `pi_docs` action union and its branch-specific validation, while adding the redundant top-level `type: "object"` assertion required by Console Go's function-schema contract. Added a focused wire-schema regression test; the Pi docs tests and full `bun run check` are green.

**Profile AGENTS.md and no agent pi_docs.** Ziggy-owned `skills/AGENTS.md` is inlined as the first system-prompt block, then Profile `SOUL.md`. Profile and specialist runtimes no longer register `pi_docs`; the factory remains for explicit tests and doctor still checks the compile pin. Reminders `$bunfs`/osascript handoff is unchanged for a later block.

**Hunk notes on AGENTS.md / profile-prompt.** `ziggy-operations` now points at serve, gateway, or automations. Prompt file reads use Effect `FileSystem.readFileString` with `BunFileSystem.layer` at this adapter; `Effect.tryPromise` around `node:fs/promises` is gone.

**Compiled Apple Reminders host path.** The bundled tools now copy a `$bunfs` AppleScript onto a real temp file before `/usr/bin/osascript`. Source checkouts keep the checkout path. Live Squarey still needs the Profile override removed, a binary reinstall, and a resident restart.

**Squarey Slack Reminders / extension-authoring.** Today's Slack thread was Apple Reminders, not Daily authoring. Squarey's core prompt is `SOUL.md` plus skill _metadata_, not Pi's default docs prompt; `extension-authoring` was listed but unread until the user asked. The model read `pi_docs` `docs/extensions.md` and wrote `.pi/`, then asked for `/reload`. Notes: `docs/research/daily-slack-extension-authoring.md`. The skill description now names `extensions/<id>/` as the write path.

**AGENTS.md out of the skill tree.** Moved the always-on prompt from `skills/AGENTS.md` to `src/adapters/pi/AGENTS.md` so Pi does not treat it as a skill when the repository `skills/` directory is loaded.

**Plugin-first core study.** Staged the supplied reference image and DeepSeek Harness commit `47f9438` under `/tmp/ziggy-deepseek-exploration`, then compared its plugin discipline with Ziggy, the local Pi SDK, ACP, and the local OpenAI Codex app-server snapshot. Reframed `docs/research/deepseek-harness-ziggy-pluggability.md` around the actual goal: one clear Ziggy core, Pi extensions for hooks and allowed overrides, and complete client control for custom TUI/GUI/web/editor/channel clients. The study records Pi's existing prompt/steer/follow-up/abort/compact/event/session controls and exact tool precedence; corrects the false claim that automation creation commands were missing; removes speculative product registries; pinpoints the duplicate, implicit runtime assembly order; defines main/fresh/resume/pin/join session meanings; inventories existing automation/model/auth/extension/doctor/serve services; and selects an internal Effect core plus a Ziggy app server, with ACP as an optional conversation adapter rather than the full management protocol. Earlier focused verification ran 73 Pi/channel tests with zero failures.

**Installed Squarey binary at 0d6e3c0.** Release `dist/ziggy` (sha `1f13fde5…`, smoke pass) ad-hoc signed and installed at `/Users/yesh/commands/ziggy`. Removed Squarey's skill-only `extensions/apple-reminders/` override so the bundled factory loads. Restarted the managed resident (pid 66592). Doctor: 3 bundled factories, 0 Profile extension entrypoints, Discord and Slack connected. Prior binary: `/Users/yesh/commands/ziggy.backup-20260815T000551Z`.

## 2026-08-14

**Removed leftover repo-root skills.** Deleted the unshipped daily-routine and Google trees from `skills/` (`morning-brief`, `evening-winddown`, `weekly-review`, `news-digest`, `workday-start`, `gratitude-journal`, `google-calendar`, `google-mail`, `google-workspace`). They never entered `BUILTIN_CORE_SKILLS`, `catalog.json`, or production `skillPaths`. Required core skills remain `extension-authoring` and `ziggy-operations`. Catalog generator and resources test now fail if `skills/` grows extra dirs.

**Effect-shaped test tree.** Moved the 59 colocated `src/**/*.test.ts` files into a parallel `test/` tree (`src/adapters/pi/auth.test.ts` → `test/adapters/pi/auth.test.ts`). Tests now import Ziggy source the way Effect imports `effect/Deferred`: `package.json` `exports` map `./*` → `./src/*.ts`, so tests say `from "ziggy/adapters/pi/auth"` instead of `../../`. Extensions and `tooling/` tests stayed put. `bunfig.toml`, lint/fmt/typecheck globs, and the standalone build test gate now point at `test/`. Oxlint treats `test/adapters/` like the old colocated adapter tests so existing disables keep working. Production source was not rewritten. Deleted the leftover colocated `src/adapters/pi/resources.test.ts`, recorded the layout in AGENTS.md and the effect-tests skill, and retargeted Ziggy-owned plan/research test paths and `bun test` commands.

**Installed Squarey binary at 136ccfc.** Release `dist/ziggy` (sha `86bf7b62…`, smoke pass) ad-hoc signed and installed at `/Users/yesh/commands/ziggy`. Restarted the managed resident (pid 60235). Doctor: 3 bundled factories, 0 Profile extension entrypoints, Discord and Slack connected. Prior binary: `/Users/yesh/commands/ziggy.backup-20260815T010348Z`.

**Slack Thinking Steps DM cards.** Wrapped `chat.startStream` / `appendStream` / `stopStream` in the Slack HTTP adapter with plan-mode `task_update` chunks (256-char bounds). The Slack gateway maps existing Pi tool progress events onto that stream in DMs only, stops the stream before the final `chat.update` answer, and keeps today's placeholder path if native start fails. Core agent/Pi/Discord contracts were not changed. Channel recipient identity is still out.

**Slack Thinking Steps channel cards.** Socket Mode now copies workspace `team_id` onto inbound messages. Channel turns start the same plan stream with `recipient_user_id` and `recipient_team_id`, serialize start/append/stop, never retry an ambiguous start, and always `stopStream` on success, failure, or cancel. Missing team identity keeps today's placeholder path. DMs still omit recipient fields. Core agent/Pi/Discord contracts were not changed.

**Installed Squarey thinking-steps binary.** Dirty-tree development `dist/ziggy` (build sha `73779956…`, smoke pass, ad-hoc signed install sha `b0c584b1…`) replaced `/Users/yesh/commands/ziggy`. Restarted the managed resident (pid 81813). Doctor: 3 bundled factories, 0 Profile extension entrypoints, Discord and Slack connected with empty queues. Prior binary: `/Users/yesh/commands/ziggy.backup-20260815T030832Z`.

**Slack Thinking Steps readable cards.** Live `#daily` proof showed raw `bash`/`read` labels and Slack's plan `error` status as "something went wrong". Cards now use human titles plus a bounded command/path detail, keep that detail through Pi's arg-less tool-end events, mark finished tools complete even when the tool itself failed, and open the plan as `Working` instead of Slack's generic finding-answers chrome.

**Profile-visible extension packages.** `extensions add` now copies the whole bundled package tree onto `<profile>/extensions/<id>/`. Runtime and doctor materialize required `pi-packages` / `extension-authoring` / `ziggy-operations` plus every selected ID from those Profile folders — no `$bunfs` skill paths, no compiled factories for selected packages. Helper scripts resolve with `import.meta.dirname`. Apple Reminders talks to the on-disk AppleScript directly; the `$bunfs` copy-out is gone. Removed `ziggy skills add/list`; skills live inside extensions. Bundled package bytes are generated under `src/generated/embedded/` so `type: "file"` embeds do not shadow live extension modules. Focused tests, smoke, and package docs follow the copy-then-load contract.

## 2026-08-15

**Installed Squarey Profile-extension binary.** Release `dist/ziggy` at `ad11698` (build sha `faf12144…`, smoke pass, ad-hoc signed install sha `4881a256…`) replaced `/Users/yesh/commands/ziggy`. Restarted the managed resident (pid 91743). Doctor: 0 bundled factories, 3 Profile extension entrypoints, 9 skill roots; Discord and Slack connected with empty queues. Squarey `extensions/` now holds the six selected packages plus required `pi-packages` / `extension-authoring` / `ziggy-operations`, including a real `apple-reminders` `SKILL.md`. Prior binary: `/Users/yesh/commands/ziggy.backup-20260815T121401Z`.

**Required skills are packages.** Moved `extension-authoring` and `ziggy-operations` from repository-root `skills/` into `extensions/` as skill-only required packages, same shape as `pi-packages`. Runtime materialize/load, add/remove reservation, and the catalog generator now share one required-ID set. `BUILTIN_CORE_SKILLS` and `installRequiredSkill` are gone.

**CLI+filesystem UI-hook research.** Compared Grok Bot, Grok Build, and Hermes desktop/bot mode to Ziggy's CLI, Profile files, and `ZiggyAgent`. Notes: `docs/research/ui-cli-filesystem-hooks.md`. Management UIs can ship on files+CLI; a live chat GUI cannot until a session protocol (complete ChatHandle, then app server / ACP) exists. Aligns with the 2026-08-13 pluggability study. Scout follow-up: Hermes-Bot-Mode is a desktop plugin over `hermes serve` JSON-RPC (`/api/ws`); Pi RPC is NDJSON not JSON-RPC and unused; `ziggy run` streams unframed text only; `USER.md` is unimplemented.

**Automation model override.** Automations may set optional `provider`, `model`, and `thinking` frontmatter. Omitted fields inherit the Profile default; `provider`/`model` must appear together. Untagged runs pass the override into `openChat` so the session is constructed with that model. `@agent-id` still delegates to the Profile agent and ignores automation model fields. Registry/auth/thinking checks fail the run instead of falling back. Schema shape follows Effect 4.0.0-beta.99: `optionalKey` (exact optional, not `undefined`), pairing via `Struct.check(Schema.makeFilter(...))`, and `ChatModelOverride` inferred from that schema. Thinking support is checked only when frontmatter overrides provider/model or thinking; Profile default thinking still opens ordinary sessions the way it did before.

**Installed Squarey required-package binary.** Release `dist/ziggy` at `e5233dc` (build sha `1049c647…`, smoke pass, ad-hoc signed install sha `0c855f0e…`) replaced `/Users/yesh/commands/ziggy`. Restarted the managed resident (pid 2625). Doctor: 0 bundled factories, 3 Profile extension entrypoints, 9 skill roots; Discord and Slack connected with empty queues. Squarey `extensions/` still has the six selected packages plus required `extension-authoring` / `pi-packages` / `ziggy-operations`. Prior binary: `/Users/yesh/commands/ziggy.backup-20260815T124742Z`.

**Proactive Curator plan.** Packet: `docs/plans/proactive-curator.md`. Six slices: review policy, pending queue, skip-empty broadcast, 15-minute gated cron, adopt, select-on-create. Memory = facts; learnings about a kind of work = skill-only Profile extensions. Foreground TUI + gateway chats only. Next `openChat` sees new packages; no Squarey process restart. Idle archive/prune is out unless an event log proves a fault.

## 2026-08-15

**Hermes turn-queue scout.** Desktop (`hermes serve`) and messaging (`hermes gateway`) are separate processes with no shared live-turn lock; queues are per session key. Ziggy already serializes per `chatKey` inside one `serve`. Recorded in `docs/research/ui-cli-filesystem-hooks.md`. Do not copy Hermes’ process split. GUI must not attach to Slack sessions.

**Can Bun be WASM? research.** Question: could compiling "Bun to WASM" let a Bun app run on WASM/JS-only serverless (Cloudflare Workers)? Findings in `docs/research/can-bun-be-wasm.md`, verified against primary sources (bun.sh/bun.com docs, oven-sh/bun + WebKit source, Bytecode Alliance, Cloudflare docs, StackBlitz/Shopify engineering). Verdict: no — `bun build` has no wasm target (CompileTarget.zig literally errors "invalid target, WebAssembly is not supported. Sorry!"), no WASI build of the Bun runtime exists or is planned (maintainers decline browser/wasm), and a JSC-based port would lose every OS-shaped capability (spawn, real fs, bun:sqlite, native addons, TLS, threads). Realistic serverless routes remain: bundle-to-JS on workerd (pi's child_process/fs/TTY blockers already documented in `bun-on-cloudflare.md`), JS-in-wasm components (StarlingMonkey/ComponentizeJS — web APIs only), or Cloudflare Containers for actual Bun. No code changes.

**Installed Squarey model-override binary.** Dirty-tree development `dist/ziggy` at `32609a5` plus override-only thinking check (build sha `39dfbfa6…`, ad-hoc signed install sha `efda04dd…`) replaced `/Users/yesh/commands/ziggy`. Restarted the managed resident (pid 2216). `morning-weather` now validates. Manual wake completed on `opencode-go` / `deepseek-v4-flash` / thinking `max` and delivered to Slack `C0A06UL1CKW`. Earlier 10:18 wakes failed `AutomationInvalid` on the previous binary. Prior binary: `/Users/yesh/commands/ziggy.backup-20260815T142500Z`.

**Squarey Slack automation loop.** Asking Squarey in Slack to run weather used `ziggy-operations` → `ziggy automations list/validate/wake`. Slack bash PATH is launchd-narrow (`/usr/bin:/bin`, no `~/.local/bin`), so `ziggy` exits 127; after finding `/Users/yesh/commands/ziggy` the old binary then exited 1 on unknown `provider`/`model`/`thinking`. Slack labels any bash `isError` as “didn't complete”. Not a gateway-owner deadlock: list/validate are filesystem-only. Leftover: Profile `extensions/ziggy-operations` still lacks the Model override section because `ensureInstalled` skips an existing package folder.

**Shared ChatHandle shipped.** Faces now share one in-process chat API: `prompt`, `abort`, `steer`, `followUp`, `subscribe`, and `isIdle`. Events are a small Ziggy union (text, thinking, tool, settled, error). Steer/follow-up fail closed while idle. Slack `/stop`, Discord stop, and new Telegram owner `stop`/`/stop` call `handle.abort`. Telegram stop does not take the per-chat semaphore. Session folders stay per face. Automations stay files + `wake`. Socket publish for an out-of-process GUI is a later packet.

**pi-intercom vs discuss.** Notes: `docs/research/pi-intercom.md`. Live 1:1 is a local broker + `pi.sendMessage` (idle trigger / busy steer). Ziggy `agent_discuss` already runs on Slack/gateway parent chats (one synthesized reply). Do not copy the broker into `serve`; add a `LiveChatRegistry` over `ChatHandle`. npm `pi-intercom` is not a drop-in (`@ziggy/{id}`, global broker). TUI-to-TUI needs a fork.

**Mention autocomplete vs OpenClaw/Hermes.** Fresh `opensrc` trees: OpenClaw `2026.8.1`, Hermes Agent `0.20.1`. Notes: `docs/research/openclaw-hermes-mention-autocomplete.md`. Slack/Discord native `@` still only lists people and apps. `/` completes commands (Hermes: every registry command; OpenClaw: `/openclaw` or native slashes). Hermes TUI completes `@<profile>`; classic CLI `@` is files. OpenClaw picks agents with `Ctrl+G` / Control UI, not `@`. Native `@reviewer` still means a second bot app.

**Specialist voices and rails plan.** Packet: `docs/plans/specialist-voices-and-rails.md`. Gateway stays model-guided `agent_run` / `agent_discuss` (no Slack `@` picker). Four vertical slices: visible discuss voices on Slack, visible `agent_run` voice, Discord+Telegram, then local specialist `ChatHandle` rails under `sessions/local/agents/<id>/`. GUI/socket still a later packet.

**Specialist voices (slices 1–3).** `ChatEvent` now has `kind: "voice"`. `agent_run` success and each `agent_discuss` participant emit the child answer through a small hub on the Profile runtime; Slack, Discord, and Telegram post `**id:**` labeled messages during the in-flight prompt, then the parent wrap still lands. Prompt guidance tells the parent to `agent_run` a matching specialist without waiting for `@`.

**Specialist rails (slice 4).** `openSpecialistChat` continues a specialist `ChatHandle` under `sessions/local/agents/<id>/` using `agents/<id>.md` policy. Unknown ids fail before a session folder is created. `ziggy agents run` stays a fresh UUID root.

**Squarey live rails + voices.** Against `/Users/yesh/.ziggy/profiles/squarey`: unknown id `missing` failed `SpecialistAgentNotFound` with no session folder. Two reviewer prompts continued one JSONL under `sessions/local/agents/reviewer/` (`ok` then `still`). Parent `openChat` on `sessions/local/voice-proof` (not Slack) ran `agent_discuss` reviewer+writer and subscribed two `kind: "voice"` events. Slack sessions were not written. Added `agents/reviewer.md` and `agents/writer.md` so the catalog is non-empty.

**Effect alignment on specialist rails.** `openSpecialistChat` now brackets the in-memory selection runtime with `Effect.acquireUseRelease` (same shape as `runSpecialist`); live session still lives on `ChatHandle.dispose`. `makeSessionChatHandle` unsubscribes session/voice listeners before Pi teardown. Unknown-id tests assert `Exit.fail(new SpecialistAgentNotFound(...))`.

**Installed Squarey voices/rails binary.** Release `dist/ziggy` at `f9a9159` (build sha `34d838bf…`, smoke pass, ad-hoc signed install sha `80666f43…`) replaced `/Users/yesh/commands/ziggy`. Restarted the managed resident (pid 80307). Doctor: 0 bundled factories, 3 Profile extension entrypoints, 9 skill roots, 2 Profile agent files; Discord and Slack connected with empty queues. Prior binary: `/Users/yesh/commands/ziggy.backup-20260815T175855Z`.

**Versioned 0.1.0 with a changelog.** `package.json` was already `0.1.0` and `ziggy version` already printed it. Added Keep a Changelog `CHANGELOG.md` as the 0.1.0 baseline, linked it from README, made doctor report `Ziggy 0.1.0`, and pointed standalone smoke at `package.json` instead of a hardcoded version string. Future releases append under `[Unreleased]` then cut a new section.

**Curl-installable GitHub release.** `scripts/install.sh` downloads checksum-pinned `ziggy-darwin-arm64` from GitHub Releases into `~/.local/bin/ziggy` and refuses to overwrite a symlink. Tag workflow `.github/workflows/release.yml` publishes that asset, its SHA-256, and the installer. `ziggy update` already used the same URL shape. 0.1.0 is macOS Apple Silicon only.

**MIT licensing.** Added the standard MIT license under Yeshwanthyk and declared it in `package.json`.

**Machine-readable CLI.** Added schema-owned JSON output for Profile, extension, agent, automation, and transcript-free session metadata. `ziggy run --json` now selects Pi's pinned NDJSON print mode, while `ziggy run --session <id>` resolves only an exact session id and opens that exact JSONL file even when a newer sibling exists. `--` preserves option-like prompt text and `--continue` cannot combine with exact resume. Added the reviewed Open Ziggy implementation packet with corrected session, UI ownership, transport, and ACP contracts.

**Recoverable Profile memory.** Non-minimal init now creates private, idempotent shared, person, and group memory scaffolding without overwriting human files. New `ziggy memory list|show` text and schema-owned JSON views report admitted documents, entry counts, Unicode code-point usage, and empty versus missing state. Existing-document writes take an exact-byte 0600 backup inside the document lock, retain the newest ten, and fail closed on backup, symlink, or unsafe-path errors. Added the memory operations guide and focused init, inventory, path-safety, backup, retention, and doctor tests.

**Serve-owned local UI gateway.** `ziggy serve` now publishes a private loopback WebSocket endpoint in an atomic `0600` Profile projection. Authenticated local clients can list stored and live sessions, open bounded `ui/*` chats, watch future events, and submit, steer, or abort UI turns. One serve-owned registry shares concurrent opens and prompt ownership across sockets, keeps admitted turns alive across disconnects, exposes channel chats as watch-only aliases, and disposes UI handles before the owner lease is released. The transport enforces strict schemas, text/frame/request/backpressure limits, and conditional projection cleanup; a UI-only failure is isolated from scheduler and channel loops.

**ACP v1 face.** Added `ziggy acp <profile> [--shared]` on the official `@agentclientprotocol/sdk@1.3.0` stable API and UTF-8 NDJSON stdio transport. The prompt-only face advertises no optional client capabilities, creates isolated `sessions/acp/<id>/` chats, accepts baseline text and resource links, streams ordered assistant deltas, and supports concurrent cancellation. Default sessions use local owner memory; `--shared` uses `group:acp-<sessionId>` so shared Zed/Buzz-style harnesses never receive owner memory. SDK callbacks enter a scoped concurrent Effect dispatcher, all handles are disposed once, and stdout remains protocol-only. Buzz uses this ACP command; no Buzz gateway was added.

**Typed gateway client and example.** Added the isolated, dependency-free `@ziggy/gateway-client` package with typed v1 requests, response matching, timeout errors, pushed events, capped reconnects, and automatic watch restoration. Its focused fake-socket tests cover out-of-order responses, event dispatch, timeout, and reconnect behavior. A small browser signal desk shows live and stored sessions, opens `ui/*` chats, streams replies, and watches channel events; it bundles directly with Bun and connects only to the loopback gateway using a pasted Profile token.

**Versioned 0.2.0.** Promoted the open-readiness slices into the 0.2.0 changelog: machine-readable CLI output and exact resume, recoverable memory, the serve-owned UI gateway, the typed gateway client and browser example, ACP v1 for Zed/Buzz-style clients, and MIT licensing. Product version output, doctor, ACP identity, README, and the macOS Apple Silicon installer message now agree on 0.2.0.

**Profile extension identity separation.** Profile shelf IDs and `extensions.json` keys remain lowercase kebab-case Ziggy identities, while `package.json.name` is now independent nonblank upstream metadata. The exact `computer-use` / `@injaneity/pi-computer-use` pair passes Profile discovery and Pi's real resource loader; blank package names still fail closed. Updated authoring/package guidance and regenerated embedded resources without changing the self-improvement curator convention or bundled-catalog naming policy.

**Transactional Profile extension lifecycle.** Replaced the split `ExtensionCatalogService` plus `Profiles` mutation path with one Effect-native `ProfileExtensions` authority used by CLI, TUI selection, doctor, and Pi runtime preparation. Extension changes now serialize across processes through a Profile-local SQLite mutex, validate exact filesystem and automation ownership, run the production-shaped Pi loader before selection, preserve exact `extensions.json` bytes or absence on rollback, and restore newly installed versus previously paused automations to their prior state. Runtime activation is fenced by the exact selection generation and occurs only after actual Pi diagnostics pass; activation failure disposes the new runtime and reports typed rollback uncertainty. Doctor validation is read-only, stale valid IDs remain removable, malformed IDs fail at the boundary, and CLI failures expose bounded lifecycle stage/reason. Focused Slice 2 proof: 92 tests; `bun run check` green.

**First-class Profile extension operations.** Added an in-process `profile_extensions` Pi tool for list/add/remove/validate that delegates directly to the transactional `ProfileExtensions` service without Bash, PATH lookup, child Ziggy processes, or direct selection-file mutation. Parent TUI, print, gateway, and automation runtimes receive the tool while specialist children do not. TUI, resident UI, and the typed browser gateway client now share bounded structured lifecycle failures; active extension-authoring guidance requires the tool and forbids shell-based admission. GitHub URL import and automatic runtime rollover remain later slices. Slice 3 proof: 64 focused root tests and 8 gateway-client tests passed; gateway-client typecheck, `bun run check`, and `git diff --check` green.

**Canonical install and managed-service PATH hardening.** Kept the checksum-verified, symlink-safe curl installer targeting `~/.local/bin/ziggy`; launchd and systemd service renderers now publish deterministic `HOME`, `ZIGGY_HOME`, and user-command `PATH` values while retaining an absolute Ziggy executable. Managed-service fixtures prove commands resolve from `~/.local/bin`, and the disposable standalone resident smoke verifies the rendered executable without installing or starting a real service. README and operations guidance distinguish this executable PATH support from the in-process `profile_extensions` lifecycle, which never depends on PATH. Slice 6 proof: 11 focused tests, installer shell syntax, scoped format/lint, standalone smoke, and `git diff --check` green.

**Ziggy 0.2.1 release metadata.** Bumped the package, README, installer, doctor, and ACP identities; documented transactional extension lifecycle/identity, in-process `profile_extensions` face parity, third-party adoption guardrails, and managed-service PATH hardening; updated changelog compare links. No source behavior changed; skill embeds file24/file76/file105 were regenerated while catalog metadata/index mappings remained unchanged.

**Anti-slop alignment and client quality gate.** Confirmed Ziggy already actively ports all fifteen upstream anti-slop rules under `ziggy/*` alongside its stricter TypeScript rule, removed the temporary dormant installer skill, and recorded the source comparison in `docs/research/anti-slop-alignment.md`. Added a boundary-scoped gateway-client lint policy plus root check coverage for its lint, typecheck, and tests; replaced avoidable client assertions while retaining documented boundary evidence. Restored upstream mapped/conditional-infer lexical type-parameter fidelity for object-parameter and unknown-return rules, with focused CLI-fixture parity tests for lexical scope, Reflect ownership, strict runtime `typeof`, assertions, unknown causes, unsafe dictionaries, and module mocking.

## 2026-08-16

**Ziggy 0.2.2 release metadata.** Bumped the package, README, installer, doctor, and ACP identities from 0.2.1 to 0.2.2; documented the post-0.2.1 anti-slop alignment (gateway-client scoped lint/typecheck/test root gate, restored mapped/conditional-infer lexical fidelity, focused local rule parity tests, no duplicate plugin/dependency) in the changelog; updated compare links. No source behavior changed.

## 2026-08-18

**ACP session model announce for Buzz.** Extended `ziggy acp`'s session/new response with Buzz's unstable SessionModelState: `availableModels` (provider/model ids) and `currentModelId`, sourced from the profile's auth-configured models (`ModelRuntime.getAvailable()` — the auth.json ∩ models-store intersection, via a new read-only `available` surface on the Pi models adapter and `ModelsApi.available`). Added a custom `session/set_model` request handler that validates `provider/model` against the profile's authed models and records the per-session selection (invalid-params on unknown models/sessions). `runAcp` now receives the Models service from main. Focused test asserts the announce shape and set_model validation; all ACP/models tests green, `bun run check` passes.

**Ziggy 0.2.3 release metadata.** Bumped the package, README, installer, doctor, and ACP identities from 0.2.2 to 0.2.3; documented the ACP SessionModelState announce and `session/set_model` handler in the changelog. No source behavior changed.

**ACP specialist routing for Buzz.** Added `ziggy acp <name|path> [--shared] [--agent <agent-id>]` so an ACP session can open a Profile specialist (`openSpecialistChat`) instead of the default persona. Buzz can model one agent row per specialist using the same `ziggy-squarey` harness with per-agent `agent_args: ["--agent", "ada"]` — no additional custom-harness files. CLI parsing, help, ACP face routing, and a routing test updated; `bun run check` green.

**Ziggy 0.2.4 release metadata.** Bumped the package, README, installer, doctor, and ACP identities from 0.2.3 to 0.2.4; documented ACP specialist routing (`--agent`) and the Buzz operations guide in the changelog. No source behavior changed.

**Knip structural cleanup gate.** Added a repository-shaped Knip configuration covering Ziggy runtime, tests, extensions, clients, and tooling without scanning the vendored Effect submodule. The focused files/exports/types audit now runs inside `bun run check`. Removed the unused lossless-claw refresh wrapper and made internally owned helper schemas, types, and lint utilities private; runtime behavior and public package entrypoints are unchanged.

**Profile validity aligned.** Profile initialization now rejects a symlinked Profile root instead of following it, and Profile listing admits only a physical directory containing a regular non-symlink `SOUL.md`, matching doctor and downstream filesystem boundaries. Focused resolver tests pin bare-name, explicit path, tilde, current-directory, default-home, and `ZIGGY_HOME` behavior. Existing human-owned Profile bytes and registry pruning behavior are unchanged.

## 2026-08-23

**Optional confined MCP Code Mode.** Added the self-contained `codemode` Pi package with one collision-resistant `codemode_execute` tool. JavaScript is parsed with Acorn and evaluated by an in-process tree-walking orchestration interpreter adapted from OpenCode's MIT-licensed Code Mode design; no source reaches eval, vm, a shell, imports, or a general JavaScript runtime. Strict Profile decoding atomically opens a physical regular `codemode.json` with the platform no-follow flag, validates and reads that same owned handle, and fails closed where no-follow cannot be guaranteed; it admits only explicitly configured stdio servers and per-server `allowTools`, and keeps credentials in the host-owned child environment. Clients start lazily, bounded discovery exposes only allowed MCP tools, and calls recheck policy before dispatch. Timeout, external cancellation, and session shutdown revoke clients, terminate detached MCP process groups with bounded TERM-to-KILL escalation, and await confirmed child exit. The installed entrypoint is a self-contained Effect 4 bundle so Pi's ambient Effect 3 compatibility alias cannot change its schema/runtime API. Wall time, interpreter steps, tool calls, catalog acquisition, MCP messages, logs, and the complete result envelope are bounded; untrusted AST/helper failures and defects normalize to a fail-closed result envelope. Focused package proof covers real newline-framed MCP composition through Pi registration, lazy lifecycle, host-only credentials, allowlist denial, malformed/error/pagination failure, adversarial syntax/helper probes, limits, cancellation and descendant cleanup, symlink rejection, and copied-package resource-loader invocation.

**Core computer use, browser profiles, and teachable workflows.** Added the pinned, MIT-licensed `@injaneity/pi-computer-use@0.5.0` runtime as the self-contained `computer-use` package with its native helper payloads, concrete Ziggy entrypoint adapter, eleven upstream tools, and a bounded `run_ui_segment` driver tool. Semantic segments freshly resolve durable app/browser roots, support read-only assertions, require exact targets and verified postconditions, and stop on ambiguity, cancellation, stale or unknown state, driver errors, and uncertain outcomes; coordinates, JavaScript, text entry, and secret values are excluded. Added `computer-workflows` for session-scoped teaching, strict redaction and nested decoding, visible immutable Profile revisions, later-user-input publication approval, compact replay plans, logged-in browser preconditions, and derived pass/fail/incomplete checkpoint summaries. Added `dev-browser` as the separate named persistent-browser lifecycle boundary with Profile-namespaced browser identities, bounded status/list execution, idle cleanup policy, and confirmation-gated global stop that preserves profile data. Runtime drafts and run evidence stay under `.runtime`; transient refs, state IDs, typed text, URLs, code, coordinates, result bodies, cookies, and page text never enter durable workflows.

**Complete UI-capabilities and Squarey web plan.** Created a clean planning worktree on `kyendamuri/ui` from `6d7f71c`, captured the product boundary in `PRODUCT.md`, and recorded the full implementation packet in `docs/plans/ui-capabilities-squarey-web.md`. The plan improves the existing serve-owned UI gateway and `@ziggy/gateway-client`, redesigns the existing `clients/example-web` into a Grok-style Squarey client, and routes UI authoring through the bundled `ziggy-operations` skill. It defines the complete Profile interaction inventory, transcript projection, event epoch/cursor/replay behavior, product-to-primitive composition, eight end-to-end implementation slices, focused and live proof, commit discipline, and a fresh-session handoff prompt. No production behavior or Squarey Profile files changed.

## 2026-08-29

**Current Profile-scoped UI protocol and recovery core.** Replaced the legacy browser surface with one strict capability protocol covering Profiles, sessions, local specialist and same-Profile group conversations, agents, models/auth, automations, memory, extensions, and persistent pins. Pi JSONL remains the only transcript authority through the read-only session-history adapter. Live events now carry a startup epoch, per-session sequence, stable identity, bounded replay, and explicit replay-gap results; Profile-local machine state owns pins and single-writer group metadata with revisions and idempotent command IDs. A shared resident WebSocket gateway composes registered Profiles into isolated registries and never projects Profile paths.

**Framework-neutral gateway client.** Split `@ziggy/gateway-client` into strict protocol capabilities, transport/lifecycle, watch restoration, reducers, selectors, and stable main/specialist/group projections. Reconnect carries epoch and cursors, replays available events, reconciles history after gaps or restarts, and deduplicates visible events without taking transcript authority into the browser.

**Reference web product rebuilt and polished.** Reworked the example into a responsive dark conversation desk using only the gateway client: persistent Profile/navigation rail, pinned/recent/specialist roster, main/specialist/group chats, complete conversation controls, agent/model/auth workflows, automation editor and activity, memory/extension detail, persistent pins, and full connection/error/reconciliation states. Deterministic Ziggy SVG identities stay in the UI layer. A rejected sparse admin-style pass was replaced with a denser two-pane layout, human-scale type, warm charcoal surfaces, message bubbles, specialist voice cards, and a compact mobile-safe composer.

**Live UI capability and group-flow completion.** The production resident now supplies every management capability used by the protocol instead of test-only fallbacks. Live Profile switching clears watches and projections before loading the next isolated resident; opened conversations automatically subscribe without becoming read-only; stored Pi sessions appear as read-only recent history; command IDs remain unique across reloads. Same-Profile groups expose Everyone, host, and validated member recipients, publish sequenced specialist voice cards, and retain one host ChatHandle as the only canonical JSONL writer. Automation editing now emits the authoritative frontmatter format and reconciles a newly created definition before its first save.

**UI recovery and boundary review closure.** Profile-tagged events are now discarded after a Profile switch, replay gaps trigger an actual Pi-history reload, restored watches retain their epoch/sequence cursor, and reducer-visible frames remain bounded. Idempotent command retries rebind cached outcomes to the current transport request ID. Group defaults are authoritative, explicit `all` selects bounded multi-agent discussion, duplicate membership fails at the decoded boundary, and oversized Pi JSONL files fail before metadata parsing. The example's protocol adapter now routes every request through the SDK's strict method validator, and the detail sheet restores keyboard focus on dismissal.

**UI concurrency and delivery contract closure.** Profile loads now carry a generation and captured Profile identity, so a late prior-Profile response cannot repopulate switched state and reconnect preserves the user's selected resident. Replay reconciliation is per conversation, supersedes an older history read, and merges events received while Pi history is loading. Groups admit at most four local specialists, making typed `all` exact rather than silently partial. Encoded server responses enforce the 64 KiB transport budget with a bounded typed failure, while streamed event fields use conservative UTF-8 limits. The SDK reports sent-but-unanswered requests as outcome-unknown and never retries them automatically; durable transcript command receipts remain deliberately out of scope because they would create a second authority beside Pi JSONL.
**Profile-operation and history-frame closure.** Fenced asynchronous session-open results by Profile generation and reduced history pages to a wire-safe eight bounded entries.

**Final quality-gate cleanup.** Recast the oversized-session failure assertion as one unconditional typed-result match so the repository Effect lint gate remains fail-closed.

**Wire-safe model catalog.** Model list and availability responses now fairly interleave providers and expose an explicit truncation flag while staying below the WebSocket response budget, so a large authenticated Pi catalog remains usable in the reference UI.

**Final Profile and frame fencing.** Every live management mutation now captures Profile identity and generation before awaiting the resident, preventing late Alpha responses from mutating Beta UI state. Group composers honor the host-owned default recipient, live pins persist only through the Profile store, complete success frames enforce the 64 KiB wire contract, and high-volume model, agent, and automation payloads remain bounded. Removed pass-through SDK aliases where the protocol map already owns the exact request or result type.

**Wire-safe list projections.** High-volume Profile, session, agent, auth, automation, memory, extension, and pin reads now project bounded list windows before encoding. Their owning result schemas enforce a 56 KiB result budget beneath the 64 KiB complete-frame ceiling, including escaped UTF-8 adversarial values, so no schema-valid list can become an internal transport failure.

**Live session projection encoding.** Ordered the overlapping session result schemas from specific to general so a `session.show` response cannot be reduced to the smaller `session.open` shape during union encoding. The focused gateway test now asserts the complete live-session response used by the browser after opening main, specialist, or group conversations.

**Final UI race fencing.** Made Profile switching last-selection-wins even when a user rapidly returns to the currently displayed Profile, invalidated pending history work during every switch, and reset global history loading state before the next resident projection. Agent, automation, and memory detail reads now capture Profile generation and discard late results, errors, and operation cleanup after ownership changes.

**Connection-load race closure.** A superseded resident capability/Profile load now discards its late failure instead of marking the newer Profile generation closed or surfacing an obsolete error toast.

**Profiles CLI visual prototype.** Gave interactive `ziggy profiles` output a compact, width-capped shelf composition with a framed panel, decisive magenta brand and action blocks, name-derived identity tiles, tree-shaped path hierarchy, edge-aligned suspicious-name warnings, and responsive path truncation. Malformed names receive a semantic warning tile rather than a decorative identity. Non-interactive output and `--json` retain their stable machine-readable shapes, and `NO_COLOR` remains respected.

**Interactive extension CLI.** Added a searchable, keyboard-driven `ziggy extensions [manage [<name|path>]]` flow with Profile selection, current-selection preload, a reviewed add/remove diff, confirmation, cancellation, and one transactional `ProfileExtensions.setSelected` mutation. Extracted the Profile prototype's framed terminal primitives into a shared renderer and applied the visual language to extension list, detail, and mutation results while preserving stable plain and JSON output for scripts. Promise-based Clack prompts stay behind one Effect adapter with typed interaction failures. Focused UI/application tests, the full repository check, development standalone build, and isolated standalone smoke pass.

**CodeRabbit merge-blocker closure.** Aligned stored pin identity, automation IDs, missing-memory decoding, and replay-state refreshes across the web client and SDK; removed duplicate connection submission; bounded persisted pin/group writers; isolated oversized transcripts during session listing; admitted explicit host-only groups; replaced repeated-open subscriptions; and converted response encoding failures into bounded internal frames. Focused regression tests cover every corrected invariant.

## 2026-09-03

**Bundled skill shelf cleanup.** Removed nine unused packages (`acp-router`, `codex`, `here-now`, `hyperframes`, `open-computer-use`, `openai-whisper`, `things-mac`, `tmux`, and `wacli`) from the repository shelf and approved catalog. Regenerated the embedded standalone resources and tightened the complete-catalog runtime proof to the retained package and tool surface.

**Ziggy 0.2.5 release metadata.** Bumped the package, README, installer, doctor, and ACP identities from 0.2.4 to 0.2.5; documented the Profile-scoped UI platform, interactive CLI flows, and bundled skill shelf cleanup; repaired the changelog compare links for the 0.2.3–0.2.5 releases.

**Retired helper gate removed.** Removed the root `test:helpers` command and its `extensions/here-now` invocation after the release build exposed that stale reference; the root test command now covers the retained core, extension, and tooling suites directly.

**Standalone test gate aligned.** Removed the standalone builder's second stale `test:helpers` invocation; its retained `bun test ./test ./extensions ./tooling` gate already executes every current helper suite.

## Effect submodule storage repair

- Rebuilt local `vendor/effect` Git metadata as an independent shallow repository at the unchanged pinned commit `6184a7dc53cb9310e299b65ad6d6c712c2cbf202`, removing its dependency on the deleted `starman` checkout. Preserved source files, index, and local main reference; backed up the original metadata outside the repository.
- Verified submodule `git fsck --full --no-dangling`, submodule status, and parent status succeed with no submodule changes.

## Slack visibility and busy-message slices

- Tool task cards now classify common test, check, build, Git inspection, and file-search commands. Native active status uses the same semantic titles plus bounded existing adapter details; unknown tools retain a generic label. No new tool arguments or output enter Slack progress. Tests cover classification, Unicode bounds, native stream chunks, and final-answer separation.
- Added optional Slack `busyMessageMode: queue|steer`, defaulting to steer in the gateway. Text-only follow-ups in the active Slack thread use the existing handle; idle/missing handles, other threads, attachments, and typed steering failures retain serial queue behavior. The active message exists only during the prompt and is cleared on every exit. Successful steering settles ingress once as accepted into Pi, without a second prompt or placeholder. Deterministic gateway tests cover default/explicit modes, channel and DM steering, idle/race fallback, thread isolation, and attachments.
- Inspected registered Profile locations and Squarey's agent frontmatter. No Luna/Sol/Astra specialist definitions were present, and no target Profile/model IDs were established for new definitions. Left Profile files unchanged.
- The delegated worker could not start; implementation and review were completed locally. Normal fmt/lint/typecheck scripts hit the host's broken Node `libllhttp.9.3.dylib` dependency; the same scripts pass when run with `bun --bun run`.
- Verification: 52 focused Slack tests pass; `bun --bun run check` passes formatting, lint, typechecks, knip, 12 gateway-client tests, and catalog/Pi-doc generation checks. `git diff --check` passes. No live Slack/provider calls were made.

## Minimal Squarey web conversation

- Replaced the framework-free signal desk with a React/Vite+ client built on the fatestack frontend
  foundation, generated shadcn/ui controls, and a local React adapter over the MIT-licensed Bloub
  avatar engine. The light conversation-first layout follows the supplied Grok Bot reference and
  collapses its rail into a mobile sheet.
- The client opens the current Profile's main conversation, subscribes only to the selected live
  session, loads authoritative history, streams assistant and tool activity, preserves ambiguous
  sends, and reloads history on replay/epoch/sequence gaps without subscribing to channel inventory.
- Focused hook proof covers main-only startup, local watch failures, stale connection and selection
  completion, and unknown prompt outcomes. Client typecheck, five tests, and the static Vite+ build
  pass. A bounded live Squarey prompt streamed and settled through the local resident. The client
  retains streamed answers when an authoritative refresh is unavailable.
- Mapped the client's semantic color and radius tokens into Tailwind v4 so generated shadcn dialogs,
  buttons, inputs, focus rings, and mobile surfaces render with opaque backgrounds and intended
  foreground contrast. The focused client check and rebuilt static preview pass.
- Reconnects a reloaded tab automatically when its tab-scoped token and saved endpoint are both
  present, while first-use and new-tab visits retain the connection dialog. A focused Strict Mode
  regression proves startup creates one live client and does not close it during effect replay;
  overlapping connection attempts remain last-attempt-wins at the dialog boundary.

## Live web conversation history

- Fixed live UI session history to resolve the active Pi transcript identity at request time, including
  session switches and lazy unmaterialized sessions. Stored history remains unchanged; stale cursors
  and transcript read failures remain errors. Added focused authority and error regression tests.
- The development standalone build passed the full repository check and test suites. Refreshed only
  Squarey's local resident to that checked preview binary, preserving the original LaunchAgent backup
  and installed CLI. The browser now loads its existing main transcript successfully. A fresh bounded
  prompt completed and its response remained in authoritative history after a browser reload.
  Desktop and narrow-screen layout checks passed; production preview 4173 and development 4174
  both remain available. Stored-history browsing and secondary Profile settings remain later slices.

## Working conversation rail

- Expanded the minimal rail with resident-backed main chat, Profile pins, direct specialist chats,
  persisted groups, and active, paused, or conflicted automations. Specialist and group rows open
  only on demand; startup defaults to main and never subscribes to channel inventory.
- Added group creation for up to four Profile specialists and a group composer recipient selector
  for everyone, the host, or one member. Existing automation controls issue explicit run, pause, and
  resume commands, while conflicted definitions remain visible without invalid actions. Loading,
  disconnected, empty, and mutation failure states remain explicit.
- Disabled conversation switching, pins, specialist/group opening, and automation mutations whenever
  the transport is reconnecting or closed. The visible transcript remains in place until the
  established connection returns.
- Restores the tab's selected main, specialist, or group conversation after gateway bootstrap and
  reports initial conversation and rail restoration as loading instead of briefly showing false
  empty states. Populated rail data stays visible during later refreshes, and its Radix scroll
  viewport is width-constrained so group and automation controls remain inside the compact rail.

## Automation observability panel

- Made each automation name open a read-only detail dialog backed by the existing definition,
  scheduler-status, and run-history SDK calls. It presents the task before the unchanged full source,
  structured schedule and timezone, the selected automation's latest run, exact failure category,
  run IDs, delivery outcomes, and recent history. Subsecond durations retain millisecond precision.
- Kept global scheduler tick and heartbeat health separate from the selected automation outcome,
  and treats paused definitions with no scheduler row as paused instead of deleted. Independent reads
  preserve available definition or scheduler data when another source fails; generation fencing drops
  late results after selection changes, and run lists are filtered by automation ID before display.

## Automation definition editing

- Added an explicit Edit mode to the automation detail dialog with the supported flat frontmatter
  fields, a task editor, and an unchanged full-source mode. Field edits preserve unknown lines and
  ordering instead of serializing the definition through a generic YAML implementation; long task
  text is collapsed in the read-only view so run evidence remains nearby.
- Saves pass the exact source opened by the editor as `expectedSource`. Concurrent edits therefore
  fail through the gateway compare-and-swap contract without clearing the user's draft; inputs lock
  only while one save is in flight. Focused parser, component, and gateway tests cover preservation,
  raw-source mode, rejected saves, and the expected-source request.

## Profile agent definition editing

- Added an Edit action to direct-agent conversation headers. The shared definition editor presents
  description, provider, model, thinking, comma-separated tools, and instructions alongside the
  literal source, preserving the Profile's flat frontmatter format and exact unknown source lines.
- Agent saves use the same explicit expected-source guard and stale response fencing as automation
  saves. The dialog explains that changes apply to new specialist sessions while existing open
  conversations retain their current runtime; verification uses gateway fixtures and never writes a
  live Profile agent definition.

## Connection recovery and saved group discovery

- Fixed startup failures that left the SDK retrying after the capabilities request timed out. Failed
  startup closes the client; an established reconnect has a bounded recovery window. Disconnected
  mutations are disabled and fail before dispatch, preserving the visible transcript and draft.
- Added typed read-only `group.list` to the gateway and SDK so persisted group definitions remain
  discoverable even when no group session is live. Focused protocol and gateway tests cover this.
- Live browser proof: an invalid token reaches an actionable closed state; Ada direct chat and an
  addressed group prompt return replies; a group created before a resident restart is listed and
  reopens with its prior transcript afterward; pinning appears in the sidebar. Automation state was
  inspected without running or changing scheduled jobs.
- Full standalone development build passed repository checks and test suites. Moved the user
  preview to checked static port 4173 after React hot reload broke during concurrent hook edits;
  source development remains on 4174. Runtime credentials were refreshed in the user tab.

- Refresh restoration stores only a validated per-Profile conversation target in tab storage, then
  reopens it after discovery. Missing targets fall back to main and late restoration cannot replace
  a newer selection. The browser was refreshed on Ada and returned to Ada with its prior history
  and the complete sidebar. Initial loading is explicit; rail controls remain inside its width.
- Final verification: `bun run check` passes, including 13 SDK tests and 16 web hook regressions.
  The earlier standalone build also ran all core/extension/tooling tests successfully.

## Rendered assistant messages

- Render assistant history and streaming output as safe Markdown with GFM lists and tables, styled
  code, and usable links. User messages remain literal text. Raw HTML is skipped, unsafe URL schemes
  are removed, and remote images become explicit links instead of loading when a transcript opens.
- Tightened the composer footer while retaining its send, stop, Enter, and Shift+Enter behavior and
  40-pixel action target. Focused rendering and malicious-input tests pass.

## Profile agent document editing

- Added source-preserving `agent.document` and compare-and-swap `agent.save` gateway operations
  while keeping the existing `agent.show` projection unchanged. The typed gateway SDK exposes
  `readAgentDocument` and `saveAgent` convenience methods with matching strict wire decoders.
- Agent saves validate the complete submitted Markdown contract before writing, reject stale source,
  symlinked paths, and non-physical directories, then replace the file atomically while preserving
  its mode. Per-file serialization ensures concurrent Ziggy saves with the same expected source
  produce one winner and one typed conflict.
- Focused filesystem, application, gateway, SDK transport, and protocol parity tests pass. Saved
  agent configuration applies to new specialist runtimes; existing direct conversations keep their
  current in-memory runtime and are never closed or aborted by a save.

## Configured provider visibility

- Auth status now prioritizes configured providers before applying the existing 16-provider wire
  cap, then orders each configured or unconfigured group deterministically by name and ID. This
  keeps usable late-alphabet providers visible in Settings without changing the public response
  shape or bound. A focused gateway regression covers a configured provider after 17 unconfigured
  entries.

## Web settings and final editor verification

- Expanded Settings to include connection controls, available default models and supported thinking
  levels, configured provider status, and a collapsed list of other reported providers. Model saves
  are explicit; disconnected and stale requests cannot report a successful change in another view.
- The final standalone development build passed `bun run check` and all core, extension, and tooling
  tests. The web gate includes 32 tests and the SDK gate includes 14 tests.
- Restarted the idle Squarey resident with the checked binary and restored its local browser
  connection. Live read proof returned Ada's complete document and all three configured providers.
  Browser proof covered agent editor open/cancel, automation fields/source open/cancel, scoped latest
  run details, rendered Markdown, compact composer, and model-specific thinking choices without Save.
  No live agent definition, automation definition, or model setting was changed during verification.
- Kept the checked preview running on port 4173. Documented credential-request UI as a proposed
  follow-up: keeping secrets out of the transcript alone does not isolate them from shell access.

## Animated Bloub identity collection

- Fixed idle avatars being sampled only once. Idle and thinking now advance through the Bloub
  engine at a capped frame rate, pause in hidden documents, and respect reduced motion.
- Added 96 stable shape/color variants with normalized identity assignment for existing and newly
  discovered bots. The same bot name now retains its avatar across header/sidebar capitalization.
- Settings includes a lazy collection preview, showing eight shapes at a time across twelve colors.
  Assignment remains a supplied-client concern and does not mutate Profile agent definitions.
- Cream variants use a contrasting outline and eyes against the light UI. Full `bun run check`
  passes with 38 web tests. Browser frame sampling confirmed all eight visible idle avatars change
  over time, and Ada's sidebar/header colors agree; the 96-variant collection is visible in Settings.

## Automation run card polish

- Replaced the flat gray latest-run block with a bordered card, semantic status badge, compact
  duration, aligned timestamps, and a separate failure reason. Successful runs omit the empty
  failure field. Existing data and actions are unchanged.
- Live verification exposed an agent-document union branch stripping automation lifecycle during
  response decoding. Moved the less-specific branch after richer results and added a regression
  covering both automation lifecycles and agent documents. The automation files were unaffected.
- Full standalone build/check/tests passed; after an idle resident restart the browser again shows
  the weather definition, Edit action, lifecycle, and polished run card without a decoding error.

## 2026-09-15

**Prism asset pack.** Added four approved illustrated prism compositions under `assets/ziggy-prism`, preserving original PNG masters and generating 12 quality-90 WebPs for full-size and responsive delivery. Added usage notes, generation prompts, and a dimensions/size manifest. Full-size WebPs reduce total size by 91.7%. Verified all output images decode, dimensions match intended formats, and masters match source bytes. No runtime code changed.

## Web preview animation and connection recovery

- Restored real-time Bloub animation at up to 60 fps, with reduced idle wander instead of slowing blinks and transitions.
- Moved endpoint validation and connector construction inside startup error handling so synchronous URL/WebSocket failures clear Connecting and permit retry.
- Verified frontend check (43 tests, lint, formatting, build) and TypeScript; local preview reconnects after refresh.

## Focus-expand composer

- Composer grows to a multiline writing area while focus is within the form and returns to one-line height on blur. Draft text is preserved; send-button focus keeps it expanded.

## Group dialog sizing

- Constrained form and fieldset intrinsic widths, wrapped member descriptions to two lines, added selected-row treatment and member counts, and bounded dialog height for small screens.
- Frontend checks pass: 43 tests, formatting, lint, and preview build.

## Steering, queue visibility, and Settings inventory

- Keep Send available while busy: defaults to session.steer; Queue uses session.follow-up. Clear composer immediately and restore an unsent draft on failure. Show pending submissions from this tab until reconciled in history.
- Added a regression for steering vs explicit follow-up routing.
- Removed the blob preview gallery from user Settings; added read-only selected extension inventory and clarified unavailable model status.
- Group deletion is not exposed by the gateway; no group data was deleted.

## Integrate Ziggy prism artwork

- Added responsive existing WebP artwork to welcome and Settings, a square brand image to the rail, and restrained blue brand tokens. Documented placement in DESIGN.md; original assets preserved.

## New named chat

- Added New chat in Pinned, with a name dialog and automatic persistent pin. Uses distinct session.open names and reopens named sessions when selected after a resident restart. Main conversation remains separate.

## Ziggy favicon

- Replaced the empty data favicon with the approved square prism WebP, served from public assets.

## Rename the web client

- Renamed `clients/example-web` to `clients/web` and its package to `@ziggy/web`; updated root typechecking, Knip entries, ignored build output, run instructions, and plan paths. The frontend check command is now `bun run check:web`. Historical log and research entries retain their original names.
- Verified web formatting, lint, all 45 tests, and production build after the move. Root formatting, lint, and typechecking pass; `bun run check` remains blocked by the pre-existing unused `src/components/blob-collection.tsx` in the web client. No commit made while that gate fails.

## Remove the retired blob gallery

- Deleted the unused web `BlobCollection` component, its gallery-only CSS, and the stale Settings gallery reference in the README. Kept the identity catalog and active bot avatars.
- Full `bun run check` passes, including Knip, typechecking, 14 gateway-client tests, 45 web tests, production build, and generated catalog/docs checks. The build retains its non-blocking large-chunk warning.

## Name and locate the UI SDK

- Moved `clients/gateway-client` to `packages/ui-sdk`, renamed the package to `@ziggy/ui-sdk`, and updated web imports, Knip entries, plan references, and the root `check:ui-sdk` command. Historical changelog, log, and research entries retain the old name. Transport APIs are unchanged.
- SDK lint, typecheck, and all 14 tests pass; web formatting, lint, all 45 tests, and build pass. Full `bun run check` stops at root typechecking because separately deleted `extensions/diffs/index.ts` and `extensions/linear/index.ts` are still referenced by generated resources. Left those unrelated deletions untouched; no commit made.

## Browser login and background workflow research

- Compared current OpenClaw and Hermes browser/profile/desktop boundaries with three Luna high scouts; recorded pinned sources and a replacement-friendly recommendation in `docs/research/browser-login-and-background-workflows.md`.
- Recommended one persistent browser owner with visible login, headless execution, human attention, and browser-native workflows; documented the current temporary-profile, driver-sharing, and manual-step gaps. No runtime implementation changed.
- Ran the existing focused extension tests: 41 passed, zero failed. Inspected installed CLI help and version drift; authenticated browser execution and the proposed handoff remain untested.

## Persistent browser profiles in the pi-computer-use fork

- The user selected extending the existing MIT pi-computer-use integration first. Moved the abandoned, unselected Playwright prototype out of Ziggy's source tree to `dump/browser-workflows-playwright-prototype`; workflow teaching/replay remains deferred.
- Extended `launch_browser` with an optional named profile and actual headed/background mode, retaining unnamed temporary launch behavior. Added `close_browser`, Profile-scoped private browser data, serialized lifecycle, cross-process ownership locks, and process-exit-before-release cleanup. Stale locks fail closed; native helper binaries and license are unchanged.
- Kept existing CDP observation/action tools. Browser-only dispatch avoids native desktop permission probes, and a no-match browser search no longer attempts desktop OCR.
- Selected the fork in `/Users/yesh/code/personal/dump/browser-workflows`, retaining its verified `openai-codex/gpt-5.6-luna` / `max` default. Profile OpenAI authentication is not configured.
- Verification: 42 focused existing/new browser and workflow tests passed; extension build/typecheck passed. An independent harness used Pi's public loader against the deployed Profile copy and passed eight real Chrome checks: semantic headed login, cookie/localStorage persistence into headless execution, authenticated read, cross-process lock rejection, named-profile isolation, original-account retention, fresh-process restoration, and pre-aborted launch rejection. This proves the local fixture, not LinkedIn login.
- Full `bun run check` passes formatting and lint but remains blocked by pre-existing missing `extensions/diffs/index.ts` and `extensions/linear/index.ts` referenced by generated resources. No commit made while the required gate fails.

## Remove completed plans

- Deleted eleven completed or superseded planning documents rather than archiving copies; Git retains their history. Kept the five documents with unresolved implementation, architecture, or live-proof work.
- Added `docs/plans/README.md` to identify remaining scope and preserve channel, Linux service, ACP, and standalone verification gaps. Replaced the ACP research link to a deleted plan with current operations guidance and removed stale plan dependencies from the standalone packet.
- Documentation-only cleanup; unrelated SDK and extension work remains untouched. No runtime tests rerun for these deletions.

## Save and run two-page browser job workflows

- Added local `browser_workflow_save/list/show/run` tools in the existing `computer-workflows` extension. Recipes declare two URLs, named browser profile, authentication/readiness/empty checkpoints, and bounded job ID/title/link/company extraction. Renamed taught-workflow tools to `workflow_save_prepare` and `workflow_save`; existing persisted semantic formats remain readable.
- Reused the pi-computer-use fork through Pi's shared event bus and one token-owned browser lease. Runs refuse an active human browser, block competing UI operations, and await owned-browser cleanup. No additional browser driver was introduced.
- Added immutable recipe revisions, full-run reports, stable-ID union baselines, overlap deduplication, source-change resets, and fail-closed run locks. Failed, cancelled, unauthenticated, incomplete, or oversized runs preserve the baseline. Reports are durable before advancing seen IDs.
- Installed and selected both packages in `dump/browser-workflows`, retaining Luna/max. The deployed copies passed eleven real Chrome/public-Pi-loader fixture checks covering save/discovery, authenticated two-page extraction, new/unchanged jobs, page-two failure recovery, expired login, human-browser preservation, concurrent-run rejection/cancellation and timeout recovery, explicit empty pages, and fresh-process reuse. Proof scripts and results are saved in that Profile's `verification/` directory.
- Package checks passed: computer-use build/typecheck/lint and 18 tests; computer-workflows format/typecheck/lint and 24 tests. Full `bun run check` passes formatting/lint but remains blocked by the unrelated deleted diffs/linear imports in generated resources. No commit made.
- Real LinkedIn login/selectors and scheduling remain unconfigured. This slice saves manually defined recipes; human-click recording, optimization, and automatic skill/extension packaging remain future work.

## Reconcile removed extensions

- Removed diffs, gh-issues, linear, nano-pdf, notion, onepassword, and xurl from the approved catalog after their source directories were deleted. Regenerated bundled metadata, factory imports, and embedded resources from the remaining packages.
- Updated the existing catalog-loading test for the remaining 21 skills and current saved-browser workflow tools.
- Verification: all 11 resource-discovery/catalog tests pass; full `bun run check` passes, including format, lint, typechecking, Knip, SDK/web tests, web build, and generated catalog/docs checks. The web build retains its non-blocking chunk-size warning.

## Skill loading and self-documentation audit

- Used two Luna Max scouts and writing-for-agents to inspect Pi-compatible skill loading, runtime instructions, and code/docs access. Saved source-linked findings in `docs/research/skill-loading-and-agent-self-documentation.md`.
- A no-model session probe of `dump/browser-workflows` loaded four visible skills and 27 extension tools without resource diagnostics. Skill descriptions/paths appear in the custom prompt; full bodies remain on-demand.
- Keep Ziggy's replacement prompt. Identified incomplete self-help/API discovery, an intentionally unregistered `pi_docs` tool despite embedded-doc health checks, repository-only authoring proof instructions, missing operation routes, and divergent Slack reference copies. No runtime implementation changed; autonomous model skill use and fresh standalone relative-reference behavior remain unproven.

## Recover UI subscriptions after replay rollover

- Distinguished a fresh event subscription from an explicit resume cursor: fresh opens/watches replay the retained activity window and attach live, while expired/future cursors and stale server epochs still fail. Persisted Pi session history remains the transcript authority. Rejected replacement watches preserve their existing listener.
- The UI SDK now reattaches without the rejected cursor before reconciling history. Request and connection fences prevent late recovery responses from reviving an explicitly unwatched session; sent user commands are not retried. Cursor-free reconnects also request history reconciliation because continuity is unknown.
- Preserved active text/tool state across web history reads, including activity replayed before a reload and events received while it is pending. A bounded opening-event buffer retains replay delivered before the selected session reference is known. Settlement clears completed activity without erasing a subsequent active turn.
- Verification: 22 focused core registry/gateway tests, 18 SDK tests, and all 47 web tests pass. Full `bun run check` passes formatting, lint, typechecking, Knip, SDK/web tests, web build, and generated catalog/docs checks; the existing web chunk-size warning remains. Tests exercise real registry/gateway code and SDK/hook fixtures; no live resident restart, browser session, or deployment was performed.

## Complete Profile self-documentation

- Sol Medium implemented normal-runtime `pi_docs` and `ziggy_help`, with help derived from the CLI's shared authority. Specialist sessions retain their tool allowlists; Ziggy's identity and Pi's progressive skill disclosure remain intact.
- Completed operations routing and Profile-local extension admission guidance. Catalog generation now synchronizes operations references from `docs/operations` and rejects drift. Refreshed the three required skill packages in `dump/browser-workflows` after checking their existing copies were unchanged.
- Astra Medium independently verified the implementation and specialist restrictions with no remaining findings. Updated core-resource inventory assertions for the two new docs factories.
- Verification: repository checks and all 701 core tests passed in the development standalone build. Standalone smoke passed with checkout reads denied. An additional compiled-binary probe verified all three required skills and six canonical reference files outside the checkout. A production-path, no-provider session called both docs tools and verified identity, skill metadata disclosure, and relative-reference readability.
- Live model-driven skill selection remains untested because the test Profile has no provider authentication. The standalone artifact is a development proof build; the installed user binary was not replaced.

## Require readable spacing Oxlint rule

- Added the pinned anti-slop `require-readable-spacing` policy to Ziggy's local Oxlint plugin as an enabled error. Ported only the required ESLint-Stylistic padding helper to `.mjs`, retaining its MIT license and upstream provenance record; no full ESLint dependency was added.
- Applied the rule's whitespace-only fixes across the existing `src`, `test`, `extensions`, and `tooling` lint scope. Added a focused CLI regression for diagnostics, exact fixes, grouped locals/overloads, and repeated-fix stability. No commit made.

## Refine sidebar alignment

- Aligned automation titles with conversation, agent, and group titles using a shared leading slot and gap. Centered status dots beneath avatar centers and aligned section headings to the outer gutter.
- Rebuilt the static preview and visually verified the connected desktop sidebar. Long automation names truncate sooner; readable names and secondary controls remain the next refinement for review.
- Verification: `bun run check` passed, including 18 SDK tests and 47 web tests; `git diff --check` passed. The existing web bundle-size warning remains.

## Simplify automation rows

- Display readable automation names and daily schedules, preserving raw identifiers and schedules in tooltips and leaving complex cron expressions intact. Explicit Enabled and Paused labels distinguish lifecycle from the available Pause/Resume actions.
- Show invalid definitions with a warning icon and Needs attention text. Reveal desktop actions on hover or keyboard focus; retain visible controls for touch pointers.
- Rebuilt and inspected the live desktop preview. Full `bun run check` passed; after adding three status regression tests, web checks passed with all 50 tests. `git diff --check` passed. Existing bundle-size warning remains.

## Collapse completed tool activity

- Group consecutive successful completed tool calls behind a native disclosure in history and live activity. Running calls, failed calls, and messages break groups and remain visible; original rows stay available on expansion.
- Verified the live conversation shows one collapsed row for three reads and expands to all three original entries. Full `bun run check` passed, including 52 web tests and 18 SDK tests; existing bundle-size warning remains.

## Refine composer alignment and sizing

- Matched the composer outer edges to the transcript content column, including narrow-screen gutters. Removed focus-triggered expansion; content now grows the textarea from 38px up to 180px.
- Desktop browser measurements confirmed matching left edges, unchanged 38px textarea height on focus, and growth to 80px for a three-line draft. Cleared the test draft without sending. Full checks passed; rebuilt after the final narrow-gutter adjustment. Mobile layout remains source-checked only.

## Restore composer click expansion

- Restored the preferred 112px minimum textarea height on focus while preserving the new transcript alignment and content-driven growth.
- Full `bun run check` passed. Rebuilt preview and verified clicking the composer expands its textarea to 112px.

## Refine sidebar typography

- Replaced tiny tracked uppercase section labels with 12px sentence-case labels. Specialist rows display the opening role sentence without the repetitive Squarey suffix; full descriptions remain in title tooltips. Profile definitions are unchanged.
- Rebuilt and visually verified all three specialist descriptions fit the desktop rail. Full `bun run check` and `git diff --check` passed; existing bundle-size warning remains.

## Simplify offline connection setup

- Offline settings now lead directly with the connection form and hide artwork, model, provider, and extension sections until connected. Connect uses the primary action treatment; connected settings retain their existing sections.
- Removed repeated connection prompts from empty sidebar sections and kept a single welcome action with concise explanatory copy.
- Full `bun run check` passed. Verified the fresh offline browser state and compact dialog visually; existing bundle-size warning remains.

## Clarify connected settings recovery

- Removed decorative artwork from settings and updated the design guidance. Model controls now appear after model status loads; loading is announced, failures retain their error text, and absent/failed settings expose a Retry loading settings action wired to the existing loader.
- Visually verified the connected settings without artwork and with provider data loaded. Full checks passed; a follow-up web check covers the added retry regression. The live empty default is distinct from unavailable status. Existing bundle-size warning remains.

## Read large conversations and cached model defaults

- Replaced the whole-transcript 8 MiB limit with incremental JSONL scanning and bounded history-page projection. Session lookup reads sibling headers and fully parses only the requested session, so an unrelated large transcript cannot hide a valid conversation. Individual records remain bounded; direct read failures retain their typed cause.
- Corrected the read-only model store to load and validate the existing Profile cache without creating, changing, or deleting it. Cached-only model IDs now resolve in model status and lists.
- Verification: 19 focused model/session/history tests passed. A read-only probe against Squarey's 19.7 MB main transcript returned two eight-entry history pages with an earlier-page cursor and preserved its bytes. It resolved the saved openai-codex/gpt-6-astra / low default; Profile identity, settings, credentials, cache, and extension selection hashes were unchanged. Astra Medium independently reviewed both fixes.

## Paginate saved browser jobs and persist job details

- Added version-2 browser recipes with configurable result pages, unique next-control pagination, page/time/output budgets, and generic text/list detail fields with source provenance and required-field checks. Existing version-1 two-page recipes remain executable.
- Added a selector-only click operation to the existing computer-use browser lease. The host waits for changed job IDs or a verified empty checkpoint after navigation, including SPA URL changes that precede card rendering. Ambiguous controls fail; native and ARIA-disabled controls end pagination.
- Persist full extracted items and detail JSON on initial and repeat runs; tool results return compact summaries and the report path. Partial or failed runs preserve the prior baseline instead of treating incomplete coverage as success.
- Verification: 28 computer-workflows tests and 18 computer-use tests passed with package typechecks and workflow lint/format. Seven real Chrome fixture checks passed: authenticated three-page extraction with details, unchanged rerun, one new item, failed-detail baseline preservation, page-budget partial result, delayed SPA rendering, and explicit empty final-page completion. This proves the generic browser machinery, not a completed real LinkedIn recipe for the user's expanded search.
- Deployment verification: the full repository check, Bun suite, development standalone build, and checkout-denied standalone smoke passed. Backed up and atomically replaced the installed executable, updated Squarey's two browser packages, and restarted the idle resident. Reconnected the web UI to the new runtime endpoint; it displayed the previously missing conversation and GPT-6 Astra / low in Settings. Protected Profile file hashes remained unchanged. Rollback copies are in `/tmp/ziggy-fixes-proof/deployment-backup`.

## Verify and improve workflows before saving

- Added bounded session capture and `workflow_draft_recent` so an agent can handle “save that” after a successful computer-use task. Updated the skill to route the request through preparation, conservative optimization, observed verification, and saving without an extra approval turn.
- Added nonsecret semantic template bindings, duplicate-observation/root cleanup, and bounded replay segments. Candidate identity, source terminal checkpoint evidence, exact ordered tool results, and current-revision comparison guard promotion. Failed or incomplete verification preserves the previous revision; immutable revisions can be reused safely.
- Browser recipes now run a complete verification through the existing browser bridge before saving, with an isolated baseline so verification cannot consume future discoveries.
- Verification: 31 extension tests and package format/lint/typecheck passed. Astra Medium independently reviewed the proof boundaries and verified the fixes. Six real Chrome semantic checks passed across inventory lookup and order preview: post-task capture, optimization and save, fresh-session replay with different inputs, and failed replacement preserving the prior manifest for each. Three browser checks passed: authenticated pagination/details before save, untouched initial baseline, and failed replacement preserving recipe and baseline.
- Scope: optimization is conservative, not a general learned optimizer. Semantic text/URL entry and secrets remain manual. Replay of actions requires an agent-established reversible test context; UI labels alone do not prove safety. Human mouse/keyboard recording, portable skill export, and automatic repair remain outside this slice.
- Full repository checks, the complete Bun suite, development standalone build, and checkout-denied standalone smoke passed before installation.
- Installed the verified executable and extension in Squarey, preserving protected Profile files, and restarted the resident. Through the web UI, Squarey performed an inventory task using the existing `linkedin` browser profile, handled a natural “save that” request, saved a verified templated workflow, closed/reopened the profile, and replayed the persisted revision for Beta/7 with 1/1 segments passed. Checked the on-disk manifest, candidate proof, and save/replay summaries. A subsequent read-only LinkedIn Jobs visit confirmed the existing sign-in via the Me menu and personalized Jobs interface. This is workflow/profile proof; the user's exact filtered LinkedIn search remains a separate real-site check.

## General agent-executed computer workflows

- Added general task definitions with goals, nonsecret inputs/defaults, browser/app starting context, flexible procedures, expected outputs, and completion criteria. The existing Pi agent executes them with normal computer-use tools; fixed browser recipes and compiled segments remain optional compatible accelerators.
- Added ordinary tools for scoped recording, candidate preparation, run progress, finish/cancel/resume, saving, and discovery. Updated the skill so one request to record and make a workflow proceeds through execution, improvement, verification, and local saving without additional stop/save prompts.
- Record observed tool outcomes separately from agent assessments. Artifact evidence includes freshness, size, and content hash; candidate identity and current-revision checks protect promotion. Corrected browser action evidence to recognize the actual CDP result shape, and corrected headed browser launch capture.
- Deployment and further live browser testing are deferred at the user's request. The earlier general-task fixture attempt exposed the CDP recording mismatch; it is not a passing end-to-end result for this implementation.
- Verification: 35 focused extension tests, package format/lint/typecheck, and the full `bun run check` gate passed (including 18 UI SDK and 53 web tests). Regenerated embedded extension assets. Recovery supports the original session reclaiming an interrupted active run; cross-session takeover of active runs remains blocked. This is a local implementation checkpoint, not live workflow proof.

## Update stopped Profile extension copies from the executable

- Added `ziggy extensions update <profile> <id> [--adopt]` for one installed bundled package. Explicit adoption establishes tracking for unrecorded installations; existing managed local edits block replacement.
- Reuse embedded package staging and Profile validation. Package content hashes, retained backups, and a recovery journal protect replacement without changing selection or Profile documents. Automation-definition changes remain outside this first slice.
- Added process-held runtime reader leases and exclusive update activation. Fresh runtimes reject unresolved update journals; old resident ownership is checked separately. Legacy standalone processes must be closed manually during the initial upgrade because they do not participate in the new fence.
- Combined executable downloads, automatic draining/restart, and live workflow replay are not part of this updater slice.
- Verification: 4 updater tests (27 assertions), 7 focused runtime-lock/lifecycle tests, and the standalone build's repository check plus full Bun suite passed. A compiled CLI against a disposable Profile proved untracked refusal, real replacement with explicit adoption and retained backup, unchanged rerun, and rejection of subsequent local edits while preserving SOUL and selection bytes. Artifact: `/tmp/ziggy-extension-update-proof/ziggy`. Squarey was inspected read-only and remains unchanged; no deployment or browser workflow test was performed.
- Installed the verified development executable on explicit request, stopped Squarey's idle resident, and updated `computer-use` and `computer-workflows` using the installed `extensions update ... --adopt` command. Both previous package trees were retained by the updater. Restarted Squarey successfully (new PID 30745); scheduler, Slack, and Discord reported healthy. Installed executable SHA-256 matches the tested artifact; SOUL/settings/auth/model-cache/selection hashes were unchanged. General workflow tools are present in the installed package. Live workflow replay remains untested for this new implementation.

## Pair browsers once through the resident web gateway

- Added persistent per-resident web configuration, one same-origin server for the checked web assets and WebSocket, and an explicit bind failure when a configured port is occupied. Unconfigured Profiles retain the legacy automatic port until configured.
- Added ten-minute single-use fragment pairing and 30-day HttpOnly browser sessions. SQLite stores only token hashes outside `.runtime`; sessions survive resident restarts, can be revoked together, and are checked on inbound requests and outbound events. The legacy rotating runtime token remains compatible.
- Kept authorization at the shared gateway boundary. One paired browser can use the resident's existing registered multi-Profile directory, while separate resident owners use different cookie names and configurable ports.
- Added `ziggy web configure`, `ziggy web pair`, and `ziggy web revoke`; the hosted client discovers its same-origin gateway before considering saved legacy settings and distinguishes pairing-required state from network retry. Hosted connections keep reconnecting across resident downtime.
- Added a native Profile selector backed by the existing shared gateway. Switching resets Profile-scoped watches, conversations, sidebar data, drafts, and dialogs; the selected Profile is retained for that endpoint across a tab reload.
- Focused server, storage, resident, CLI, SDK, and web tests cover atomic one-time pairing, restart persistence, runtime-token rotation, revocation, schema/config failure, static assets, occupied-port propagation, legacy authentication, long reconnects, and two-Profile switching. Full repository checks, the 736-test Bun suite, the updated 55-test web suite, a development standalone build, and the checkout-denied standalone smoke passed.
- An isolated two-Profile browser preview paired once, switched Alpha to Beta, retained Beta across reload, survived a 56-second server outage, and reconnected automatically with the durable cookie. Revocation forced the pairing-required state. Live Tailscale configuration and the installed daemon remain unchanged for operator cutover after review.

## Release 0.2.6 locally

- Promoted the accumulated web client, browser workflow, extension update, session history, and durable browser access work to version 0.2.6. Updated the package source of truth, release notes, installer platform message, README, and version assertions.
- The clean release executable was built and smoke-tested before atomically replacing the user-local Ziggy binary. Squarey's running resident and Tailscale configuration were intentionally left unchanged for a separate restart and pairing step.

## Document browser access and archive completed research

- Added a short local browser quickstart plus complete local/Tailscale pairing, revocation, shared-gateway, state-ownership, session-inspection, and installed-package update guidance. Synchronized the `ziggy-operations` references and generated catalog resources.
- Archived the completed anti-slop alignment, Effect-native audit, and CLI/filesystem UI-hook reports from the working tree. Their history remains in Git; current behavior belongs to source rules, focused skills, and the web operations/architecture guides.
- Verification: the full `bun run check` gate passed before the documentation commit; packaged operations references matched their public sources and loaded in the focused resource test.

## Scout Jev decision support

- Three Luna high scouts examined TypeSafe's current API and cookbooks, bounded computer-use decisions, and current Ziggy integration seams. Research notes are in `docs/research/jev-*-scout.md`.
- Recommend preserving deterministic workflow execution and evaluating optional remote classification, extraction verification, and ranking at decision points. Jev currently accepts text rather than screenshots; provider benchmark numbers are not measured Ziggy speedups.
- Verification: source and documentation inspection only. No runtime implementation, live Jev call, deployment, or tests were performed.

## General computer workflow alignment

- Removed the obsolete `browser_workflow_save`, `browser_workflow_list`, `browser_workflow_show`, and `browser_workflow_run` tools with their fixed browser-job runner, schemas, storage adapter, tests, and two-page skill guidance. The adaptable `workflow_task_*` lifecycle and existing compiled semantic workflow support remain.
- Replaced tuple-shaped keypress schemas with provider-compatible bounded arrays and retained strict modifier/chord ordering in application validation. Regenerated the bundled catalog.
- Verification: focused computer-workflows and bundled-resource tests passed; `bun run check` passed. A session-scoped `opencode-go/deepseek-v4-flash` prompt with the updated tool surface returned `deepseek-schema-ok` without a tool call; the Profile default model remained unchanged.

## 2026-09-18

**Optional Jev extension.** Added `extensions/jev` and admitted it to `catalog.json`, with regenerated bundled resources and catalog-loading coverage. The `jev_evaluate` tool and versioned cross-extension request/reply bridge share one bounded client for mixed Choice, Score, and Noul questions. Credentials use `TYPESAFE_API_KEY` preferentially; configuration pins `jev-1.13.0` by default. Added cancellation, end-to-end deadlines, bounded transient retries, typed failures, strict answer validation, shutdown cleanup, and a standalone consumer helper. Production endpoint restrictions and redirect refusal prevent sending credentials to arbitrary configured hosts. No idle calls, transcript collection, caller policy, or Profile changes.

**Verification.** Sol/medium implemented; Luna/high reviewed the extension. Eighteen mocked-network/contract tests pass, including malformed replies, probability invariants, structured legends, prototype-safe IDs, missing listeners, retry, deadline and cancellation behavior. Root `bun run check` passes after strict-TypeScript and unused-export fixes; catalog shelf loading passes. No live TypeSafe call or Squarey/LinkedIn integration has been performed.

Full verification: `bun run check` and `bun test ./test ./extensions ./tooling` both pass; the latter reports 742 tests passed, zero failures.

**Release preparation: 0.2.10.** Updated package, installer, README/changelog and version assertions. The user selected 0.2.10 because the existing local executable identifies as 0.2.9 while the source was 0.2.6 and the latest public release was 0.2.5. Publication will include the existing main-branch changes and the Jev extension; unrelated uncommitted research remains outside the release.

**Release CI dependency fix.** The clean GitHub v0.2.10 build exposed a missing independent `clients/web` install (`vite/client` types were unavailable). Added its frozen-lockfile install before the existing build/check gates. Sol/medium verified the full `bun run check` in a clean archived checkout; no gate was removed. The v0.2.10 tag stays immutable; its exact source is being built separately for publication.

## Deliver automation results into durable conversations

- Added canonical `conversation:<stored-session-id>` automation targets. Every run still executes in a fresh automation session, then the selected Profile registry appends a provenance-labeled Pi custom message to the destination transcript without triggering a model turn.
- Registry admission now fences live UI and channel session opening, prompting, automation append, and closing. Busy conversations fail retriably; unopened stored transcripts use the existing safe Profile-local session resolver. Durable receipts deduplicate retries across the full Pi entry tree, and a write is successful only after the JSONL receipt can be reloaded.
- Added stored session identity to session inspection plus automation-result live events and history projection. CLI runs without a scoped registry report `owner-unavailable`; delivery failures remain explicit in the automation ledger.
- Verification: the full `bun run check` gate passed, including 21 UI SDK tests, 59 web tests, synchronized generated assets/catalog/docs, and the UI conversation picker/documentation changes. The complete core, extension, and tooling suite passed with 744 tests and 2,744 assertions. No live Profile, transcript, external message, installation, or resident restart was used.

## Select multiple automation destinations from one catalog

- Added one Profile-scoped, paginated destination catalog over complete stored Pi sessions and the resident's observed Telegram, Discord, and Slack addresses. Canonical automation targets remain the only delivery identity; discovery is memory-only and never gates a saved target.
- Channel boundaries retain signed Telegram chat IDs, Discord channel/thread IDs and available names, plus Slack channel/thread addresses. Configured Slack policy IDs seed the catalog, with one best-effort `conversations.info` name lookup and ID fallback; `slack.json` policy remains unchanged.
- Replaced the conversation-only web resolver with one SDK catalog and multi-destination add/remove rows. Mixed targets, `origin`, `all`, and saved targets missing from discovery remain editable, and removing the last target writes `none`.
- Focused verification covers Profile isolation, more than one catalog page, configured Slack names and fallback, transport address metadata, restart-safe saved selections, SDK method parity, and mixed add/remove behavior. No live Profile, external message, installation, or resident restart was used.

## Verify destination selection end to end

- Independent verification found and corrected mismatched cursor/sort ordering and overlong display labels. Catalog pages now use consistent canonical ordering and bound only display text; regression coverage includes mixed-case/punctuation IDs and Unicode labels.
- Restored existing pin names for stored conversations and resolvable live handles without reopening stale pins or adding persistent destination metadata. Removed a duplicate web state reset.
- Bounded optional Slack name lookups to two seconds so a stalled metadata request falls back to the channel ID instead of blocking gateway startup; verified with Effect's test clock.
- The independent isolated browser check added and removed conversations, saved mixed transport targets plus `origin`/`all`, retained them after resident restart, removed an undiscovered target, and saved `none` after removing the last target. No provider run or external message was sent.
- Final `bun run check` passed; `bun run test` passed 750 tests with 2,763 assertions. An initial full run failed the resident hard-crash test, which passed in isolation and on the full rerun; no lifecycle code was changed. Astra independently rechecked the fixes with 99 passing tests and reported no remaining blocking findings.

## Release 0.2.7 locally

- Bumped the CLI version, README, release notes, installer platform message, and version assertions for conversation delivery and shared multi-destination selection.
- Build and smoke the standalone artifact before updating the installed CLI and restarting the existing Squarey resident for user testing.

## Release 0.2.8 locally

- Bumped the CLI and release surfaces for native conversation naming. Existing Squarey sessions will receive semantic names through Pi session-info metadata after a copied-transcript rehearsal, with original transcript backups and unchanged session identity.
- The shared Pi pre-turn hook supplies first-message names for CLI and TUI sessions, including newly switched sessions. Semantic hints reserve room for the topic; explicit names and clears remain authoritative.
- Release checks, full build tests, and the checkout-denied standalone smoke passed. Installed the verified 0.2.8 binary, stopped Squarey for the metadata update, and appended native names to 252 existing session files with original backups and byte-prefix/ID/reload assertions. Restarted successfully; the live SDK catalog returned 249 conversations with zero raw-ID labels, both existing pin titles, and all four Slack room names. No provider call or outbound message was initiated for verification.

## Name stored conversations with Pi session metadata

- Project the latest Pi `session_info` display name into stored session metadata and use it in the automation destination catalog, while keeping canonical session IDs unchanged and applying explicit UI pin labels last.
- New conversations write one bounded Pi-native name on their first valid prompt. Stable local and channel routes lead with semantic identity and add the first-message topic; otherwise the first user message supplies the title. Existing names and explicit clears are never overwritten. One-off specialist runs include the agent identity and task topic, while the direct UI specialist route remains one continuing session per agent.
- Focused adapter and UI tests cover latest-name extraction, explicit clearing, bounded fallback, stable identity, catalog labels, and pin precedence. No live Profile, transcript, external message, installation, or resident restart was used.

## Make automation destinations searchable and run state readable

- Enriched destination discovery with pinned, agent/session, and channel categories plus latest message or automation-result activity. Later naming metadata does not make historical conversations appear recent; exact single-session UI pin directories restore pinned grouping after a resident restart.
- Replaced the automation destination select with a searchable, filtered picker. All destinations group pinned conversations first, followed by agents, sessions, Slack, Discord, and Telegram, with recent conversation activity first and exact activity times available on hover.
- Automation details now feature an active run over a newer skipped-busy attempt, show elapsed in-progress state, explain skipped and pending delivery clearly, and render readable per-destination outcomes in both featured and recent runs.
- Verification: 13 focused core tests, 21 SDK tests, 6 focused picker/detail tests, the 66-test web check and build, targeted source lint, formatting, and repository TypeScript checks passed.

## Automation run visibility and release 0.2.9

- Poll recorded run history while connected; show starting/running/completed/failed state in the sidebar, keep running jobs inspectable, and disable repeat execution while active. A timed-out request reconciles durable status without redispatching.
- Keep the active or latest non-busy run featured so a later skipped duplicate cannot hide execution or completion. Show elapsed time and named per-target results directly in run details.
- Astra review found reconnect state leakage and stale run-history errors after recovery; both were fixed with focused regressions. Browser simulation additionally caught a completed run being hidden behind a newer busy attempt; fixed and regression-tested.
- Full repository check passed, including SDK and web tests. Isolated browser proof exercised search, agent filtering, two saved destinations, automatic running-state refresh, and simulated completion with visible per-target outcomes. Simulated records were written only to the disposable preview Profile.
- Read-only live evidence: Squarey's original LinkedIn jobs manual run completed at 2026-09-17T22:17:11Z; its stored outcomes record both the conversation and Slack channel as delivered. The second manual attempt was skipped-busy. No live run or outbound message was initiated during this verification.

## Release 0.2.11 compatibility recovery

- Merged the exact installed 0.2.9 tip (`79d7bf1`) into the Jev-complete release line without including its dangling successor. The integration retains the optional Jev package and the removal of the four legacy fixed browser workflow tools while restoring durable `conversation:<id>` automation delivery, destination discovery, native session naming, and web run visibility.
- Resolved release surfaces to 0.2.11 and regenerated the builtin catalog and web assets from source. Root and `clients/web` dependencies were installed with frozen lockfiles; the pinned Effect submodule was initialized at `6184a7dc`.
- Verification: `bun run check` passed, including 21 UI SDK tests and 69 web tests. `bun test ./test ./extensions ./tooling` passed 759 tests with 2,727 assertions and zero failures, including the focused automation conversation delivery and Jev suites. No live API call, installation, publication, Squarey edit, or resident stop/restart was performed.

**0.2.11 pre-deployment proof.** Built and sandbox-smoked the clean merged commit `4582d4e`; the resulting executable successfully reads Squarey's existing scheduler database and historical conversation-target result. Its service-definition drift report is expected while invoked from a temporary build path. A synthetic mixed Choice/Score/Noul request through the Jev client succeeded against `jev-1.13.0` in 479 ms (one attempt; 388 input / 62 output tokens). This is one API smoke measurement, not a LinkedIn workflow benchmark. No LinkedIn data was sent or automation run. The user-authorized credential from `~/.env` was installed only in Squarey's private Jev credentials file; the value was not logged.

**0.2.11 published and Squarey enabled.** Both GitHub Actions attempts timed out the same five-second gateway CLI test (758 passed / 1 timeout). Published the exact clean-tag local artifact after all 759 local tests and standalone smoke passed; release notes disclose the CI timeout. Latest stable is `v0.2.11`; `v0.2.10` is prerelease. Installed executable version and release SHA-256 match (`a2b06f9b732bdb654e8b83b6039409405464b929d275f2a20cd769a7194b85a7`). After checking zero active runs/turns, enabled `jev` in Squarey and restarted its resident from PID 54185 to 73700. Scheduler tick and Slack/Discord are healthy. Other extensions, LinkedIn automation, schedules and workflow definitions were unchanged. Main-worktree `bun run check` also passes. The CI timeout remains an open release-harness issue.

## Slack always-on channel default

- Changed omitted Slack channel policies and the application classifier defaults from `mention` to `always`; explicit per-channel `mention` and `always` entries still override the default. Owner-only filtering, bot filtering, direct messages, threads, and session routing are unchanged.
- Updated the focused Slack gateway regression coverage, both Slack operations references, and the generated builtin catalog resource.
- Verification: focused Slack gateway tests and `bun run check` were run; results are reported with this change.

## Release 0.2.12

- Bumped release metadata and version expectations for the Slack default-always change. Existing explicit channel policies remain authoritative; no Profile edits are needed.
- Resident processes require a restart after installing the new CLI to load the changed Slack default.
- Release verification passed: `bun run check`, 52 focused Slack/doctor/ACP tests, and `git diff --check`.

## Release 0.2.13: repair release test timing

- The 0.2.12 release failed twice: six CLI subprocess launches exceeded one 5-second test budget in both attempts; the second also hit a scheduler heartbeat test race. No 0.2.12 binary was installed locally.
- Split CLI arity and tombstone cases into independent tests, preserving all assertions and the existing timeout.
- Reproduced the scheduler timeout by delaying the continuation after heartbeat commit. The test advanced virtual time before the scheduler registered its sleep, moving the expected wakeup beyond the tested interval. Wait for the registered 60-second sleep through a test Clock service; retain the delayed continuation to exercise the race. The focused delayed test failed before this change and passed afterward.
- No production scheduler changes, skipped checks, or increased timeout limits. Existing tags remain unchanged.
- Verification passed: `bun run check`, all 764 tests, `git diff --check`, and ten repeated delayed-heartbeat regression runs. Release publication, local CLI installation, and Squarey restart follow the verified commit.

## 2026-09-20 — Restore Slack mention defaults / 0.2.14

- Reverted the 0.2.12 always-on default in Slack admission helpers and startup diagnostics; preserved explicit channel overrides and direct-message behavior.
- Restored mention-default tests and operational guidance, and bumped CLI release metadata to 0.2.14.
- Verification: `bun run check`, `bun run fmt`, and `bun run test` passed (764 Bun tests; web check includes 69 passing tests). Regenerated the bundled operational reference.

## 2026-09-22 — OpenMuse connector research

- Inspected OpenMuse at `ef8f608bb0305ff97114983de5c9db7ebcd816e2` and Ziggy at `2d3bf4a`; recorded direct Google/OAuth reuse patterns, existing Executor/Code Mode/Jev seams, and a proposed Profile-owned connector base in `docs/research/openmuse-connectors-scout.md`.
- Compared the current official MCP client and Pi MCP adapter ownership boundaries. This is source research only: no runtime implementation, account connection, external API action, or live compatibility test.
- Verified source link line bounds and whitespace; no application tests were needed for these documentation-only changes.
- Follow-up web research clarified the direct-first scope: no MCP dependency is required. Added native SDK, Nango auth, and Composio direct-tool options; revised the first slice to a Google extension only.

## 2026-09-22 — Composio in OpenClaw and Hermes

- Inspected the current Composio OpenClaw plugin, Hermes MCP/OAuth sources, and Composio CLI/SDK documentation. Recorded the plugin's CLI route, the setup pages' HTTP MCP route, and Profile/account ownership implications in `docs/research/composio-openclaw-hermes-scout.md`.
- Recommended evaluating one optional Composio adapter for broad app coverage before building a general connector framework. No installation, login, live account action, or runtime code change was performed; documentation whitespace check passed.

## 2026-09-24 — Remove bundled Jev extension

- A live probe against api.typesafe.ai showed the extension rejected valid Score answers: it required |score - Σ i·p_i| <= 0.005 and probability sums within 1e-6, but the API returns probabilities rounded to 2 decimals while score comes from unrounded values; score10 and a 12-question mixed request failed 3/3.
- No repository code consumed its ziggy:jev:judgment:v1 bridge.
- Jev integration is owned by pi-computer-use and will arrive through a future vendored computer-use release. Profiles that already shelved jev keep their copy until `ziggy extensions remove <profile> jev`.

## 2026-09-24 — Remove dev-browser and agent-browser; catalog test invariants

- Removed the bundled `dev-browser` and `agent-browser` extensions; browser control belongs to `computer-use` (pi-computer-use). No Profile enabled either.
- The bundled-catalog resource test now derives packages, executables, and skills from `BUILTIN_PACKAGE_METADATA` and asserts invariants (extension folders match the catalog, loaded skills match declared skills, tool names are unique and active) instead of hardcoded counts and tool lists.
- Verification: `bun run check` and `bun run test` passed.

## 2026-09-28 — Pi family upgrade to 0.87.1

- Pinned `@earendil-works/pi-coding-agent@0.87.1` (lockfile resolves `pi-ai`, `pi-agent-core`, `pi-tui` and siblings at 0.87.1) and bumped extension peer pins to Pi 0.87.1 and Pi's bundled `typebox@1.3.27`.
- Reason: Pi 0.84.1's static catalog lacked GPT-6 models, and Ziggy never enables Pi's network catalog refresh, so `gpt-6-luna` was "unknown model" and `models status` reported a working `gpt-6-astra` Profile as unconfigured.
- Breaking changes in 0.86/0.87 (`shouldStopAfterTurn`, canonical `SessionManager` context, `TurnEndEvent`, `TranscriptContext`) touch no Ziggy source. Only a TUI-extension test fixture needed the new `NormalizedBuildSystemPromptOptions` shape.
- Regenerated pi-docs embeds and the builtin catalog; version strings in pi-docs, tui-themes, and their tests follow the pin.
- Verification: `bun run check` and `bun run test` (733 pass) passed. Live: a fresh Profile on `openai-codex/gpt-6-luna` high answered in 2.5–4s; one first request stalled until the 300s Codex WebSocket idle timeout before Pi's retry succeeded. The installed binary and `~/.ziggy` were not touched.

## 2026-09-28 — Core review plan and workstream base

- Added `docs/plans/core-review.md`: section-by-section tightening pass from the 2026-09-28 core review, with a Workstreams table that splits parallel sessions by file ownership.
- Decisions: keep Pi as the only agent loop, headless, and don't own the core (PiG and openclaw show the cost); remove the TUI in favour of the resident-served web UI and UI SDK; no Codex app-server or Claude SDK runtime; extensions stay plain Pi extensions.
- Added `fast-check@4.10.2` as a dev dependency so every stream can add property and fuzz tests without touching `package.json`.

## 2026-09-28 — Remove local TUI and harden resident attach

- Removed the local TUI (`ziggy-tui-extension.ts`, `tui-themes.ts`, `automation-tui.ts`, `extension-multi-select.ts`, the `openTui` path, specialist render hooks), about 2.5k lines. The web UI and UI SDK served by the resident are the interactive faces; `ziggy tui` now reports that the TUI was removed.
- Bare `ziggy <profile>` attaches to a running resident, or starts an already-installed service, and prints the UI URL with a `ziggy web pair` hint. It never installs a service; if none is installed it prints the `ziggy serve` commands and exits 1. Service-status failures keep their typed error.
- A new resident owner removes the previous `ui-server.json` before its UI starts, so attach never prints a stale port. URL discovery retries only while the file is missing.
- Remaining web UI gaps: extension picker, per-session model/thinking switching, older-session resume picker.
- Verification: `bun run check` and `bun run test` (711 pass) passed. Opus re-review: all findings resolved.

## 2026-09-28 — Codemode setup, pi_docs policy, and headless skill guidance

- Codemode: a missing `codemode.json` now gives a schema hint and points to a setup skill; the tool description states the interpreter contract (no classic `for`, `try/catch` or `throw`); MCP `isError` content reaches the script, capped at 4 KiB; config errors name key paths, never values.
- Offline `pi_docs` includes Ziggy's Profile resource rules.
- Replaced TUI instructions in `docs/operations/*.md` and the preloaded skills with resident web UI and CLI flows, and regenerated the packaged references. The extension-authoring skill says extensions run headless: `ctx.ui` confirm returns `false`, select and input return `undefined`.
- Verification: `bun run check` and `bun run test` (714 pass) passed. Opus re-review: merge.

## 2026-09-28 — Chat gateway health, bounds, and recoverable sockets

- Slack: a cancelled queued turn now decrements `queuedTurnCount`. A model-based property test checks that health counts never go negative and that queued ≤ active.
- Both gateways cap pending turns at 8 per chat. The overflow "busy" reply is forked into the gateway scope, at most one per chat until there is room again. WebSocket frames are bounded at 8 MiB; Slack text is accepted up to 40,000 characters.
- Oversized or undecodable frames no longer stop a gateway. Slack drops the frame without acknowledging it, and Slack's bounded retry stops redelivery. Discord reconnects with a fresh session (resuming would replay the bad event), using the existing backoff capped at 30s.
- Removed the unused `slackHeartbeat` and its test. The Slack and Discord turn schedulers were not merged: steering and ingress settlement differ.
- Verification: `bun run check` and `bun run test` (720 pass) passed. Opus re-review: merge.

## 2026-09-28 — Plan: extensions run without the resident

- A Fable review of Ziggy, hermes-agent and openclaw confirmed that extensions already run headless in every host, and that the resident should own only connections, live sessions, the cron ticker and interactive UI.
- Added a per-session writer lease to section 11 (today concurrent writers silently fork a session), headless `ctx.ui` defaults to section 5, and section 12 "Headless hosts and the resident" (conversation delivery from `wake`, a no-resident schedule warning, `extensions update --restart`, an optional `ziggy tick`), owned by a new `headless` stream after `auto` and `adapter`.
- Recorded the decision: the resident is optional for extensions; no outbox, no broadcast port, no silent fallback.

## 2026-09-28 — UI command cache lifecycle and gateway split

- UI commands run in a gateway-owned scope (`makeUiGateway` is now scoped and built inside the resident's scope), so closing the socket that sent a command no longer interrupts it or causes a duplicate run on retry. The child fiber starts masked, only the command itself is interruptible, and waiters always get a frame, including at shutdown.
- A slot is claimed with no yield between lookup and insert. Only successful responses are cached, evicted oldest-completed first; pending slots are never evicted.
- Split `ui-gateway.ts` (1,578 → 411 lines) into protocol modules, including `sessions.ts` and `groups.ts`, and removed the `management.ts` barrel.
- Tests: a command-cache property test, socket disconnect-and-retry through the real UI server, immediate shutdown, and the server's inbound size limit.
- Verification: `bun run check` and `bun run test` (729 pass) passed. Opus re-reviews: all findings resolved.
- Follow-up: the scheduler is not resident-only. Section 12 now requires `ziggy tick` driven by a launchd or systemd timer, so automations fire without the resident; the owner lease keeps one ticker at a time.
- Owner decisions: skip broken extension packages and warn loudly (section 5); `ziggy wake` hands off to a running resident; `run --continue` refuses on a session the resident holds; no `ziggy tick`, because a resident with no chat config is just the scheduler and web UI; new section 13 and `webui` stream for web UI parity.

## 2026-09-28 — Automation fingerprint fence and scheduler properties

- A claimed scheduled run re-reads its definition and compares the fingerprint with the claim before the gate, the agent or any delivery. On a mismatch it records `failed` with the `schedule-superseded` category, logs one `[wake]` line, and doesn't count as the latest error. The next tick replans from the new schedule.
- Manual admission cannot be interrupted partway. If `start` fails after a manual claim, the claim is marked failed, so later manual runs don't report busy until the process exits.
- Tests:
  - fast-check parser totality: input parses or fails with `AutomationInvalid`, never defects;
  - a cron occurrence model checked against a minute-stepping oracle;
  - a scheduler property: cursors move forward, due run ids never repeat, a fingerprint change resets the cursor;
  - removed a test that only restated an error class.
- Verification: `bun run check` and `bun run test` (735 pass) passed. Opus review findings resolved.

## CLI contracts, first-run recovery and profile-aware extensions

- Moved the CLI command union and `CliInputInvalid` to faces. Setup model status no longer imports the adapter. Removed the redundant `ProfileAgentInvalid` from the unions and deduped the `SessionTerminalState` literals.
- A failed non-interactive init maps doctor errors to the commands that fix them (`ziggy auth`, `ziggy models set`) and never suggests opening a broken Profile.
- `extensions list|show <profile>`: checks that the Profile is initialized, resolves Profile-local packages, lists selected-but-missing ids, labels them "selected in", and encodes `--json` through Schemas.
- A bounded fast-check property says argv decoding always ends in success or exactly one typed input error. It covers subcommand vocabulary.
- Codex OAuth import is on hold for an owner decision (read in place, not copy).

## Web extension picker

- The web settings list, enable and disable Profile extensions through the same `ProfileExtensionsApi` add/remove as the agent tool, so preflight, required-extension rejection and rollback are shared.
- The listing cap is now 64, the same as the agent tool, and reports `truncated` when the frame budget applies. Selected ids that aren't listed stay removable.
- Typed preflight reasons from `ZiggyGatewayError.details` are shown. A confirmed mutation updates the selection before a best-effort refresh. Unknown and selection-changed outcomes reconcile from the server. Extension state no longer races `loadModelSettings`.
- `restartRequired` is sent on the wire, and the web says to restart the resident (`ziggy serve restart <profile>`); the resident doesn't hot reload.
- Per-session model/thinking switching and the resume picker are waiting on adapter capabilities (round 3).

## Adapter review, session ownership and quarantine

- Removed duplicate Pi prompt helpers; provider failures shown to users are bounded and sanitized.
- Persistent sessions take a per-session SQLite writer lease (`BEGIN IMMEDIATE`, `busy_timeout` 0) before Pi loads the transcript, hold it for the handle's lifetime and transfer it across new/fork/switch. A switch that fails before teardown keeps the old session usable. Print mode rejects session replacement. Chat, specialist, gateway and stored automation appends use the same lease; a held session fails with a typed `SessionHeld` that the CLI renders plainly and automations record as `session-held`.
- Broken optional extension packages are skipped, not fatal: doctor, `extensions list` and the agent tool report them, their owner-tagged automations pause (records kept, resumed once healthy), and `extensions add` still rejects a broken package. Core inline diagnostics stay fatal.
- Profile filesystem, doctor probes and resident platform operations sit behind application ports.
- Tests: multi-process lease race, killed holder releases, interruption, pre-teardown switch failure, quarantine pausing, per-turn memory refresh.
- Left for the cleanup pass: loading extension factories once under quarantine; doctor and resident policy still partly in adapters. Web session adoption goes to webui round 2.
- Verification: `bun run check` and `bun run test` (756 pass) passed. Two Opus review rounds resolved.

## Live session controls

- Chat and runtime session handles expose the current model and thinking level, session-scoped `setModel`/`setThinkingLevel` (the Profile default is unchanged), and `resume` by session id or a path inside the Profile's `sessions/`. Resume reuses the lease transitions: a held target is refused and the current session stays usable.
- Controls and Pi-command session switches run one at a time and fail with a typed `SessionBusy` while a turn is streaming. Event subscribers follow the session across resume, `/new` and `/fork`.
- `listProfileSessionSummaries` lists id, title, last activity and whether the session is held, without opening transcripts for writing; bad transcripts are skipped with a warning. Real lease acquirers wait up to 40 ms so a listing probe can't cause a false refusal.
- `listProfileExtensionsWithHealth` returns the listing plus skipped packages and their diagnostics for the UI gateway.
- Verification: `bun run check` and `bun run test` (758 pass) passed. Opus review findings resolved.

## Adapter resume hardening

- Session lookup skips unrelated corrupt, symlinked and duplicate transcripts, and refuses only an ambiguous id, so one bad file no longer blocks resuming good sessions.
- Resume marks the session as switching: prompts, steers, follow-ups and re-entrant extension session commands fail with `SessionBusy` instead of racing teardown or deadlocking on the control lock.
- Event subscriptions rebind before extension binding, and each rebind listener is removable on its own.
- Verification: `bun run check` and `bun run test` (759 pass) passed.

## Web UI session controls

- The resident web UI switches model and thinking level for the active session, resumes older web transcripts from a picker, and shows skipped extensions with their diagnostics in the extension picker. A held or streaming session shows as busy.
- Resume accepts only a stored session id and only plain web transcripts (`local/main/` and single-level `ui/<name>/`); group, specialist, automation and channel transcripts are refused on the server, and the picker's `canResume` comes from the same check.
- After a resume or a model change the gateway clears the replay buffer and emits a `session-state` reset, so every client reloads history; stale replay cursors get `replay_gap`.
- Extension health is a required gateway dependency; a preflight failure degrades to a listing with a diagnostic.
- Verification: `bun run check` and `bun run test` (768 pass) passed; ui-sdk and web client suites pass. Opus review findings resolved; the resume/reset race and summary scan cost are left for the cleanup pass.

## Headless resident lanes

- `deliver` to a `conversation:` target without a registry appends the stored receipt under the session writer lease; the receipt check keeps replays idempotent, and a held lease is a plain retriable refusal.
- `ziggy wake` reads the owner lease and UI projection first. With a running resident it calls `automation.run` over the UI socket and renders the full outcome with the same stderr and exit code as an in-process run; otherwise it runs in-process. No fallback after the fact. An unsent request fails after a 10 s connect deadline as safe to retry; a sent request waits up to 30 minutes and reports an unknown outcome if the answer is lost. The token is never printed.
- `automations status` and `extensions add` warn when schedules will not fire because no resident service is installed.
- `extensions update --restart` stages and validates, stops the managed resident, applies under the update lock and starts it again; a pending recovery journal keeps the resident stopped and prints quoted recovery commands. Without `--restart` the refusal names the flag.
- Wake migration contention reads "resident is starting; retry"; CLI session refusals name the holding process.
- Skills: `docs/operations` automations, extension-updates and sessions, and `extension-authoring`, now cover the wake handoff, `--restart`, one writer per session, web resume and model switching, and broken-package skipping.
- Verification: `bun run check` and `bun run test` (782 pass) passed. Opus review and two verify rounds resolved.

## Fresh Profile end-to-end fixes

- End-to-end pass on a fresh scratch Profile (init, run, resident, web pairing, web chat, per-session model and thinking, resume picker, extension picker, automations create/wake/run, session-held refusal) found the gaps below; all fixed.
- Pairing uses the running resident's recorded UI port when the configured port is 0 and refuses a port-0 link when no resident runs; the token is never printed. Init, `automations status` and extension hints print the real quoted Profile path; a foreground resident no longer triggers "schedules will not fire"; init's next step is `serve install` then `web pair`; unknown provider/model hints use placeholders instead of repeating the bad value.
- Required core packages get an update receipt when published. At resident start a receipted copy that still matches its receipt is refreshed when the bundled content differs (content hash, not version), through the existing update path and lock; failures never block start. Doctor reports edited copies (restore, then update) and untracked copies behind the bundle (`--adopt`).
- The web client uses the Profile name (tab title included) with a Ziggy fallback; `--restart` is in `ziggy help extensions`; operations guidance covers new-Profile setup, pairing, the writer lease and the wake handoff.
- Verification: `bun run check` and `bun run test` (784 pass) passed. Opus review plus one verify round resolved.

## Web UI redesign

- Base reset moved under Tailwind's base layer; design tokens (spacing, type, radii, colour, motion) with a `prefers-color-scheme` dark theme; dialogs get header/body/footer slots, a lighter overlay and CSS enter/exit motion that respects reduced motion.
- Shared primitives: button press feedback, Switch, Badge, a discrete StepSlider and one searchable Combobox used by the model and automation destination pickers.
- Settings is a tabbed dialog (Model, Session, Extensions, Providers, Connection) with panes kept mounted. Thinking is a Faster/Smarter slider limited to the model's supported levels, debounced for keys, resynced to the saved value and showing "Not set" for unknown values. Extension switches apply immediately with a filter and a persistent restart bar.
- The restart hint uses a server-sent `cliTarget` from `profile.current`: the folder name only when it resolves back to the same path under the Profiles directory, otherwise the absolute path.
- Sidebar rows share one grid; the chat header is centred on the transcript column with author shown once per run; automation detail shows a readable name and schedule; mobile drawer uses the shared easing and 40px touch targets.
- Verification: `bun run check` and `bun run test` (785 pass) passed; web suite 80 pass. Opus review findings resolved.
- Polish after a live check: settings load once the socket and Profile are ready (startup no longer auto-opens or auto-closes the dialog), full-width thinking slider, visible off switches in dark mode, restored extension row padding, and a `min(640px, 100dvh - 64px)` desktop dialog height.

## 2026-09-28 — Release 0.3.0

- Bumped to 0.3.0 and moved the Unreleased removals into a 0.3.0 changelog covering the core review: TUI removal, session writer lease, skipped broken extensions, wake handoff, `extensions update --restart`, required-package refresh, Pi 0.87.1 and the web UI redesign.

## Chat gateway cleanup

- Slack and Discord gateways are split into intake, delivery, turn and runtime modules, with shared contracts in `slack/model.ts` and `discord/model.ts`. The Slack API is split into protocol and client code, and the Discord socket into framing and connection code. The public gateway exports are unchanged.
- The two gateways shared identical health-counter transitions, which now live in `domain/chat-health.ts` and return complete counts. The turn schedulers stay separate on purpose: Slack can steer an active turn and settles cancelled ingress, while Discord queues accepted turns and requeues interrupted ingress.
- Fixed: a Slack turn stopped during acceptance left `activeTurnCount` one too high. Acceptance is now recorded inside the uninterruptible acquire, so a release always follows it.
- Verification: `bun run check` and `bun run test` (786 pass) passed. An Opus review found no behavior drift, and its findings are resolved.

## UI gateway cleanup

- The wire protocol in `domain/ui-gateway` is split into fields, result families and frames, behind an explicit barrel with main's export list. Response transport encoding moved out of the application dispatcher, and cache fingerprinting now sits with the command cache.
- Session switches are serialized per live handle. Resume plus its transcript reset runs uninterruptibly under the session-control lock, while waiting for the lock stays interruptible. Prompt submission takes the same lock only for submission, so a prompt can't land between the Pi switch and the reset. Model status stays lock-free.
- Fixed: a `serve` killed while first creating `.gateway/web-access.sqlite` left a half-built database, and every later `serve` for that Profile failed. The schema check, the rebuild of a known partial version-0 file, and the version write now run in one immediate transaction with a busy timeout, and concurrent openers tolerate the `.gateway` directory already existing. Three concurrent openers on a fresh Profile succeeded 180 of 180 times.
- Tests: controlled interleavings for overlapping resumes, interruption before reset, and prompt-before-reset (each fails on the old code); partial-schema recovery; the resident hard-crash test waits for UI startup and passed 20 of 20 runs.
- Left open: the session-summary scan cost needs a per-transcript cache in `adapters/pi/sessions.ts` (after the Pi adapter cleanup). A prompt followed by a resume can still fail the prompt instead of ordering them.
- Verification: `bun run check` and `bun run test` (791 pass) passed. Two Opus review rounds resolved.

## Pi adapter cleanup

- `adapters/pi/pi-agent.ts` shrank from 2,871 to about 1,620 lines. The memory tool, event projection, chat runtime binding, provider failure mapping and prompt turn each moved into their own modules. Model selection moved to `application/models.ts`, and resident readiness to `application/resident-service.ts`, with the launchctl/systemctl parsers in `adapters/bun/resident-service-operations.ts`. Doctor models bundled-copy state as a `BundledCopyState` union.
- Every runtime rebuild (new session, resume) now partitions resource diagnostics against the accepted set. A healthy rebuild runs each package factory once, which resolves the factory-once deferral. An optional package that breaks mid-lifetime is quarantined instead of killing the chat. Core and inline failures stay fatal. Two behavior changes: a quarantined package stays excluded until the runtime is recreated, even if it heals, and a quarantine after startup doesn't pause that package's automations until the Profile restarts (its diagnostic says so).
- `residentReady` now rejects an owner pid that differs from the supervisor pid.
- Session summaries: a 512-entry cache keyed by path, mtime and size closes the summary-scan item left open by the UI gateway cleanup. Lease files outlive their holders, so listings no longer check holds for every transcript. `Sessions.held` checks only the at most 32 rows the web picker returns.
- Tests: a skill that breaks mid-lifetime is quarantined on the next `newSession` (it fails on the old code), and the picker checks holds only for the rows it returns.
- Left open: the resident-service parsers are exported but have no users outside their module.
- Verification: `bun run check` and `bun run test` (796 pass) passed. Opus review rounds resolved. One full test run had a single failure that didn't recur in the next two runs.

## Slack turn progress redesign

- Each turn gets one Slack message. A native stream starts when the turn is accepted and carries the plan and the answer; placeholder-then-update delivery is the fallback when streaming is unavailable. The plan title is the headline ("Running tests · 1m 40s", then "Done in … · N steps", "Stopped after …" or "Couldn't finish · …"), and `assistant.threads.setStatus` mirrors it, updating on a phase change or at most every 10s.
- A pure reducer (`domain/slack-turn-progress.ts`) groups tool calls into phase steps by toolCallId, so parallel calls interleave correctly. A failed or interrupted call never shows as complete, and completed steps read in the past tense with edited file names. Steers add a "Picked up your note" step and a reaction. Specialists show as steps, and their voice posts are kept.
- Delivery of the final answer alone decides the outcome of the turn. Failures of progress appends, status updates or reactions are only logged. If `stopStream` fails, the first chunk is posted instead. Streamed text is a stable prefix: at finish, only the remainder is posted, in chunks of at most 4,000 characters, and divergent text goes in a follow-up post instead of replacing the plan.
- Slack API requests now time out after 30s as retryable network errors, so a stalled transport can't hang final delivery or shutdown.
- Accepted residual risks:
  - If `startStream` times out after Slack created the stream, an orphaned "Thinking" plan can sit beside the fallback answer.
  - An overflow post that fails partway re-posts from the first chunk, so text is duplicated rather than lost.
  - A failed step reads "failed", because Pi tool-end events carry no reason.
- Tests: reducer properties over interleaved tool calls; long answers delivered exactly once across newline and hard chunk boundaries (fails on the pre-fix code); the restored gateway invariants (attachments and images, health write failure, disposal, ingress order, recipient ids, interrupted progress). No live Slack workspace check was run.
- Verification: `bun run check` and `bun run test` (804 pass) passed. Three Opus review rounds resolved.

## web-search gains fetch_url

- Squarey's local `web-access` package re-registered the bundled `web_search` name and added `fetch_url`, which the `librarian` agent depends on. The owner chose to keep web-search as the only web package, so `fetch_url` moved into `extensions/web-search/fetch-url.ts`. Squarey can now swap `web-access` for `web-search` without editing `librarian.md`.
- `fetch_url` accepts only HTTP(S). It refuses local hostnames and private, loopback, link-local, CGNAT and multicast addresses, both as literals and after DNS resolution, and re-checks every redirect hop (up to 5). Unrecognised address shapes, including hex-form IPv4-mapped IPv6 such as `::ffff:7f00:1`, are treated as private. Bodies are capped at 5 MiB and output at 24 KiB. Jina Reader is used only for an error status or a short or JavaScript-shell HTML page, and receives the final public URL.
- Changes from the web-access original: the tool's abort signal now cancels requests, the IPv4-mapped IPv6 check was added, redirect bodies are released, and the user agent is `ziggy-web-search/0.1`.
- Known limit: DNS is resolved separately from the fetch, so a host that rebinds between the check and the connection can still reach a private address.
- Tests: address classification, rejection of non-public targets before any network I/O, the body byte cap, and the registered tool list. A live smoke fetched example.com through the Jina fallback and refused an httpbin redirect to 127.0.0.1.
- Verification: `bun run check` and `bun run test` (812 pass) passed.

## Squarey extensions cleanup

- `~/.local/bin/ziggy` rebuilt from `ec06c08f`, then one planned stop/start of the Squarey resident, rehearsed first on a scratch copy of the Profile.
- `--adopt` updates brought web-search (now with `fetch_url`), apple-reminders, computer-use, computer-workflows, executor and github up to the bundle. For all but web-search the only differences were Pi peer pins and blank lines.
- web-access was replaced by web-search in the selection, so `librarian` keeps `web_search` and `fetch_url`. jev was unselected.
- The jev, dev-browser, pi-web-access, lossless-claw and web-access folders moved to `.runtime/extension-backups/cleanup-20260929-191307/`.
- gog and self-improvement keep their intentional local edits. pi-bridge, imessage-capture, frontend-design and research-source-triage stay Profile-local.
- Codex OAuth import skipped: Squarey already has its own `openai-codex` login, and sharing `~/.codex` would make two clients rotate one refresh token.
- Verification: doctor green apart from the pre-existing 3 broken session parent links; no quarantine in the resident log.

## Pi family upgrade to 0.99.1

- Pinned `@earendil-works/pi-coding-agent@0.99.1`; the lockfile resolves `pi-ai`, `pi-agent-core` and siblings at 0.99.1. Extension peer pins, the pi-docs generator pin and the version strings in docs and tests follow. `typebox` stays at 1.3.27.
- Reason: 0.99.0 adds Sign in with ChatGPT on the `openai` provider and renames `openai-codex` to "OpenAI Codex (legacy)".
- No Ziggy source changed. The API changes only touched test fixtures:
  - `steer`/`followUp` now resolve to a `QueuedInputDisposition`.
  - `ToolInfo` requires `exposure`.
  - Tools receive an `ExtensionToolContext`.
- Behaviour change: Pi now writes a persistent session's JSONL on the first user message, not the first assistant reply (Pi #10000). The lazy-session test now asserts that.
- Pi's new built-in codemode, tool-search, MCP and llama.cpp extensions load only in Pi's CLI. SDK hosts such as Ziggy must opt in, so nothing collides with the bundled `codemode` or `mcporter`.
- Regenerated the builtin catalog and pi-docs embeds.
- Squarey was backed up first to `~/.ziggy/backups/squarey-full-20260929` (APFS clone; sockets and Chrome singleton links skipped).
- Verification: `bun run check` and `bun run test` (812 pass) passed. A development standalone binary built and passed `smoke-standalone-executable --allow-development`. No live model turn was run, and the installed binary and `~/.ziggy` were not touched.

## Sign in with ChatGPT

- `ziggy auth <profile> openai --type oauth` now works. Pi 0.99's Sign in with ChatGPT needs `LoginOptions.getDeviceId`, and without it the login failed before any network call. `src/adapters/pi/auth.ts` passes Pi's own `SettingsManager.getOrCreateDeviceId()` for the Profile, so each Profile keeps a stable UUID in its `settings.json`, created on first login.
- `openai-codex` (Pi's "legacy" provider) is left available, not hidden; new Profiles should use `openai`.
- Verification: `bun run check` passed. The rebuilt dev binary, run against a scratch Profile, printed the `auth.openai.com` authorize URL with `ext_agent_host_id=urn:uuid:<id>` and the ChatGPT token scopes, and wrote the ID to `settings.json`. The browser consent and a live model turn were not completed.

## Effect composition plan and live Effect diagnostics

- New plan `docs/plans/effect-composition.md`, from the kvim review of `src/main.ts`. It covers:
  - why the file grew: services don't own their wiring, one layer is built for every command, host state is read at module scope, exit codes bypass the error channel, and command logic lives in the entrypoint;
  - the target shape: a composition root, per-area handlers, `Match.valueTags` dispatch, and per-command layers;
  - five slices, and the lint and skill guardrails.
- The `@effect/tsgo` patch was not applied, so `bun run check` had been running plain `tsc` without any Effect diagnostics. A `postinstall` now runs `effect-tsgo patch`. The two diagnostics it raised as errors (`missingReturnYieldStar` in the Slack gateway and extension lock tests) are fixed.
- 53 warnings and 105 suggestions remain and are not yet enforced (`ignoreEffectWarningsInTscExitCode`). The plan ratchets them.
- Verification: `bun run check` and `bun run test` (812 pass) passed with the patch applied.

## Composition root for the CLI

- `src/composition.ts` is now the one place layers are wired. Each service layer is named once and shared by reference: `ZiggyAgentLayer` over `PiAgentLayer`, `ProfilesLayer`, `DoctorLayer` and the rest. This removes `main.ts`'s 15 `XProvided` constants and the five inline re-spellings of `ZiggyAgentLive.pipe(Layer.provide(PiAgentLive))`.
- `makeCliLayer(resolutionOptions)` returns the CLI's service layer. The chat gateways are wired only under the resident, because no command uses them directly.
- The Pi standalone registration (Bun OAuth flows, the Bedrock module, the Photon WASM fallback) no longer runs at module load. `PiStandaloneRuntimeLive`, a `Layer.effectDiscard`, is provided under the whole CLI layer, so it runs before any command touches Pi.
- `main.ts` decodes the command first. `help` and `--version` answer without building any services. Every other command runs `runCommand` under `makeCliLayer`.
- Removed the unused `makePiAgentLive`.
- Verification: `bun run check` and `bun run test` (812 pass) passed. Smoke-tested `--version`, `help`, `profiles` and `extensions list` from source.

## Delete the dead repositoryRoot parameter

- `repositoryRoot` was threaded through about ten APIs (`PiAgent`, `ProfileExtensions`, `Doctor`, `Setup`, the resident gateway, the extension manager and the UI gateway config), and every sink ignored it. It is gone from `src/` and `test/`, along with the `composition.ts` export.
- `extensions show` now prints paths relative to the current directory, its only real use.
- Verification: `bun run check` and `bun run test` (812 pass) passed. Smoke-tested `--version`, `help`, `profiles` and `extensions show apple-notes` from source.

## ZiggyPaths service

- New `ZiggyPaths` service (`src/application/ziggy-paths.ts`) for Ziggy home, the Profiles directory and registry, and CLI Profile target resolution. `ZiggyPathsLive` (`src/adapters/bun/ziggy-paths.ts`) reads `ZIGGY_HOME` through `Config` and cwd/home when the layer builds. `main.ts` no longer reads host state at module scope for paths.
- `makeResidentGatewayLive(registry, extensionHealth, directory)` is now a plain `ResidentGatewayLive` that yields `ZiggyPaths` and a new `ExtensionHealth` service. `composition.ts` exports a constant `CliLayer`.
- Fix: resident service operations read `ZIGGY_HOME` raw, not resolved against cwd, so a relative `ZIGGY_HOME` could reach launchd/systemd unresolved. They now use `ZiggyPaths`, and their host runtime is built in the layer instead of at module load.
- Verification: `bun run check` and `bun run test` (812 pass) passed. Smoke-tested `--version`, `help`, `profiles`, `extensions show apple-notes`, and `profiles` with a relative `ZIGGY_HOME` from a scratch directory.

## CLI exit codes and terminal style through Effect

- `main.ts` no longer writes `process.exitCode` or prints-then-succeeds. Commands return their exit code; `exitWith` fails with `CliExit` (`src/faces/cli-exit.ts`), which carries `Runtime.errorExitCode` and suppresses `runMain`'s report. `CliCommandFailed` replaces the `fail(message)` helper.
- Failure rendering is 7 `catchTags` entries for tags with extra detail plus one `Effect.catch` on `.message`, down from 61 entries. Any typed failure is now reported, not only listed tags.
- `disableErrorReporting` is removed from `runMain`, so defects print instead of exiting 1 silently.
- `TerminalStyle` (`src/faces/terminal-ui.ts`) replaces `terminalRenderOptions()`. It reads `TERM` and `NO_COLOR` through `Config` and the stdout TTY and columns when its layer builds.
- Verification: `bun run check` and `bun run test` (812 pass) passed. Smoke-tested exit codes from source: `--version`/`help`/`profiles` 0; doctor on a missing Profile, unknown extension, `serve status` on an uninstalled Profile, and an uninitialized Profile all 1 with one printed report. Under a pseudo-TTY `profiles` renders the pretty panel, and `NO_COLOR` drops colors.

## Per-area CLI handlers: models

- `main.ts` dispatches every command, help and version included, through one exhaustive `Match.valueTags`. Commands not yet moved map to `legacy`, which still runs `runCommand` under `CliLayer`.
- `ziggy models status|list|set` moved to `src/faces/commands/models.ts`. It yields only `Models` and `ZiggyPaths`, prints through `Console`, and runs under `ModelsCommandsLayer`, so it no longer builds the resident, gateway and agent layers.
- Verification: `bun run check` and `bun run test` (812 pass) passed. Smoke-tested from a scratch `ZIGGY_HOME`: `help models` 0; `models status` and `models list --provider anthropic` on a fresh Profile 0; both on an uninitialized Profile 1 with one report.

## Tight-core alignment audit

- Added `docs/research/tight-core-alignment-audit.md` and its JSON evidence index: a bottom-up review of 61 current core/composition files (17,255 lines), checked against pinned Effect beta.99 and installed Pi 0.99.1. Every file has a disposition; findings include correction scope, caller impact, proof limits, and implementation order.
- Disposable local fixtures reproduced premature session-writer admission after failed shutdown, a Profile registry lost update, memory-lock symlink traversal, missing acquired-handle cleanup during UI registration failure, and eager runtime-directory reads. No production source or Profile data was changed; existing CLI extraction work was preserved.
- Verification: `bun run lint` and `bun run typecheck` passed. The 32-file focused core test run had 230 pass and 1 fail; the optional-Pi-diagnostics activation test also failed in isolation because it expected model-selection failure but obtained a chat handle. The report records that unresolved test/startup-contract mismatch. No full-suite, live provider/gateway, or footprint claim is made.

## Tight-core rebuild plan

- Added `docs/plans/tight-core/`, a working plan spanning several sessions. `README.md` is the synthesis: a reach table, the mistake patterns, per-area targets, decisions D1–D16, an e2e verification loop with proofs P1–P19, slices 0–9, a disagreement ledger and a bug list. `areas/` holds five area reviews and two challenge reviews (Fable, and a devil's advocate for the current design).
- The challenge round corrected draft v1, which had dropped guards without naming the invariants they protected:
  - The writer lease stays, as a lease held for the handle's lifetime that moves across switch, `/new` and `/fork` (web `/new` followed by `run -c` would otherwise branch the transcript).
  - The `.owner` pid stays.
  - The extension selection lock stays.
  - `update` gets `.old` crash recovery.
  - Required packages go to a cache directory for each Ziggy version (embedded-only breaks the relative `references/` links).
  - Sessions keep the streaming scan (the largest transcript is 376 MB).
  - The resume-ordering tests move to handle level.
- Documentation only. No source changed and no checks run.
- 2026-09-30: Rewrote `docs/plans/tight-core/README.md` bottom-up. It now covers:
  - the `src/` inventory, showing each concept spread across 5–9 folders and 34 of 53 `application/` files importing adapters;
  - a three-folder core (`profile/`, `session/`, `extensions/`), with agents, memory and resident built on top through a tool seam;
  - the `Context.Service` + `make` + `static layer` service syntax, and where each of the 34 services goes;
  - Effect patterns before and after;
  - the plain-language areas, the work order, and three open questions.

  Documentation only; no checks run.

## Per-area CLI handlers: sessions and memory

- `ziggy sessions list|show` and `ziggy memory list|show` moved to `src/faces/commands/sessions.ts` and `memory.ts`. They run under `SessionsCommandsLayer` and `MemoryCommandsLayer`, so they build only their own services.
- Verification:
  - `bun run check` and `bun run test` (812 pass) passed.
  - Smoke-tested from a scratch `ZIGGY_HOME`: `memory list` and `sessions list` on a fresh Profile both exit 0.

## Tight core, step 0: harness and end-to-end proofs

- `test/harness/` drives the real product from outside:
  - a scripted OpenAI-compatible SSE model server (`provider.ts`: text, tool calls, failures, a turn held open by a gate);
  - scratch Profiles in a tmp `ZIGGY_HOME` with `HOME` split from it, plus `treeHash` for "nothing changed";
  - the real `bun src/main.ts` (`cli.ts`), a real `ziggy serve` driven through `packages/ui-sdk` (`resident.ts`), Pi transcript reading (`transcript.ts`);
  - `sandbox.ts` for driving by hand.
- `test/e2e/` proves run, profiles, models, sessions, web sessions (reconnect mid-turn, shared main), single writer, `agent_run`, memory (next turn, group scope, cap), automation delivery (stored with and without a resident, live idle, live busy) and ACP.
- Red proofs (`test.failing`) mark the known bugs step 1 fixes:
  - `profiles` rewrites `profiles.list`;
  - ACP `session/set_model` is ignored;
  - `agent_run` returns an unbounded result;
  - an agent declaring an unknown tool or `profile_extensions` is only noticed at call time.
- `.agents/skills/verify-ziggy/` plus `features/` map every user flow to its recipe and proof, and record what is uncovered. "One automation run delivered twice gives one receipt" is unreachable end to end, because nothing re-sends a run.
- Lint: `test/harness/` and `test/e2e/` count as adapter code (they own processes, sockets and Promises).
- An independent verifier reviewed the harness. It confirmed every red proof fails on its intended assertion and caught leaks: a failed proof left `ziggy serve` or `ziggy acp` running. Fixed:
  - `stopResidents()` runs in `afterEach`, a resident that never comes up is killed, CLI children are killed at 4.5 s, and ACP closes in `finally`;
  - `eventually` treats `false` as "not yet";
  - the mid-turn reconnect now rewatches before the turn ends;
  - single writer also proves no model call and an unchanged transcript;
  - the cap proof seeds `MEMORY.md`;
  - `wake` forwarding to a running resident is proven.
- Found while doing so: Effect's `Cron.next` throws for a cron that parses but never fires (`0 0 31 2 *`), and the scheduler calls it unguarded, so one such automation file keeps `serve` from starting. Recorded as a red proof and added to step 1.
- `bun run test` now runs files with `--parallel`; `bun run test:e2e` runs only the proofs.
- Verification:
  - `bun run check` passed.
  - `bun run test` gave 836 pass in about 13 s (budget 15 s); e2e alone is about 7 s (budget 10 s).
  - A deliberately failing proof with a resident up leaves no `serve` process.
  - The sandbox recipe was followed by hand: doctor all OK, `run` printed `ok`, and one request was logged.

## Tight core, step 1: free fixes

**`profiles` is read-only.** `listProfiles` no longer rewrites `profiles.list` to prune stale entries; it skips them. PROF-2 flipped green; the unit test now asserts the registry is untouched.

**Delivery targets decided.** Conversation delivery stays: Squarey's `linkedin-jobs` sends to a Slack channel and a UI conversation at once. Plan step 7 now routes delivery through gateway-owned targets (Slack/Discord channel or thread, Telegram chat, ui-sdk conversation) behind one `deliver` seam, and gives the chat APIs a base URL so the harness can prove gateway delivery.

**A cron that never fires is invalid.** `parseAutomationFile` rejects a cron that parses but never fires (`0 0 31 2 *`) with "cron never fires", so Effect's throwing `Cron.next` is never reached and `serve` starts. AUT-5 is green.

**ACP `set_model` applies.** The face stored a `modelOverride` nothing read; it now calls the session handle's `setModel` and the field is gone. ACP-2 is green; the face unit test's fake handle records the applied model.

Once, a combined `bun run test` stalled with one worker at 100% CPU; three reruns and every folder alone pass (836 in ~12 s). Not reproduced; watch for it.

**Children refuse `profile_extensions`.** Both blocked-tool lists (the child selector in `adapters/pi/specialist.ts` and the agent validator in `profile-agents.ts`) now include it; children load no Profile extensions, so it used to pass validation and vanish. AG-3 was rewritten: the step-0 version demanded that one bad agent file fail the whole `run`, which would break a Profile over one file. It now proves `agent_run` is refused, no child file exists, and the child never reaches the model (confirmed red without the guard).

**`agent_run` is bounded and said once.** The tool content is the child answer cut at 3,000 code points, with a note naming the child session file when cut; `details.result` no longer repeats the answer. `ziggy agents run` and the ui-sdk agent verb still return the full answer from the runner. AG-2 is green; every proof is now green (24).

**A switched-away target gets the stored receipt.** Resuming another session in the UI releases the old file, so delivery already stored the receipt (AUT-6, green from the start). The real gap was a race: `session.resume` holds a gateway permit, not the registry's `statePermit`, so the owner could switch between the registry match and the live append, and the handle answered `destination-missing` (non-retriable), losing the run. `deliverAutomationResult` now falls back to the stored append when the live owner reports `destination-missing` or `session-held`. The unit proof fakes a handle whose live session moved on; it was red before the fix.

The progress board source (`docs/plans/tight-core/status.html`) is no longer tracked; only the published artifact matters.

**Session stats count Pi's `usage` entries; history drops the `toolCall` branch.** `sessions.ts` added usage from messages, compactions and branch summaries but skipped Pi's `usage` entries (e.g. `cache_warm`); they now count, and the stats unit test carries one (red before). `session-history.ts` projected a `toolCall` entry type Pi never writes (tool calls live inside the assistant message) and tracked starts in an `activeTools` map; both are gone, and a tool entry now takes its name from the `toolResult` message, which is where Pi writes it. The history test no longer fabricates the `toolCall` record.

**No test seams in `ChatHandle`.** `currentSession` and `appendAutomationResult` are required; both production handles already supplied them, so the `=== undefined` branches in the registry, the gateway session verbs and group listing are gone (among them a "live session history is unavailable" failure no real handle could reach). `makeChatHandle` moved from `application/agent.ts` to `test/harness/chat-handle.ts`; its fake has no session and refuses automation results as `owner-unavailable`.

**`runtime.ts` and `ZiggyAgentLive` are gone.** `composition.ts` provides `ZiggyAgent` straight from `makePiAgent`; the `PiAgent` service class and its `PiAgentApi` twin of `ZiggyAgentApi` were a second name for the same thing. `ChatSessionMode` moved to `application/agent.ts`, so application code no longer imports the Pi adapter.

**Verifier pass on step 1.** No bugs found. Follow-ups applied: ACP `set_model` during a prompt answers `invalidRequest` ("has an active prompt") instead of an opaque internal error, and other failures keep their cause; `listProfiles` drops the unused `initialized` field; AUT-6 asserts the delivered run outcome rather than the absence of "category"; the AG-2 e2e drops an assertion that passed before the fix (the unit test proves `details.result` no longer repeats the answer). The history `phase: "start"` literal stays in the wire schema for now; history only produces `"end"`.

**`ChatRegistry` loses four test-only members.** `registerAlias`, `unregisterAlias`, `subscribe` and `replay` had no production caller; with them go `ChatRegistryListener`, `ChatRegistryReplay` and the unsequenced listener loop in `emit`. Channels use `openAlias`/`closeAlias`, and the UI uses `subscribeSequenced`, which already replays the retained window. Tests now open channels with `openAlias(key, kind, Effect.succeed(handle))`, read the retained window through a throwaway `subscribeSequenced`, and the stale-unregister test became "closing a stale channel handle cannot remove the live one", the same guard on the path production uses.

**The GitHub extension source is gone.** Every catalog entry is bundled, so `adapters/github/extension-catalog.ts` (`ExtensionArchiveClient`), the tar extractor, `publishSource`, `makeExtensionInstaller`, `GitHubExtensionCatalogEntry` and `ExtensionCatalogUnavailable` had no path to run. `makeProfileExtensions(preflight, lock, catalog?, automation?)` and `makeExtensionUpdate(profiles, lock, options)` install through `installBundledPackage`; the catalog schema accepts only bundled entries, and an install failure's `reason` is `validation` or `filesystem`. `ZiggyUpdateUnavailable` stays for self-update. The ui-sdk `"remote"`/`"remote-approved"` literals stay so the wire protocol and web client do not change.

**E2E proofs get a 30 s default timeout.** A proof spawns the CLI up to three times; under the parallel suite "with no resident, each wake stores one receipt" crossed bun's 5 s default in two of three runs. `test/harness/cli.ts`, which every e2e file imports, sets it. Seen once each and not reproduced in three reruns: the codemode "external cancellation interrupts an in-flight MCP call" failure, and a whole-suite run that printed nothing before the 240 s alarm (the stall noted earlier).

**`src/platform/` holds the shared low-level pieces.** `file-lock.ts` is the one hardened SQLite `BEGIN IMMEDIATE` lock: the root must be a real directory, directories under it are created 0700 and symlinks are refused at every step, the lock file is 0600 and opened with `O_NOFOLLOW`, sidecars must be regular files, and a `waitMs` retry runs every 50 ms. The extension lock (2 s), memory writes (2 s) and the gateway owner lease (no wait) use it and map `FileLockFailed` to their own errors; the Profile runtime lease opens its database through it until step 4 deletes it. `atomic-write.ts` (`writeFileAtomic`: private sibling, sync, rename, remove the sibling on failure) replaces the copies in memory and the gateway-owner projection; the other stores move when their concept does. `paths.ts` merges `application/ziggy-paths.ts` and its Bun layer, and `ZiggyPaths` now holds locations only (`cwd` included). `resolveProfileTarget(value, paths)` stays in `domain/profile.ts`, so `platform/` imports nothing from Ziggy. `adapters/fs/cause.ts` moved to `platform/cause.ts`, and every importer points at the new path (no re-export). Lock release failures are now logged rather than returned; nothing could act on them. The oxlint Effect rules treat `src/platform/` as an adapter boundary.

**`ziggy/import-boundaries` enforces the target layout.** Pi packages may be imported only in `src/adapters/pi/` and the `[Pi]` files the plan names (`session/{runtime,handle,agent,tools}.ts`, `extensions/{loader,tool}.ts`, `agents/{run,tools}.ts`, `memory/tool.ts`); `src/platform/` may import only `effect`, `node:*`, `bun:*` and itself; code outside `profile/`, `session/`, `extensions/`, `agents/` or `memory/` reaches them only through their `index.ts`. The rule checks static imports, re-exports and `import()`, and resolves relative and `ziggy/` specifiers; probes for all three violations were reported. `AGENTS.md` describes the target layout and says the old faces → application → domain rule holds until a concept moves. The Effect skills gain the `Context.Service` `make` + `static layer` shape, `Effect.fn("Service.method")`, the service-versus-function rule, resources in a `Scope`, no test seams in production types, the one Pi tool-callback exception, and "one error class per recovery path".

**Verifier pass on step 2.** Waiting for a held file lock is interruptible again: acquisition ran inside `acquireUseRelease`'s uninterruptible acquire, so an aborted `memory_write` or extension mutation waited out the full 2 s (1.9 s measured; now 1 ms). Only the sleep between attempts is interruptible, so an interrupted wait still closes the database it opened. `lockSegments` also refuses `..` and empty segments, the extension lock keeps its Profile-worded messages, and `platform/` may import `effect/*` subpaths. Release failures stay logged rather than returned; nothing could act on them.

**`profile/` is the first core folder.** `src/profile/` holds a Profile on disk: `types.ts` (`ProfileTarget`, target resolution, the Profile, model and auth errors, split out of `domain/profile.ts` and `domain/agent.ts`), `profiles.ts`, `models.ts` and the two `[Pi]` files `pi-models.ts` and `pi-auth.ts` (moved from `adapters/pi/`). Everyone imports it through `profile/index.ts`. `Profiles`, `Models` and `Auth` use `Context.Service`'s `make` with a `static layer`, and fakes type against `(typeof X)["Service"]`. `Profiles` absorbs `ProfileStore` (deleted) and reads `ZiggyPaths` itself, so its API is `init(target, options)`, `register(path)` and `list()`; `Setup.initialize` and `manageExtensions` lose their registry and directory arguments. `readOnlyStatus` collapsed into `status` on `Models` and `Auth`, since both were already read-only. The `[Pi]` file list lives once in `tooling/oxlint/effect/utils.mjs`: import-boundaries uses it, and the Effect rules treat those files and their tests as adapter boundaries, as `adapters/pi/` was. `profiles.ts` keeps one suppressed `node:fs` Promise helper. Not done here: `application/profile-directory.ts` still reads the registry for the ui-gateway's id-keyed directory; it moves with the resident in step 7.

**`session/` is the second core folder.** `src/session/` owns a live conversation: `lease.ts` (one synchronous SQLite `BEGIN IMMEDIATE` per transcript, `takeSessionLease`/`isSessionHeld` returning `Result`, and the `SessionLeaseSet` a handle keeps), `runtime.ts` (`createProfileRuntime`: prompt, resources, contributed tools, model; `disposeRuntime`), `handle.ts` (`makeChatHandle`) and `agent.ts` (`openSession`, `runOnce`, `runSpecialist`, `makeZiggyAgent`). `ZiggyAgentApi` has one `open(request)` taking `{ target, context, directory, session: "new" | "continue", agent?, model?, name? }`; `openChat`, `openSpecialistChat` and the `"fresh"` mode are gone, and every face, gateway and automation calls `open`. Composition passes extensions and the memory, extension and agent tools as `SessionDependencies`. Deleted: `adapters/pi/pi-agent.ts`, `chat-runtime-binding.ts`, `session-lease.ts`, `profile-runtime-lease.ts`, `adapters/bun/profile-runtime-lock.ts` (the Profile-wide runtime lock), the extension-update fence (`requireNoPendingUpdate` in the runtime refuses a pending update instead) and the print-mode `console.error` capture.

**The handle owns its transitions.** One `turn` semaphore: a prompt holds it for the whole turn, and model, thinking and resume controls refuse with `SessionBusy` instead of queuing. Pi builds every replacement session through the runtime factory, whose `beforeServices` hook takes the new transcript's lease first (a refusal comes back as a typed `SessionHeld`); after Pi moves, the handle keeps only the landed transcript's lease and emits `session-state` `transcript`. The chat registry clears its replay window on that event, so the ui-gateway's `resetTranscript` is gone. `steer`/`followUp` fail `ChatNotStreaming` while idle. `makeChatHandle` takes a `HandleRuntime` (the Pi members it drives) so tests use the real handle over `test/harness/pi-runtime.ts`; the fake `ChatHandle` in `test/harness/chat-handle.ts` also emits `session-state` after a successful resume.

**Behaviour changes.** `ziggy run` on a provider error now prints Pi's own provider line before Ziggy's stable `provider request failed` (the capture that swallowed it is gone); the e2e proof asserts the stable last line. Two Pi sessions on the same Profile no longer serialize on a Profile-wide lock; only a transcript is exclusive. Dropped tests: the internal session-reference, `createLocalSessionManager` routing, `run --session` lease and interrupted-build tests (their code is gone), and the live-append poison test (the handle no longer keeps an in-memory dedupe). `test/session/lease.test.ts` proves the holder pid, release and `keepOnly`. Still in `adapters/pi/` for now: `prompt-turn`, `provider-failure` and `chat-event-projector`; the `runPromiseWith` tool helper is step 7.

**Verifier pass on step 4.** Three regressions from the move, each with a test that failed before the fix. An uninitialized Profile is refused before any lease, session directory or `.runtime/` file is created (`openTranscript` checks `SOUL.md` first). A second `prompt` fails `SessionBusy` instead of queueing behind the first or behind a `resume`; it used to run on the transcript the user had switched away from. A live automation delivery trusts the transcript receipt, not the send promise: a send that throws after Pi persisted the entry counts as delivered, and one that resolves without persisting fails as a retriable `write`. `resume` also takes the target lease inside the uninterruptible switch, so an interrupt cannot strand it. Left as is: a failed switch keeps the old lease and session (Pi decides whether the old one survives), and the `automation-result` ↔ `session` import cycle goes when delivery moves in step 7.

**`session/store.ts` is the one read side of transcripts.** `platform/lines.ts` (`scanLines`) is the bounded line reader: an `O_NOFOLLOW` handle, 64 KB chunks, an 8 MB cap per line, and a visitor that can stop or fail. `session/transcript.ts` decodes Pi's header and entries on top of it (content is parsed to text-or-parts at this boundary), walks `sessions/` without following symlinks, and finds the newest transcript for `continue`. `session/store.ts` is the `Sessions` service (`make` + `static layer`, one parse cache per service, LRU 512 keyed by file, size and mtime) with `list`, `summaries`, `show`, `locate`, `history` and `held`, plus plain functions for callers without the service. Deleted: `adapters/pi/{sessions,session-history,transcript-lines,session-discovery}.ts`, `application/sessions.ts` and `domain/session.ts` (its types live in `session/types.ts`). `AUTOMATION_RESULT_CUSTOM_TYPE` and its details schema moved to `domain/automation.ts`.

**Behaviour changes.** Listing is lenient: an unreadable, oversized, symlinked or duplicate-id transcript is logged and left out instead of failing the whole list; `show` of that file still fails typed, and doctor reports the skipped count as an error. On Squarey's 303 transcripts (1.1 GB) `sessions list` takes 2.1 s and skips three Slack threads with records over 8 MB (the largest is 21 MB); before, those three made the list fail. The history cursor is `{index, id}` of the page's first entry: appends no longer invalidate it, and a rewrite that moves that entry does. `history` and `resume` take a session id only (`locate` reads headers; `locateValidSession` also reads the whole file strictly before Pi's `SessionManager` may touch it), `Sessions.resolve` became `locate` returning the file, and `history` is required on `SessionsApi`. Still in `adapters/pi/`: `session-name.ts` and `session-lineage.ts`, which write through Pi; lineage moves with agents in step 7. Dropped tests: the scan-count cache spy.

**Verifier pass on step 5.** `locateSession` is now the only locate and always reads the matched transcript strictly, so `run --session` can no longer hand Pi's `SessionManager` an old-version file with a corrupt line to rewrite (the check had been skipped on that path; `locateValidSession` is gone). A same-id copy that does not parse is set aside instead of making the readable one ambiguous, matching `list`. The parse cache also keeps failures against the file's mtime and size, so the three oversized Slack threads are not re-read on every list. Left as is: `show <id>` of a skipped file says "not found", since an unreadable file's id is not known.

**`extensions/` is the third core folder.** `src/extensions/` owns what a Profile loads: `package.ts` (manifest and skill frontmatter), `selection.ts` (`extensions.json`, the shelf scan, the 2 s selection lock), `bundled.ts` (unpacking a bundled tree into a staging folder the process owns), `loader.ts` (`checkSelection`, preflight through Pi, and the `PiResources` a runtime gets), `resources.ts` (open-time resources and `<id>.old` recovery), `update.ts`, `tool.ts` (`profile_extensions`) and `service.ts` (`Extensions`: `list`, `show`, `listForProfile`, `add`, `remove`, `setSelected`, `validate`, `health`, `update`). Deleted: `adapters/fs/{profile-extensions,extension-installer,extension-update}.ts`, `adapters/pi/{resources,profile-resource-loader,profile-extension-diagnostics,profile-extension-preflight,profile-extension-tool}.ts`, `adapters/bun/profile-extension-lock.ts`, `application/{profile-extensions,extension-update}.ts` and `domain/{profile-extension,extension-catalog,extension-update}.ts`. `ZiggyUpdateUnavailable` moved to `domain/self-update.ts`; `hashTree` is `platform/tree.ts`.

**Decisions.** Required packages load from a fingerprinted cache under `ZIGGY_HOME`; Profiles hold no copies, so doctor's bundled-copy check and serve's `refreshRequiredExtensions` are gone. The runtime runs without inline extensions (`extensionFactoryCount` 0). A package that fails to load is skipped with a warning and no longer pauses its automations. Listing comes from package metadata. The wire codes `preflight_failed` and `lock_failed` stay. `add` of a bundled package writes an update receipt. Update refuses required ids, stages in a process-owned folder, checks the staged package through Pi, then swaps through `<id>.old` with no journal; an open that finds only `<id>.old` puts it back. Undo failures are warnings, so there is no `RollbackFailed`. `--restart` is orchestrated in `main.ts`. A mutation result carries its automations. Listing and health reads take no lock (writers rename atomically), so `doctor` stays read-only; before, the real service created `.runtime/profile-extensions.sqlite`, which a lock-free fake had hidden.

**Logs go to stderr.** Effect's default logger wrote to stdout, so a skipped-package warning landed in `ziggy run`'s answer and could corrupt ACP's stdout. `main.ts` provides `Logger.LogToStderr`.

**Proofs.** `test/e2e/extensions.test.ts` (EXT-1..9 in `verify-ziggy/features/extensions.md`): unknown and broken adds leave the selection and shelf unchanged; an added tool answers the model; `profile_extensions` adds with `PATH=""`; a broken selected package is skipped and doctor names it; a Profile package overrides bundled skill text; the model reads `ziggy-operations` from the cache; update reports `current`, `updated`, `adopted` and refuses `modified`, `unmanaged` and a live resident; `<id>.old` is restored on open. `test/harness/cli.ts` gains `ziggyWith(profile, env, ...args)`. Dropped tests: the deleted adapters' unit tests, the runtime activation rollback tests and the required-extension refresh tests (their code is gone). A refused mutation may still create the lock file under `.runtime/`; that is runtime state, not a Profile change.

**Step 6 verifier fixes.** The review of 8ef2d433 found three update-recovery defects, each now a red-then-green proof in `test/e2e/extensions.test.ts`:
- An update that published but failed to write its receipt was refused as `modified` forever. The `modified` check now runs after staging and refuses only when the installed bytes match neither the receipt nor this build, so the next `update` records the receipt. A receipt write that fails after publishing is a warning.
- `doctor`, `health`, `validate` and the tool's `list` moved `<id>.old` back, without the lock. `resolveResources` is read-only again and names an interrupted update in its error; only session open (under the selection lock, and only when `<id>.old` is alone), `add` and `update` restore it.
- `update` refused an `<id>.old`-only package as not installed, and `add` unpacked a fresh copy beside `.old`. Both now restore first.
Also: a Profile extension change and its undo run uninterruptibly, and the extension-updates docs describe the actual order (stop the resident, then update) and recovery. Not fixed, recorded: bridge logs ignore `LogToStderr` (fixed with the step 7 callback bridge); leftover `.extension-stage-*` after a crash; a refused bundled `add` leaves its shelf copy; `ExtensionMutation.automations` lists untouched automations; the tool's ignored `source` parameter; stale Profile copies of required packages still parsed by `scanShelf`; update checks the package alone, not with the rest of the selection.

## Step 7: memory/

**One folder.** `src/memory/` replaces `domain/memory.ts`, `adapters/fs/memory-files.ts`, `application/memory.ts` and `adapters/pi/memory-write-tool.ts` (about 1,200 lines) with `types.ts` (the scope table, operations, errors), `memory.ts` (read, list, locked update, backups, the read-only `Memory` service) and `tool.ts` ([Pi]: `memory_write`, `memoryTools`, `memoryPrompt`). Reads go through `platform/tree`'s `readPhysicalFile`; writes through `platform/atomic-write` (now taking bytes) and `platform/file-lock`. `codePointLength` moved to `platform/text`, so gateways no longer import memory for it. `ChatContext` lives in `session/types.ts`.

**The session knows nothing about memory.** Memory reaches the session through the tool seam and a new prompt seam: `SessionPrompt` contributions run before every turn and are appended by the one hidden `ziggy-contributed-prompt` extension. `session/runtime.ts` no longer calls `memoryFilePaths`. `platform/callback.ts` is the single Pi-callback bridge (`runCallback`); it provides `Logger.LogToStderr`, closing the step 6 nit that bridge logs reached stdout.

**Behavior changes.** Backups keep 5 plain copies (was 10 hardlinked ones), named `<ISO time>-<random>.md`, so a same-millisecond collision cannot happen and the hardlink collision test is gone. A chat id memory cannot store no longer fails session open with `MemoryIdInvalid`; the turn runs and the prompt says memory is unavailable (`MemoryIdInvalid` left `ZiggyAgentError`; the persisted automation failure-category literal stays so old runs still decode). `memory_write` failures are logged as warnings before the model sees `ERROR: memory … failed`.

**Proofs.** `test/memory/` holds the ported domain, inventory and tool tests (retention now `MEMORY_BACKUPS_KEPT`) plus three prompt tests: reread per turn, a symlink refused, an invalid id reported to the model. `test/e2e/memory.test.ts` (MEM-1..3) passes unchanged. `bun run check`, 765 unit and 41 e2e pass.

**Step 7 memory verifier fixes.** The review of d663eec9 confirmed one defect: `memory list` on a mistyped Profile path reported no documents. It now fails with `MemoryFileError` (red-then-green test in `test/memory/memory.test.ts`). The `memory_write` failure warning is a single line, since stderr is the user's screen in the TUI. Accepted as spec-consistent: a symlinked `memory/` makes the whole memory prompt unavailable. Not fixed, recorded: `list` ignores symlinks whose ids memory would not admit; an interrupted backup's temp file is not pruned; retention orders by wall-clock names. `bun run check`, 766 unit and 41 e2e pass.

## Step 7: agents/

**Structure.** `src/agents/` holds the agent slice: `files.ts` (read, create, save `agents/<id>.md`), `service.ts` (`ProfileAgents`: create, list, show, validate, run), `policy.ts` (`agentPersona`, `agentModel`: one policy for tools and model), `run.ts` (one child/root/rail run through `openSession`), `tools.ts` (`agent_run`, `agent_discuss`, the agent prompt and the `@agent` mention), and `index.ts` (`makeZiggyAgent`, which adds those to the session seams: tools, prompts, prepare). Agent sessions are ordinary sessions opened with a `persona` (the agent body replaces SOUL.md, only declared tools are active) and a `model` override. Deleted: `adapters/pi/specialist.ts`, `adapters/pi/profile-agent-guidance.ts`, `adapters/pi/session-lineage.ts` and the specialist runner tests; `adapters/fs/profile-agents.ts` and `application/profile-agents.ts` moved into `src/agents/`.

**Behavior changes.** An agent with no `thinking` (or no model) uses the Profile default (D1). `agents validate` now makes the same checks a run makes, including the model and provider auth. An invalid agent file still refuses sessions (the agent tools discover agents at open). Saving an agent file goes through `writeFileAtomic` and keeps the old mode. Child transcripts are created by Pi's `parentSession` through `openSession`, not a separate lineage helper.

**Proofs.** `test/agents/` holds the ported file and service tests plus policy, direct run, rail and invalid-file tests on the harness model server. `test/e2e/agents.test.ts` adds `agent_discuss` (2 agents × 2 rounds, sorted, no child tools, 4 child files; duplicates refused); verify-ziggy AG-4 and AG-5 document it. `bun run check`, 746 unit and 43 e2e pass; knip clean.
