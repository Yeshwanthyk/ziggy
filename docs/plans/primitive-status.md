# Primitive status

Current Ziggy status on 2026-07-29.

This is a work queue, not a parity checklist. Pi remains authoritative for providers, sessions,
compaction, branching, skills, extensions, and the TUI. Reference repositories are evidence only,
not active targets.

## Shipped

| Primitive | Ziggy now | Verdict |
| --- | --- | --- |
| Profile | The current working directory is the Profile. `SOUL.md` marks initialization; names and explicit paths remain supported entry conveniences. Symlink spelling is accepted. | Complete. Do not add canonical-realpath identity, symlink rejection, or richer Profile metadata. |
| Provider | Profile-local Pi `ModelRuntime`, auth, models, and login. | Complete. Keep Pi as the only provider authority. |
| Session | Pi JSONL. TUI and `run -c` share `sessions/local/main/`; plain `run` is fresh; each gateway chat persists; every automation and direct Profile agent run is fresh. Nested Profile agents are saved Pi children linked by the child header and parent tool result. `sessions list/show` recursively expose transcript-free lineage, usage, model/thinking changes, and safe terminal state without mutating Pi files. | Complete for conversation, Profile agent lineage, and read-only operator visibility. Pi remains the only transcript, compaction, and branching authority. |
| Memory | Scoped Markdown, entry operations, per-document SQLite writer locks, and fresh `before_agent_start` injection every turn. Owner DMs across Telegram, Discord, and Slack share `memory/users/owner.md`; other memory remains scoped. | Complete. Do not add a memory registry, index, or second compactor. |
| Extension | All 47 repository-owned `extensions/<id>/` folders are Pi packages containing skills, executable extension code, or both. Profile skills load first, package skills next, and top-level skills last. All 19 package tools run in every face. One hidden internal Pi extension shapes the TUI. | Complete. Pi remains the only extension host; do not add a parallel registry or load Profile-authored executable code. |
| Gateway | Telegram, Discord, and Slack owner-only vertical slices with scoped shutdown, persistent per-chat sessions, and bounded transport redelivery suppression. | Functionally shipped. Disposable live proofs remain credential-dependent; durable delivery state remains deferred. |
| Automation | Manual `wake`, optional gate, fresh Pi session, stdout, and optional Telegram delivery. Tagged runs use one saved root Profile agent session; untagged runs use a saved Profile chat with the same agent admission as other faces. A configured `telegram-chat` prints the local reply before delivery; missing or invalid `telegram.json` fails as `AutomationDeliveryUnavailable`, while Telegram API failures retain their typed error. | Truthful walking skeleton shipped. Scheduling still needs one ownership decision. |
| Profile Agent | `agents/<id>.md` owns role/model/reasoning/tool policy. TUI, print, gateways, and automations share discovery, leading-mention validation, and optional `agent_run`/`agent_discuss` admission. Nested runs are isolated saved children; direct and tagged runs are saved roots. | Complete for foreground, bounded non-recursive execution. Background trees and child resume remain out of scope. |

## Ordered work

### 1. Decide scheduler ownership

Choose the process that owns scheduled claims before implementing cron:

- one Profile-wide resident, which means only one of the current channel commands can run; or
- a scheduler-specific resident owner, leaving channel processes independent.

The current separate Telegram, Discord, and Slack commands make a Profile-wide lease a product
decision, not a mechanical prerequisite.

### 2. Claim-before-wake scheduler

After ownership is settled, implement only the slice in `automation-scheduler.md`: parse `cron`,
derive one deterministic firing ID, atomically claim that firing before model or delivery work, and
prevent overlap for the same automation. Keep definitions as Markdown and every run as a fresh Pi
session. Do not add a general run ledger, retries, dashboards, or lifecycle state machine.

### 3. Profile doctor

Land `ziggy doctor <profile>` as the next read-only operator slice from `cli-polish.md`. It projects
Pi and Profile state; it does not create a new authority.

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
