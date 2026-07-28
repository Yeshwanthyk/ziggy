# Starman coverage audit — domain/feature list

Comparison of shipped Ziggy (`main` @ 2255e48, all seven primitives) against Starman
(`/Users/yesh/code/personal/starman`), assimilated from six codex sweeps over every Starman
package plus Ziggy's full source. Reference columns for OpenClaw and Hermes-Agent
(`/tmp/ziggy-refs/{openclaw,hermes-agent}`) from four further sweeps plus
`starman/docs/research/openclaw-hermes.md`.

Legend per feature: **built** (Ziggy has it), **dropped** (spec `minimal-ziggy-scout.md`
deliberately excludes it — usually because Pi owns it), **gap** (Starman has it, the spec's
surface implies Ziggy wants it, and it is missing), **later** (consistent with spec sequencing,
not yet due).

## 1. Profile / init / config

| Feature (Starman) | Where | Ziggy status |
|---|---|---|
| `init [path] [--voice clear\|warm\|operator]`, three SOUL voices | `profile-initialization.ts` | **gap (small)** — one generic SOUL template; the three adapted starter voices were flagged "copy" in `starman-reuse.md` but never landed |
| Scaffold `automations/ credentials/ extensions/ memory/ sessions/` 0700, files 0600 | same | **dropped** — Ziggy creates SOUL.md only; dirs appear on first use; no modes set |
| Path safety: parent-must-exist, symlink-refusal, canonicalization, race-converging exclusive create | same | **partial** — exclusive `wx` create is there; no symlink rejection, no canonicalization, registry append can race (stateful-audit f) |
| `ziggy.jsonc` (schemaVersion 2, defaultProvider/defaultModel, thinkingLevel, cacheRetention, gateways[]) strict JSONC | `profile-config.ts` | **dropped** — Pi's `settings.json`/`models.json` own this; but Ziggy has *no* validation-at-write for any operator file |
| Profile registry | none in Starman (cwd-is-profile) | **built (Ziggy-only)** — `~/.ziggy/profiles.list` + names under `~/.ziggy/profiles` |
| `--profile PATH` on every command, cwd default | `cli.ts` | **built** (equivalent: name-or-path argument) |

## 2. Provider / auth / credentials

| Feature (Starman) | Where | Ziggy status |
|---|---|---|
| `ziggy auth login PROVIDER [--type api_key\|oauth]` interactive; OAuth browser flow; secret prompts raw-mode TTY | `auth-client.ts`, `terminal-auth.ts` | **dropped→gap (UX)** — Pi owns auth mechanics, but Ziggy exposes **no auth command at all**; hsey hand-copied `auth.json` into the profile for the live proof. A `ziggy auth <profile>` that drives Pi's login/`/login` flow (or documented bootstrap) is the biggest CLI hole for setup |
| `ziggy doctor` — daemon/socket/lock/auth checks, env-var fallback probe | `daemon.ts` | **gap (small)** — no health command; provider misconfig only surfaces at first call (typed errors are good, but nothing proactive) |
| Daemon-owned `credentials/auth.json` 0600/0700, identity-checked reads, bounded JSON | `credentials/filesystem-store*` | **dropped** — Pi's auth-storage owns it (proper-lockfile, in-place writes; weaker but Pi's problem) |
| Gateway credential store (`credentials/gateways.json`, token never listed) | `credentials/gateway-store*` | **partial** — `telegram.json` plain file; token redaction in errors is built; no store abstraction, fine at one channel |
| Model catalog + thinking clamp + cache retention config | `provider-runtime.ts` | **dropped** — Pi ModelRuntime owns models; no Ziggy-level default-model/thinking/cache knobs |

## 3. Session / agent loop / faces

| Feature (Starman) | Where | Ziggy status |
|---|---|---|
| Custom Effect agent loop, NDJSON events, steer/follow-up/interrupt, approvals, mailboxes | `agent/runtime.ts` | **dropped** — Pi owns the loop; steer/abort available in TUI via Pi |
| Daemon + attach protocol + socket + replay/reconnect + TUI face | `daemon/`, `protocol/`, `tui/` | **dropped** by spec ("no daemon before a channel needs residency") — gateway is the resident process |
| Stable `main` session, `session/ensure` | `kernel.ts` | **dropped** — `run -c` = Pi `continueRecent` (mtime-based; audit d shows "recent" means most-recent root session only) |
| `ziggy sessions list` | `cli-client.ts` | **gap (small)** — no way to enumerate sessions/JSONL from the CLI; users must ls the profile |
| `ziggy ask` exit codes 0/1/2/3/130, outcome-unknown discipline, never resend after uncertain write | `cli.ts`, `cli-client.ts` | **partial** — `run` exits 0/1 only; no usage=2/interrupt=130 discipline; no outcome-unknown concept |
| Session invariants: contiguous seq, torn-tail fails loud, one open turn, crash reconciliation | `world/session-invariants.ts`, `daemon/reconciliation.ts` | **dropped** — Pi JSONL appends silently skip malformed tails (audit g); no reconciliation. Accepted risk |
| Profile lock (PID+token, stale takeover) — one daemon per profile | `daemon/profile-lock*` | **gap (real)** — nothing stops gateway + TUI + wake on one profile concurrently; spec invariant "gateway exclusively owns live sessions" is unenforced (audit a) |

## 4. Memory

| Feature (Starman) | Where | Ziggy status |
|---|---|---|
| `memory` tool add/replace/remove over `§`-delimited entries, single-match rules, idempotent adds | `memory/tool.ts` | **variant** — Ziggy chose whole-doc `memory_write` replace (simpler; model curates whole doc) |
| Caps 2200/1375 code points, reject-on-overflow | same | **built** — same numbers, same rejection |
| Optimistic concurrency: expected-old-content CAS + 8 retries | same | **gap (the critical one)** — Ziggy write is atomic-rename but LWW, no version/CAS; stateful-audit #1/#2 scenarios lose facts |
| Prepared/committed write-ahead journal + crash recovery | `world/memory-journal.ts` | **dropped** — single-doc rename doesn't need a 2-doc transaction; but no fsync either (power-loss window) |
| Frozen-per-session memory snapshot (explicit design: mid-session writes visible only to new sessions) | `memory/session.ts` | **same behavior, unowned** — Ziggy freezes at runtime build too, but as a side-effect of `appendSystemPrompt`, and resident gateway handles live for days → staleness unbounded (audit #3). Starman's daemon rebuilt prompt per session under one writer |
| Per-person `memory/users/<id>`, per-group | Starman deferred people-memory post-v1 | **built (Ziggy ahead)** — user/group scoping with admission fences shipped |
| primary vs conversation memory access per route | `owner-link.ts` | **built** (equivalent: ChatContext user/group) |

## 5. Extension

| Feature (Starman) | Where | Ziggy status |
|---|---|---|
| Manifest `extension.json` (schema 1/3), sealed tree digests, SHA-256 approval fingerprints, epochs | `extensions/manifest.ts`, `approvals.ts` | **dropped** — Pi-native `skills/` + `extensions/` dirs, no manifest/registry/installer, per spec |
| Supervised commands (private snapshot, `--no-env-file` bun, env allowlists, timeouts) | `command-loader.ts` | **dropped** — Pi tools/skills only |
| install/enable/disable/list/doctor CLI + journaled transactions + mutation detection | `lifecycle*` | **dropped** |
| `extensions` authoring tool (agent-driven CRUD, no self-approval) | `authoring-tool.ts` | **later** — nothing equivalent; skills are hand-dropped files |
| 40-extension bundled catalog, exactly 2 default-enabled, generated TS catalog | `tooling/generate-bundled-*` | **gap (product)** — none of the 40 are usable by Ziggy as-is (manifest+commands are Starman-shaped); see §8 for the maintenance answer |
| Profile-scoped skill admission, nothing global leaks | resource-loader flags | **built + proven** (`/skill` showed only the planted profile skill) |
| Headless faces tool policy | n/a | **known issue** — `tools: ["memory_write"]` in run/gateway/wake deadens extension tools in headless faces; TUI-only extensions today |

## 6. Gateway / Telegram

| Feature (Starman) | Where | Ziggy status |
|---|---|---|
| Raw Bot API client, strict schemas, no SDK | `telegram-api.ts` | **built** (adapted; getUpdates+sendMessage only vs Starman's +edit/+callback) |
| Error taxonomy retriable/terminal, retry_after honor, capped backoff | same + host | **built** |
| Owner-link `/link <6-digit>` one-use 10-min code, first-writer-wins bind | `owner-link.ts`, `owner-store*` | **variant** — static `ownerUserId` in telegram.json; simpler, but identity never unified with local owner (audit: owner is two people) |
| Persisted poll offset + claimed inbound keys (restart-safe, idempotent inbound) | `telegram-host-state.ts` | **gap (real)** — offset starts at 0 in RAM; crash-after-reply double-replies (audit #2/c) |
| Persisted delivered-seq per route (duplicate output suppression) | same | **gap** — same family |
| Route store (chat/thread→session, 4096 cap, atomic) | `gateway/route-store*` | **variant** — deterministic `sessions/telegram/<chat-key>` dirs + `continueRecent`; no store needed |
| Streaming chunk-per-delta output; approval inline buttons; steer active turn; `/link` only command | `telegram-host.ts` | **variant/later** — Ziggy sends one final reply (message_end), 4096-chunked; no approvals/steer/commands over Telegram |
| Group policy: conversation-only memory in groups | `owner-link.ts` | **built** (group memory only in groups; person memory fenced) |
| Broadcast adapter with typed delivery outcomes, receipts as replay authority | `telegram-broadcast.ts`, `broadcast.ts` | **partial** — wake sends chunks, logs-and-continues on config absence; no receipts/idempotency |
| Multi-gateway config (≤64 per profile, enable flags) | `profile-config.ts` | **later** — one Telegram gateway per profile |

## 7. Automation

| Feature (Starman) | Where | Ziggy status |
|---|---|---|
| Strict frontmatter (version/type/trigger.schedule cron/broadcast), custom YAML-subset parser | `automations/definition.ts` | **built (variant)** — flat `key: value` parser, `version/gate/telegram-chat`; unknown keys fail closed |
| Cron scheduler with revision recheck before firing | `scheduler.ts` | **later** — spec has wake-gate + manual `wake`; no scheduler yet |
| Run dedupe `[id, revision, trigger, triggerId]`, shared deferred, session-scan recovery | `run.ts`, `run-sessions.ts` | **later/gap-when-scheduled** — concurrent wakes duplicate (audit e); fine while human-triggered |
| Wake-gate `{wakeAgent:false}` skip, fail-open with recorded evidence | `run.ts` | **built (variant)** — gate = shell exit code; nonzero=decline before Pi construction; spawn-fail/timeout fail-open with warning. **Note inversion**: spec text says "gate can stop it", Starman treats *only explicit false* as stop; Ziggy matches Starman. But no persisted gate evidence, and service carries no trigger provenance (audit #4) |
| `no_agent` runs (script only, zero model) | `run-sessions.ts` | **later** — every wake is a prompt run |
| Fresh session per run, memory-only tools | both | **built** |
| `automation list/inspect/runs/run --now` CLI | `cli.ts` | **gap (small)** — only `wake`; no list/inspect/history (history would need run records; list/inspect are cheap) |
| Authoring service + `automations` agent tool (revision CAS, atomic publish) | `authoring*`, `tool.ts` | **later** |
| Hot-reload watcher with inactive-diagnostics projection | `reload*` | **dropped** — files are read per wake; no resident scheduler to stale |

## 8. Extension maintenance — the answer

Constraint set: Pi loads **skills** (SKILL.md dirs) and **TS extensions** (loop-hook modules)
from admitted paths; Ziggy will not add a manifest/lifecycle layer (spec: "no new manifest,
registry, or installer"). Starman's 40 bundles are `extension.json` + supervised-command `.mjs`
+ skills — the manifest and commands mean nothing to Pi; only nested SKILL.md text loads, and
those reference Starman command tools that don't exist.

What the references do (details in §10): Hermes ships a repo `skills/` + `optional-skills/`
tree in Anthropic Agent Skills format and a hub that copies a skill dir into the agent's
skills path (with a scanner/trust tier Ziggy doesn't need); OpenClaw ships first-party skills
in-repo and loads workspace/global/bundled skill dirs by config admission. Both treat "a skill
is a directory; install = copy the directory; the catalog is a git repo."

Recommended shape for Ziggy (smallest thing that matches spec + references):

1. **One catalog repo (or `catalog/` dir in this repo): `ziggy-skills/<id>/SKILL.md` in
   Pi/Anthropic skill format.** Port Starman bundles by rewriting each SKILL.md to drive its
   CLI via Pi's bash tool directly (`gh`, `linear-api` via `bunx`, AppleScript via `osascript`)
   instead of Starman supervised-command tools. Most of the 34 command extensions are thin
   wrappers over a CLI the skill can call itself; the 5 skill-only ones (humanizer,
   self-improving-agent, smart-memory†, skill-creator, automation-creator) port as text edits.
   († smart-memory must target `memory_write`, not a second memory authority.)
2. **Install = copy/symlink into `<profile>/skills/<id>`.** A `ziggy skills add <id|path>`
   subcommand (copy from catalog, refuse overwrite, list installed) is ~50 lines against the
   existing profile plumbing and keeps the "plain visible files" principle — no state beyond
   the directory itself. Update = re-copy; diff is `git diff` in the catalog.
3. **Trust = read the diff.** No seals/approvals/scanner at this scale; the catalog is yours.
   The one gate that matters: skills that need binaries state them in frontmatter prose, and
   the skill fails conversationally when the binary is absent (Hermes' pattern).
4. **TS loop-hook extensions stay rare** and live the same way under
   `<profile>/extensions/`; catalog them only when one earns existence.
5. Revisit the headless `tools:` allowlist before porting command-flavored skills — a skill
   that shells out works in the TUI today but a gateway chat can't execute bash with the
   current memory-only policy.

## 9. Findings walk-through, with what each reference system does

1. **Shared-memory LWW (critical).** Starman: expected-old-content CAS + prepared/committed
   journal + 8 reload-retries. Hermes: exclusive `flock` on a sibling `<target>.lock`,
   re-read from disk *inside the lock*, mutate, then tmp+fsync+atomic-rename; batches are
   all-or-nothing per file; no version token — correctness rests on every writer honoring the
   lock (`tools/memory_tool.py:280-363,752-894`). OpenClaw: generic file tools go through an
   in-process keyed mutation queue; the memory-promotion path additionally takes a persisted
   per-workspace lock with owner PID and stale recovery
   (`extensions/memory-core/src/short-term-promotion-store.ts:75-124`). **Every reference has
   at least a lock; Ziggy has none.** Smallest fix: `memory_write` reads the doc, computes a
   hash, and the write path re-reads and compares under a profile-scoped lock before rename
   (hermes shape, no journal needed for whole-doc replace).
2. **Telegram at-least-once (high).** Starman: persisted poll offset + claimed inbound update
   keys + delivered-seq per route in `gateways/telegram-host.json` — claims recorded before
   processing, cleared after the batch commits. OpenClaw: strongest — durable ingress queue
   keyed by `update_id` (enqueue acknowledged before the offset advances), a persisted offset
   store, plus a second `(chat, message_id)` dedupe with 7-day TTL; outbound sends retry only
   safe-to-retry classes and the crash-after-accept duplicate window is documented as
   irreducible (`extensions/telegram/src/telegram-ingress-spool.ts`, `message-dispatch-dedupe.ts`).
   Hermes: notably has **no general inbound dedupe** — it passes `drop_pending_updates=True`
   on cold start (deliberately discarding the backlog instead of replaying it) and instead
   invests in an **outbound delivery ledger** in SQLite: obligations recorded before sending,
   dead-process rows reclaimed at startup and resent with a visible "possible duplicate"
   marker, 3 attempts, 24h staleness (`gateway/delivery_ledger.py`). Ziggy options, cheapest
   first: (a) hermes' cold-start stance — one flag-equivalent, drops offline messages;
   (b) starman's claims file — offset + claimed update_ids persisted under `<profile>/gateways/`;
   (c) openclaw's full spool — overkill at this scale. (b) is the right target.
3. **Stale runtime memory (high).** OpenClaw re-reads bootstrap/persona files **every turn**
   (mtime-keyed cache, reuse only when bytes equal — `src/agents/bootstrap-cache.ts:46-68`) and
   keeps dynamic content behind an explicit cache-boundary marker so freshness doesn't poison
   the cached prefix. Hermes freezes the memory prompt for the cached agent's lifetime (same
   as Ziggy) but has explicit rebuild triggers — config-signature change, cache eviction, and a
   cross-process staleness check comparing the DB `message_count` against the cached agent
   (`gateway/run.py:21410-21506`). Ziggy fix options: re-read memory per prompt into
   `appendSystemPrompt` at runtime-rebuild (openclaw), or keep frozen and dispose gateway
   handles when a memory write lands (hermes trigger style). Per-prompt re-read is simpler and
   the cache cost is bounded by Pi's prompt assembly.
4. **Wake-gate provenance (high).** Ziggy's gate is a shell predicate: clean nonzero exit
   declines; spawn-failure/timeout fail open with a warning. Both references use a JSON
   protocol instead: only an exact `{"wakeAgent": false}` on stdout skips; *everything* else —
   including nonzero exit — proceeds (starman `run.ts`; hermes `cron/scheduler.py:2966-2986`,
   the `is not False` identity check). Hermes also returns a successful `[SILENT]` result for a
   false gate, and persists gate evidence with the run. Ziggy's exit-code semantics are fine
   (stricter, shell-friendly), but before any scheduler exists the wake service must carry
   trigger provenance + gate outcome in its result, and a scheduler should adopt hermes'
   at-most-once claim pattern: advance `next_run_at` under a file lock *before* executing,
   run-claims with TTL for one-shots (`cron/jobs.py:1799-1929`).
5. **Owner identity split (multi-person path).** OpenClaw's answer is `identityLinks` — a
   config map replacing a channel peer ID with one canonical identity before session/state
   keys are built (`src/routing/session-key.ts:216-267`) — plus DM `pairing` policy: unknown
   senders get a challenge and are denied until the operator approves, approved identities
   merge into the allowlist. Hermes canonicalizes aliases per channel
   (`gateway/whatsapp_identity.py`: alias set → one canonical ID used for both authz and
   session keys) and runs a central authorization mixin (allowlists → adapter roles →
   operator-approved pairing → allow-all). For Ziggy today the one-line version: map the
   configured `ownerUserId` to memory id `owner` when building ChatContext — one person, one
   file. Later multi-person = openclaw-style pairing + allowlist, which the audit already
   scoped.
6. **Registry race / JSONL tail (medium).** No reference has an equivalent registry (openclaw
   and hermes are cwd/home-profile systems). Hermes trusts SQLite WAL for session state;
   starman validated NDJSON contiguity and failed loud on torn tails. Pi's silent-skip tail is
   Pi's; accept or upstream. Registry: lock or tolerate duplicates (list already unions/prunes).

## 10. Reference columns by domain

### Skills/extension maintenance

| Aspect | OpenClaw | Hermes | Ziggy takeaway |
|---|---|---|---|
| Format | AgentSkills `SKILL.md` + `scripts/ references/ assets/`; `metadata.openclaw` gates (os, requires.bins/env, install hints) | same format; `metadata.hermes` (platforms, required_env, config, blueprint) | Pi skills are the same family; port Starman bundles to plain SKILL.md |
| Sources | 6-root precedence merge: workspace → `.agents` → `~/.agents` → managed global → bundled → extraDirs/plugins; name shadowing | profile `~/.hermes/skills/` is the only runtime source; repo `skills/` synced in; `external_dirs` config | Ziggy: profile-only admission is already right; a catalog is just a copy source |
| Bundled updates | ship with package; user copies shadow same-named bundled | `.bundled_manifest` hash baseline: new→copy, unchanged→upgrade, user-modified→preserve, user-deleted→don't resurrect (`tools/skills_sync.py`) | steal the manifest trick if/when `ziggy skills sync` exists; plain copy until then |
| Community | ClawHub registry: lock entry (version, hashes, provenance), owner-scope checks, release-specific trust dispositions, `--force` tiers | hub: quarantine dir → Skills Guard regex scanner → trust policy (builtin/trusted/community) → `.hub/lock.json` provenance + audit log | skip registries/scanners at one-user scale; catalog-repo + `git diff` is the trust model |
| Plugins (code) | manifest + `register(api)` entry, config-driven activation, SQLite install index, isolated npm projects | n/a (Python toolsets instead) | Pi TS extensions fill this slot; keep them rare and profile-local |

### Identity & sessions

- OpenClaw session keys: `dmScope` main/per-peer/per-channel-peer/per-account-channel-peer;
  groups by chat+topic; mention gating separate from authorization; runs serialized per
  session key through in-process lanes (concurrency 1) + global lane cap.
- Hermes session keys: profile+platform+chat+thread; groups default **per-participant**
  sessions, threads shared; single-flight session create; per-turn lease keyed by durable
  session id (fails open on timeout); transcript re-loaded from SQLite every turn.
- Ziggy equivalent (per-chat dirs + semaphore) matches this shape at smaller scale; the
  missing piece is only the cross-face lease (§9.1/§3).

### Automation

- OpenClaw cron is ~22.7k LOC (delivery-validation pipeline, pacing/stagger, isolated agent
  contexts) — the documented "what not to copy". Its heartbeat became cron-owned scratch with
  a monotonic-revision CAS store and an empty-scratch preflight that skips the model.
- Hermes scheduler is one file + jobs store: at-most-once via advance-before-run under file
  lock, run/fire claims with TTL, `no_agent` never constructs the agent, fresh session
  `cron_<job>_<ts>` per run, `skip_memory=True`, deliver=origin/local/explicit/all with
  output persisted before delivery.
- Ziggy's wake is hermes-minus-scheduler; when the scheduler arrives, copy hermes' claim
  discipline and starman's trigger-tuple dedupe, not openclaw.
