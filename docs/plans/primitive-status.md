# Primitive status

Current Ziggy status on 2026-07-28.

This is a work queue, not a parity checklist. Pi remains authoritative for providers, sessions,
compaction, branching, skills, extensions, and the TUI. Reference repositories are evidence only,
not active targets.

## Shipped

| Primitive | Ziggy now | Verdict |
| --- | --- | --- |
| Profile | The current working directory is the Profile. `SOUL.md` marks initialization; names and explicit paths remain supported entry conveniences. Symlink spelling is accepted. | Complete. Do not add canonical-realpath identity, symlink rejection, or richer Profile metadata. |
| Provider | Profile-local Pi `ModelRuntime`, auth, models, and login. | Complete. Keep Pi as the only provider authority. |
| Session | Pi JSONL. TUI and `run -c` share `sessions/local/main/`; plain `run` is fresh; each gateway chat persists; every automation run is fresh. Pi owns compaction and branching. | Complete for conversation semantics. Add only read-only operator visibility. |
| Memory | Scoped Markdown, entry operations, per-document SQLite writer locks, and fresh `before_agent_start` injection every turn. Owner DMs across Telegram, Discord, and Slack share `memory/users/owner.md`; other memory remains scoped. | Complete. Do not add a memory registry, index, or second compactor. |
| Extension | All 47 repository-owned `extensions/<id>/` folders are Pi packages containing skills, executable extension code, or both. Profile skills load first, package skills next, and top-level skills last. All 19 package tools run in every face. One hidden internal Pi extension shapes the TUI. | Complete. Pi remains the only extension host; do not add a parallel registry or load Profile-authored executable code. |
| Gateway | Telegram, Discord, and Slack owner-only vertical slices with scoped shutdown, persistent per-chat sessions, and bounded transport redelivery suppression. | Functionally shipped. Disposable live proofs remain credential-dependent; durable delivery state remains deferred. |
| Automation | Manual `wake`, optional gate, fresh Pi session, stdout, and optional Telegram delivery. | Walking skeleton shipped. Truthful configured-delivery failure is the next narrow code slice; scheduling still needs one ownership decision. |

## Ordered work

### 1. Configured automation delivery failure

If an automation declares `telegram-chat`, missing or invalid `telegram.json` must be a typed wake
failure after the local reply is printed. A wake without `telegram-chat` remains unchanged. Do not
add retry, receipts, an outbox, or a run ledger.

Proof: the agent runs exactly once, stdout receives the reply, and missing Telegram configuration
returns delivery-unavailable rather than success.

### 2. Decide scheduler ownership

Choose the process that owns scheduled claims before implementing cron:

- one Profile-wide resident, which means only one of the current channel commands can run; or
- a scheduler-specific resident owner, leaving channel processes independent.

The current separate Telegram, Discord, and Slack commands make a Profile-wide lease a product
decision, not a mechanical prerequisite.

### 3. Claim-before-wake scheduler

After ownership is settled, implement only the slice in `automation-scheduler.md`: parse `cron`,
derive one deterministic firing ID, atomically claim that firing before model or delivery work, and
prevent overlap for the same automation. Keep definitions as Markdown and every run as a fresh Pi
session. Do not add a general run ledger, retries, dashboards, or lifecycle state machine.

### 4. Operator visibility

Land `ziggy sessions <profile>`, then `ziggy doctor <profile>`, as separate read-only slices from
`cli-polish.md`. They project Pi and Profile state; they do not create new authorities.

Live Telegram, Discord, and Slack proofs can run beside this queue whenever disposable credentials
are available.

## Explicitly deferred

- Canonical Profile identity or symlink rejection.
- Durable gateway ingress/outbound journals and replay.
- A daemon attach protocol, RPC layer, or cross-channel event bus.
- A general automation run ledger, retries, or delivery receipts.
- Ziggy-owned provider, session, extension, or memory registries beyond direct package discovery.
- Extension marketplace, provenance, quarantine, update, or remote fetch.
- Named sessions, resume picker, voice presets, and dashboards.
