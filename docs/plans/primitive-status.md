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
| Session | Pi JSONL. TUI and `run -c` share `sessions/local/main/`; plain `run` is fresh; each gateway chat persists; every automation run is fresh. Pi owns compaction and branching. | Complete for conversation semantics. Add only read-only operator visibility. |
| Memory | Scoped Markdown, entry operations, per-document SQLite writer locks, and fresh `before_agent_start` injection every turn. Owner DMs across Telegram, Discord, and Slack share `memory/users/owner.md`; other memory remains scoped. | Complete. Do not add a memory registry, index, or second compactor. |
| Extension | All 47 repository-owned `extensions/<id>/` folders are available Pi packages containing skills, executable extension code, or both. A new Profile loads no user-selected resources; the internal automation policy and hidden Ziggy extensions are always admitted. Pi otherwise loads only Profile-added extensions and Profile-installed skills. `/skills` marks installed entries, multi-selects from 57 catalog skills, and reloads the TUI once after installation. | Complete. Pi remains the only extension host; repository packages are catalog sources, not globally active defaults. |
| Gateway | Telegram, Discord, and Slack owner-only vertical slices with scoped shutdown, persistent per-chat sessions, and bounded transport redelivery suppression. | Functionally shipped. Disposable live proofs remain credential-dependent; durable delivery state remains deferred. |
| Automation | Profile-owned Markdown definitions with deterministic frontmatter, legacy reads, typed atomic CRUD, `automation_list/create/update/remove`, and `/automations` create/list/inspect/edit/pause/resume/remove. The always-admitted automation skill routes requests directly to Ziggy. Manual `wake`, optional gate, fresh Pi session, stdout, and optional Telegram delivery remain available; disabled definitions decline before Pi. | V1 shipped. V2-V5 add receipts, scheduling, service ownership, and broadcast fan-out in that order. |

## Ordered work

### 1. Automation V2-V5

Build `automation-slices.md` in order:

1. Run now, durable bounded receipts, and TUI reopen/catch-up.
2. Cron scheduling in one dedicated foreground Profile process.
3. A Profile-specific scheduler service that survives TUI and terminal closure.
4. Telegram, Discord, and Slack fan-out with truthful per-target receipts.

### 2. Operator visibility

Land `ziggy sessions <profile>`, then `ziggy doctor <profile>`, as separate read-only slices from
`cli-polish.md`. They project Pi and Profile state; they do not create new authorities.

Live Telegram, Discord, and Slack proofs can run beside this queue whenever disposable credentials
are available.

## Explicitly deferred

- Canonical Profile identity or symlink rejection.
- Durable gateway ingress/outbound journals and replay.
- A daemon attach protocol, RPC layer, or cross-channel event bus.
- Automation retries, an outbox, delivery replay, or unbounded run history.
- Ziggy-owned provider, session, extension, or memory registries beyond direct package discovery.
- Extension marketplace, provenance, quarantine, update, or remote fetch.
- Named sessions, resume picker, voice presets, and dashboards.
