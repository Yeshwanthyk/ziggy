# Primitive status

Current Ziggy status on 2026-08-04.

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
| Automation | Manual `wake`, optional gate, fresh Pi session, stdout, and optional Telegram delivery. A configured `telegram-chat` prints the local reply before delivery; missing or invalid `telegram.json` fails as `AutomationDeliveryUnavailable`, while Telegram API failures retain their typed error. | Truthful walking skeleton shipped. Scheduling still needs one ownership decision. |

## Ordered work

### 1. Session visibility

Land `ziggy sessions <profile> [--json]` as the first read-only slice in
`openclaw-hermes-primitives.md`. Pinned Pi `0.82.0` exposes
`SessionManager.listAll(customDirectory)`; Ziggy can recurse its known Profile tree and project only
ID/path/timestamps/message count without parsing JSONL or exposing transcript previews.

### 2. Narrow doctor

Land `ziggy doctor <profile> [--json]` as a read-only composition of Profile readability,
channel-config, automation, and session checks. It does not call `Auth.status`, because Pi auth
checks may create/refresh credentials, and performs no network calls, repairs, migrations,
extension loading, or skill-requirement parsing.

### 3. Duplicate-resident decision

If duplicate channel consumers are a real operator risk, add only a face-scoped lease keyed by
`(Profile, telegram|discord|slack)`. Do not add a Profile-wide lease: the shipped channel commands
are independent and must remain able to run together. TUI, `run`, and `wake` remain unaffected.

Scheduling stays deferred until an automatic trigger is a concrete product requirement. Its first
slice must still atomically claim a deterministic trigger occurrence before model or delivery work.

Live Telegram, Discord, and Slack proofs can run beside this queue whenever disposable credentials
are available.

## Explicitly deferred

- Canonical Profile identity or symlink rejection.
- Profile-wide resident ownership while channels are separate commands.
- Graceful-drain lifecycle state before interrupted work has a promised outcome.
- Durable gateway ingress/outbound journals and replay.
- A daemon attach protocol, RPC layer, or cross-channel event bus.
- A general automation run ledger, retries, or delivery receipts.
- Ziggy-owned provider, session, extension, or memory registries beyond direct package discovery.
- Extension marketplace, provenance, quarantine, update, or remote fetch.
- Named sessions, resume picker, voice presets, and dashboards.
