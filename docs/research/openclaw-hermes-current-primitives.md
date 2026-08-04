# Current OpenClaw and Hermes-Agent primitives Ziggy can borrow

**Inspected:** 2026-08-04
**Question:** Which current, proven primitives can Ziggy borrow without substantial code or a second architectural authority?

**Implementation packet:** [`openclaw-hermes-primitives.md`](../plans/openclaw-hermes-primitives.md)

## Source snapshots and method

Only current first-party source was used. The official repositories were freshly cloned into disposable `/tmp` directories and inspected at these exact revisions:

| Repository | Branch | Exact commit | Commit date | Subject |
|---|---|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | `main` | [`50a30b7373d78fe8a63e597bd28138b6aa805765`](https://github.com/openclaw/openclaw/commit/50a30b7373d78fe8a63e597bd28138b6aa805765) | 2026-08-04 11:36:03 -04:00 (authored and committed) | `fix(codex): migrate redundant native service tiers (#118738)` |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | `main` | [`42708f8bb39c9c2fc19146956699699bc3ea2da5`](https://github.com/NousResearch/hermes-agent/commit/42708f8bb39c9c2fc19146956699699bc3ea2da5) | 2026-08-04 12:04:42 -04:00 (authored and committed) | `Merge pull request #74864 from bbednarski9/fix/relay-concurrent-turn-scopes` |
| Ziggy baseline | `scotty/ec7028bfd5f4` | [`98988c29b7676b9fd0de1cc6c452598134b13fd0`](https://github.com/Yeshwanthyk/ziggy/commit/98988c29b7676b9fd0de1cc6c452598134b13fd0) | 2026-07-29 18:48:48 -04:00 (authored and committed) | `Merge pull request #2 from scotty/0724a83ee3fb` |

The comparison follows Ziggy's settled boundary: Pi owns sessions, skill parsing, providers, and the agent loop; Ziggy owns Profile policy and resident-process ownership ([spec](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/docs/research/minimal-ziggy-scout.md#L7-L25)). “Tiny” below means a local invariant that fits an existing Ziggy owner. It does **not** mean copying the source subsystem that demonstrated it.

### Complexity scale

- **XS:** under roughly 50 logical lines plus focused tests.
- **S:** roughly 50–150 logical lines plus focused tests.
- **M:** roughly 150–300 logical lines or a persistent-state change.
- Architecture cost overrides line count: a second parser, session index, scheduler, or control plane is “too large” even when its first patch looks short.

## Decision summary

| Area | Current Ziggy | Recommendation | Rough complexity | Small invariant worth retaining |
|---|---|---:|---:|---|
| Resident ownership | Separate Telegram, Discord, and Slack residents are shipped; duplicate same-face residents are not fenced | **Explore next, face-scoped** | S | Fence only `(Profile, face)` so duplicate consumers fail before network/Pi work without preventing multiple channels |
| Startup checks / doctor | Per-face config decoders exist; no unified strictly read-only check surface | **Act now, narrowly** | S | Reuse local file/config decoders, report `ok/warn/error` plus a remedy, and exclude auth/runtime checks that may refresh credentials |
| Session visibility | Pi persistence/routing exists; pinned Pi `0.82.0` publicly exposes `SessionManager.listAll(customDir)` | **Act now** | S | Recursively discover leaf directories, project only Pi metadata, and never expose transcript preview fields |
| Graceful shutdown / admission | Scoped cleanup exists; no explicit stop-admission/bounded-drain phase | **Defer** | M across three faces | Preserve the invariant, but add lifecycle state only when interrupted in-flight work has a promised recovery or delivery behavior |
| Automation claims / idempotency | Manual `wake`, gate, and fresh session exist; no scheduler or durable claim | **Defer** | S/M when scheduling lands | Persist a trigger-occurrence claim before effects and consume it without replay; add immutable terminal/`unknown` outcomes only with a later run-history contract |
| Skill requirements / discovery | Profile-first explicit roots and Pi-owned parsing already exist | **Keep** | 0 | Preserve current discovery; if requirements are needed, put namespaced metadata and eligibility diagnostics in Pi, not Ziggy |
| Bounded inbound dedupe | Slack/Discord already have 1,000-entry process-local FIFO caches; Telegram advances an update offset | **Keep** | 0 | Keep bounded process-local suppression; consider two-phase claim/commit only with a demonstrated redelivery bug |

## 1. Resident ownership — explore a face-scoped lease, not a Profile-wide lease

### Primary-source evidence

OpenClaw's gateway lock records a process identity with `pid`, random `ownerId`, creation time, and optional process start time ([payload and identity](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/infra/gateway-lock.ts#L25-L80)). Its stale policy is the important part: when a PID is known, reclaim only if the owner is proved dead; if a lock cannot be inspected, fail closed ([reclaim policy](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/infra/gateway-lock.ts#L236-L270)). Acquisition generates a unique owner token and ultimately fails with an operator-visible “gateway already running” error ([acquisition](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/infra/gateway-lock.ts#L359-L425), [failure](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/infra/gateway-lock.ts#L488-L549)).

Hermes independently uses the same lease shape for active-session capacity: a UUID lease ID plus PID and process start time prevents PID-reuse errors ([identity and liveness](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/hermes_cli/active_sessions.py#L205-L268)); acquire/prune/write occurs under one file lock ([acquire](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/hermes_cli/active_sessions.py#L271-L334)); release removes only the matching lease ID and is idempotent ([release](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/hermes_cli/active_sessions.py#L337-L350)).

### Ziggy consequence

The upstream invariant is useful, but its scope must match Ziggy's shipped product. Telegram, Discord, and Slack are separate commands with separate Pi session roots ([CLI dispatch](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/main.ts#L222-L250), [chat session creation](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/adapters/pi/pi-agent.ts#L640-L656)). A Profile-wide lease would make those three channels mutually exclusive before Ziggy has a unified resident or attach protocol. That is a product change, not a small correctness patch.

The concrete collision today is narrower: two copies of the **same** channel command can consume the same provider stream and target the same session directory. If that failure matters in practice, borrow only this adapted invariant:

1. Key the lease by `(Profile path, face)` where face is Telegram, Discord, or Slack.
2. Acquire after local config decoding but before opening a channel/socket or Pi session.
3. Use an OS-released lock such as a held SQLite write transaction; process death releases it without PID files or stale takeover logic.
4. Fail a duplicate face clearly and perform zero network or Pi work.
5. Release through the existing Effect scope; local TUI, `run`, `wake`, and other channel faces remain unaffected.

This is runtime coordination, not durable Profile truth. Do not canonicalize Profile identity, write owner registries, or turn the lease into a daemon protocol.

### Do not copy

OpenClaw's dual state/config locks, roles, ports, Windows command-line inspection, polling, and multi-gateway override span hundreds of lines ([full acquisition machinery](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/infra/gateway-lock.ts#L296-L549)). Hermes' cross-process active-session registry and configurable concurrency cap are also not needed. If Ziggy adds a guard, it needs one OS-released lock per resident face—not a process registry.

## 2. Startup checks, status, and doctor — act now, read-only

### Primary-source evidence

Hermes' useful primitive is not its 2,775-line doctor; it is the result grammar. Checks are consistently emitted as `ok`, `warn`, `fail`, or informational detail, and a failure appends a concrete repair instruction ([check/result helpers](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/hermes_cli/doctor.py#L204-L226)). The final summary makes remaining actions explicit and numbered ([summary](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/hermes_cli/doctor.py#L2748-L2774)). Its deprecated-config policy also deliberately warns without silently migrating; migrations remain with the config owner ([policy](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/hermes_cli/doctor.py#L229-L235)).

OpenClaw contributes a startup invariant: a blocking preflight failure must prevent the process from reporting ready, with the owned reason and remedy shown to the operator ([startup refusal](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/commands/doctor-config-preflight.ts#L164-L185)).

### Ziggy consequence

Ziggy already owns useful local checks:

- gateway config loaders verify `SOUL.md` shape and Schema-decode channel JSON—for example Telegram ([loader](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/application/gateway.ts#L63-L106));
- Slack validates credentials with `authTest` at live startup ([startup](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/application/slack-gateway.ts#L209-L221));
- Telegram makes an initial API call and establishes its offset at live startup ([startup](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/application/gateway.ts#L250-L264));
- `ziggy auth <profile>` already has a separate provider-status command ([auth status](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/main.ts#L150-L173)).

What is absent is one strictly read-only Profile check surface in the command switch ([current command surface](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/main.ts#L54-L139)). Add a small `doctor` collector that reads `SOUL.md`, reuses **local** config/automation decoders, consumes the safe session projection, and renders severity, evidence, and remedy. Do not call `Auth.status`: Pi auth checks may refresh/persist credentials and malformed auth is not exposed as a hard decoder failure. Existing gateway startup retains live credential/network ownership. Doctor must not poll Telegram, connect sockets, call providers, rewrite files, migrate configs, install tools, repair sessions, or probe every optional integration.

### Do not copy

Do not copy OpenClaw's migration preflight or Hermes' broad auto-fixer. They combine config migration, security advisories, service management, profiles, plugins, providers, and repair actions. A Ziggy doctor that mutates Profile files would become a new policy authority and violate the plain-file/human-ownership model.

## 3. Session visibility — act now through pinned Pi metadata

### Primary-source evidence

Both projects keep the user-facing invariant small:

- OpenClaw caps recent sessions at 10 ([limit](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/status/summary.ts#L35-L38)), selects newest-first without retaining an unbounded sorted result ([selection](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/status/summary.ts#L183-L212)), and reads entries through a read-only listing boundary ([listing](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/status/summary.ts#L214-L227)). Its status model exposes a count and bounded recent list ([shape](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/status/types.ts#L86-L100)).
- Hermes defaults to source-scoped results, excludes the current session, hides unnamed rows unless requested, and enforces a final limit of 10 ([query policy](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/hermes_cli/session_listing.py#L45-L88)). Its compact rendering includes a title, stable ID, short preview, and optional source ([rendering](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/hermes_cli/session_listing.py#L91-L117)).

### Ziggy consequence

Ziggy already routes local, channel, and automation sessions into explicit Pi-owned directories ([local manager](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/adapters/pi/pi-agent.ts#L423-L446), [automation session](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/application/automations.ts#L191-L209)). The pinned `@earendil-works/pi-coding-agent@0.82.0` exposes `SessionManager.listAll(customDirectory)`, returning stable ID, timestamps, message count, and path without `list(cwd, customDirectory)`'s exact-header-cwd filter ([pinned implementation](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L1631-L1670)). It lists one directory at a time and also returns transcript-derived preview fields; Ziggy must not project those fields.

The small implementation is therefore available now: recursively discover directories under `<profile>/sessions`, reject symlinked `.jsonl` entries before invoking Pi, call `listAll` once per remaining leaf directory, map only path/ID/created/modified/message count, and sort the combined rows. Comparing regular discovered `.jsonl` paths with Pi's returned paths can surface files for which Pi cannot build metadata, but it cannot and should not impose stricter line-validity rules than Pi itself. No Ziggy session index or session-format parser is needed.

### Do not copy

Do not copy Hermes' session database/search/resume machinery or OpenClaw's aggregate model/token/task status. Ziggy needs visibility into Pi-owned sessions, not another session store.

## 4. Graceful shutdown and admission — keep the invariant, defer the machinery

### Primary-source evidence

OpenClaw's large admission coordinator demonstrates four compact invariants:

1. a distinct draining error rejects new work ([error](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/process/gateway-work-admission.ts#L11-L16));
2. admitted roots are counted and their release is idempotent ([lease/release](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/process/gateway-work-admission.ts#L61-L105));
3. restart drain is a one-way state transition and new root admission returns no lease once closed ([close and admission](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/process/gateway-work-admission.ts#L194-L211), [admit](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/process/gateway-work-admission.ts#L250-L270));
4. shutdown waits for active roots with a bound and reports whether work drained ([bounded wait](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/process/gateway-work-admission.ts#L353-L400)).

Hermes' durable drain marker illustrates machinery Ziggy does **not** need: it exists specifically because a separate dashboard cannot call the gateway and because state survives VM/container restarts ([contract and rationale](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/gateway/drain_control.py#L1-L48)).

### Ziggy consequence

Ziggy already has the cleanup half:

- all gateways are `Effect.scoped` and register finalizers for sockets/chat handles ([Telegram](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/application/gateway.ts#L203-L212), [Slack](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/application/slack-gateway.ts#L209-L221), [Discord](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/application/discord-gateway.ts#L205-L218));
- Slack and Discord message work is forked inside the gateway scope ([Slack](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/application/slack-gateway.ts#L260-L268), [Discord](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/application/discord-gateway.ts#L257-L265));
- gateway-only teardown maps interrupt-only termination to exit 0 ([entrypoint teardown](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/main.ts#L317-L330)).

What is missing is the ordering guarantee. Adding it is not yet a tiny shared utility: Telegram is sequential while Slack and Discord fork scoped turn fibers, and the current runtime interruption reaches those scopes before a new drain phase could complete. A correct change would alter signal admission, all three receive loops, in-flight accounting, timeout behavior, and the meaning of an interrupted turn.

Keep the upstream invariant as a gate for future load-bearing gateways, but defer implementation until Ziggy promises either graceful completion or an explicit interrupted outcome. Scoped finalization already provides honest cancellation and resource cleanup; a partial drain wrapper without recovery semantics would add lifecycle state without making delivery durable.

### Do not copy

Do not copy OpenClaw's `AsyncLocalStorage`, nested/subordinate-root semantics, reversible host suspension, restart generations, or global singleton. Do not copy Hermes' dashboard endpoint, watcher, durable marker, VM epoch, or notification policy. Ziggy currently needs one one-way shutdown phase in each resident process.

## 5. Automation claims and idempotency — defer, but make this a gate for scheduling

### Primary-source evidence

Hermes has the clearest failure semantics:

- finite dispatch is claimed and persisted **before** execution, converting duplicate-prone one-shots to at-most-once dispatch; a crash after claim is made operator-visible rather than silently refired ([finite claim](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/cron/jobs.py#L1839-L1911));
- claim heartbeats compare the expected owner before refresh, so a stale runner cannot extend somebody else's claim ([heartbeat](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/cron/jobs.py#L1921-L1950));
- external fire claims happen under the store lock; a recurring job advances its next occurrence in the same critical section; malformed or future-dated timestamps cannot wedge the claim forever ([external fire](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/cron/jobs.py#L2024-L2076));
- its execution ledger explicitly is not a retry queue, bounds terminal history at 1,000, and makes terminal states immutable ([ledger contract/schema](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/cron/executions.py#L1-L53), [terminal transition](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/cron/executions.py#L175-L196));
- after restart, only attempts whose exact owner is proved gone become `unknown`, and recovery does not schedule a retry ([recovery](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/cron/executions.py#L199-L233)).

OpenClaw independently persists `runningAtMs` before execution ([activation](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/cron/service/run-admission.ts#L146-L189)) and converts a surviving running marker into an explicit interrupted failure on startup rather than pretending success or blindly replaying it ([startup repair](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/cron/service/startup-run-repair.ts#L52-L119)).

### Ziggy consequence

Current Ziggy has only explicit manual `wake`: it reads one automation, runs a cheap gate, opens a fresh Pi session, prompts, and delivers ([wake path](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/application/automations.ts#L170-L215)). There is no scheduler, webhook ingress, or competing automation dispatcher to claim. Adding a durable execution database now would be premature machinery and a new state surface.

Before the first automatic trigger ships, require this minimal contract:

1. Claim key is the automation ID plus the **trigger occurrence** (scheduled instant or external event ID), not merely the automation ID.
2. Persist the claim atomically before the model call or delivery.
3. A claimed occurrence is consumed and is not automatically replayed after a crash.
4. Bound state by retaining only the latest claimed recurring occurrence per automation when no run history is promised.

That future work remains a focused claim-before-wake slice. Add `running`/terminal/`unknown` transitions only if Ziggy later promises run history, recovery diagnosis, or retries; those promises would make a ledger and its crash semantics part of the feature.

### Do not copy

Do not copy either project's scheduler, recurring-calendar engine, heartbeat service, multi-machine election, task ledger, retry policy, monitoring projection, or auto-disable machinery. Ziggy should add a claim only when an actual trigger source creates concurrency/replay risk.

## 6. Skill requirement metadata and discovery — keep Ziggy's current boundary

### Primary-source evidence

OpenClaw's reusable metadata vocabulary is compact: namespaced skill metadata can declare all-required binaries, any-of binaries, environment variables, config paths, and OS constraints ([metadata shape](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/skills/types.ts#L20-L34)). It normalizes that manifest block at the frontmatter boundary ([metadata decoding](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/skills/loading/frontmatter.ts#L193-L213)), evaluates requirements into both `eligible` and structured `missing` reasons ([evaluation](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/shared/requirements.ts#L133-L218)), and preserves missing requirements in status instead of simply hiding the skill ([status](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/skills/discovery/status.ts#L260-L342)). Its discovery is explicitly bounded by candidate, loaded-skill, prompt, character, and file-size limits ([bounds](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/skills/loading/workspace.ts#L232-L249)).

Hermes also namespaces conditional metadata under `metadata.hermes` ([conditions](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/agent/skill_utils.py#L665-L679)) and distinguishes `available`, `setup_needed`, and `unsupported` ([readiness states](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/tools/skills_tool.py#L225-L229)). Its discovery scans local before external roots so local names win ([precedence](https://github.com/NousResearch/hermes-agent/blob/42708f8bb39c9c2fc19146956699699bc3ea2da5/tools/skills_tool.py#L670-L723)).

### Ziggy consequence

Ziggy already implements the relevant discovery invariant: Profile skills first, sorted package skill roots next, and repository top-level skills last ([resource discovery](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/adapters/pi/resources.ts#L39-L78)). It then passes those explicit roots to Pi's resource loader with ambient skill discovery disabled and returns Pi diagnostics ([runtime composition](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/adapters/pi/pi-agent.ts#L502-L538)). This exactly matches the ownership rule that Pi parses skills.

Therefore **keep the current implementation**. If users later need requirement readiness, the worthwhile invariant is namespaced optional metadata plus separate “discovered” and “eligible” states with structured missing reasons. That parsing/evaluation should be added to or exposed by Pi; Ziggy may render Pi's result. Until then, a Ziggy frontmatter parser would be a duplicate authority.

### Do not copy

Do not copy OpenClaw install recipes, remote-node capability evaluation, config-path probing, or large recursive scanner. Do not copy Hermes secret capture, setup prompting, skill database/cache, external-root lifecycle, or platform/environment policy. They are reference-scale product machinery, not Profile composition.

## 7. Bounded inbound dedupe — keep what Ziggy has; defer two-phase semantics

### Primary-source evidence

OpenClaw's process-local implementation separates an in-flight claim from recently completed work. Its composite key includes agent/session scope, provider, account, peer/conversation, thread, and provider message ID ([key](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/auto-reply/reply/inbound-dedupe.ts#L38-L76)). Claims distinguish `duplicate`, `inflight`, and `claimed`; commit moves a successful claim into the recent cache, while release permits a safe retry ([claim/commit/release](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/auto-reply/reply/inbound-dedupe.ts#L78-L110)). The recent cache is bounded by both 20-minute TTL and 5,000 entries ([bounds](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/auto-reply/reply/inbound-dedupe.ts#L13-L30)); the underlying cache prunes expired and over-limit entries ([cache](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/infra/dedupe.ts#L26-L55)). Crucially, its dispatch error path releases only when replay is known safe; if a side effect may already have happened, it commits suppression ([error disposition](https://github.com/openclaw/openclaw/blob/50a30b7373d78fe8a63e597bd28138b6aa805765/src/auto-reply/reply/dispatch-from-config.ts#L75-L99)).

### Ziggy consequence

Ziggy already has a bounded, process-local FIFO `RecentIds` set ([implementation](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/adapters/bun/recent-ids.ts#L1-L24)). Slack records provider event IDs in a 1,000-entry cache before enqueue ([Slack](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/adapters/slack/socket.ts#L41-L44), [use](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/adapters/slack/socket.ts#L240-L265)); Discord does the same for message IDs ([Discord](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/adapters/discord/socket.ts#L47-L52), [use](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/adapters/discord/socket.ts#L282-L311)). Telegram discards startup backlog and then advances a monotonic provider offset ([offset handling](https://github.com/Yeshwanthyk/ziggy/blob/98988c29b7676b9fd0de1cc6c452598134b13fd0/src/application/gateway.ts#L250-L272)).

That is adequate for current single-owner gateways. Keep it process-local and bounded; do not add a database. Ziggy's cache does mark an ID before the model/delivery result is known, so a failed turn suppresses redelivery. OpenClaw's two-phase design is the right refinement **only after** a concrete provider-redelivery test demonstrates the need, because deciding whether a failed model/delivery path is replay-safe is the real policy. Merely adding TTL is optional; count-bounding already prevents unbounded memory.

### Do not copy

Do not add distributed dedupe, durable replay logs, cross-restart suppression, or a generic event bus. A single Profile owner plus provider-native IDs/offsets keeps this a tiny adapter concern.

## Recommended order

1. **Session inventory first.** Use Pi's pinned public metadata API and add no writes, process, parser, or index.
2. **Narrow read-only doctor second.** Reuse local decoders; do not fix files or turn readiness into network health.
3. **Face-scoped duplicate-resident lease third, if duplicate consumers are a demonstrated operator risk.** Do not block different channels or local faces.
4. **No work now** on Profile-wide ownership, admission/drain state, automation ledgers, skill parsing, or durable dedupe. Revisit claims with the first scheduler/webhook, drain with a promised interrupted-work outcome, requirements in Pi, and two-phase inbound dedupe with a reproduced retry failure.

## Bottom line

The immediate low-complexity borrowing is **read-only visibility**: Pi-backed session inventory and a narrow decoder-backed doctor. A **face-scoped duplicate-resident lease** is the smallest ownership guard worth exploring; a Profile-wide lease would change current multi-channel behavior. Skill-root precedence, scoped cleanup, and bounded inbound suppression are already present. Drain state, session indexes/parsers, skill parsers, scheduler ledgers, and external control planes remain intentionally out.
