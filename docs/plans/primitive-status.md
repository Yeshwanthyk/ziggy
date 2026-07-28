# Primitive status

Current comparison as of 2026-07-27:

- Ziggy `f41a02a`
- Merlin `882e97f` (read-only dirty checkout)
- Starman `89b8ad5` (read-only dirty checkout)
- cached `opensrc` snapshots of `NousResearch/hermes-agent` and `openclaw/openclaw`

This is a work queue, not a parity checklist. Hermes, OpenClaw, Merlin, and Starman show which
invariants become important at scale; Ziggy should keep Pi as the authority and add only the next
end-to-end slice.

## Comparison

| Primitive | Ziggy now | Merlin | Hermes | OpenClaw | Starman | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Profile | Folder + `SOUL.md` + path registry. A symlink target can be followed and registered under its link spelling; no resident lease. | Canonical Profile root, strict Profile shape, one runtime writer. | Global agent/profile routing rather than folder identity. | Workspace/config identity plus gateway ownership controls. | Canonical initialization and daemon ownership guard. | Fix path identity, then add the Profile lease. Do not copy richer Profile metadata. |
| Provider | Profile-local Pi `ModelRuntime`, auth, models, and login. | Custom provider surface in its staged runtime. | Global model pools and provider config. | Multi-source model and auth configuration. | Ziggy-owned provider defaults and selection. | Keep Pi as the only provider authority. Add read-only doctor output later. |
| Session | Pi JSONL; fresh TUI/run by default, explicit `run -c`, persistent per-channel chats, fresh automation sessions. | Strict JSONL session records and effect evidence. | Database-backed restore and routing. | Namespaced session keys and broader routing state. | Stable main session and daemon attach behavior. | Keep Pi semantics. Add read-only `sessions`; defer named sessions, pickers, and a second registry. |
| Memory | Scoped Markdown, atomic entry operations, SQLite writer locks. Prompt memory is frozen when a runtime is created. | Scoped SQLite memory with revisions and search. | File memory with lock-and-reread mutation. | File memory plus search/read and fresher prompt assembly. | Scoped snapshots and journaled mutation. | Refresh admitted memory before every turn; keep Markdown and the existing write lock. |
| Extension | Profile-local Pi skills/extensions plus live Merlin catalog `list`/`add`; 61 unique skills. | Rich extension tree and the source catalog. | Sync, provenance, quarantine, and lifecycle machinery. | Multi-root discovery and hardened installation. | Manifest-driven extensions and supervised commands. | Complete for current scope. Defer remove/update/provenance; bundle only when sibling Merlin is no longer acceptable. |
| Gateway | Telegram, Discord, and Slack owner-only vertical slices with per-chat serialization and bounded in-memory dedupe. | Channel runner and per-session lane model; later target stages own the full gateway. | Mature multi-platform gateway and delivery state. | Durable ingress and delivery queue. | Telegram daemon with route/host state. | Add the Profile lease and run disposable live proofs. Defer a durable journal until these gateways are load-bearing. |
| Automation | Manual `wake`, gate, fresh Pi session, stdout, optional Telegram delivery. Missing Telegram config is swallowed after the model ran. | Cron claims in the existing system; automation is a distinct target stage. | SQLite schedule and execution ledger. | Persistent cron and delivery state. | Scheduled automation event evidence. | Surface configured-delivery failure now. Add the scheduler only after the lease. |

## Ordered slices

### 1. Profile path identity

Reject a Profile target that is itself a symlink. Canonicalize a real existing or newly created
directory before returning and registering it. Do not add metadata or migrate Profile contents.

Proof: initializing a symlink-to-directory fails without writing `SOUL.md` or the registry;
initializing the real path twice is byte-idempotent and produces one canonical registry entry.

### 2. Per-turn memory freshness

Stop fixing memory into `appendSystemPrompt` at runtime construction. Register one hidden inline Pi
extension whose `before_agent_start` hook rebuilds the admitted memory prompt and returns the
current Pi system prompt plus that fresh memory.

Proof: keep two persistent chats open for one Profile; chat A writes a unique shared fact and chat
B receives it on its next prompt without being disposed. Existing concurrent-add coverage must
stay green.

### 3. Profile lease

Implement the focused slice in `profile-lease.md`: one SQLite `BEGIN IMMEDIATE` lease shared by
all resident gateways, with TUI/run refusal unless `--force`. No attach protocol or supervisor.

### 4. Configured automation delivery failure

If an automation declares `telegram-chat`, a missing or invalid `telegram.json` is a typed wake
failure after the local reply is printed. A wake without `telegram-chat` remains unchanged. Do not
add retry, receipt, or outbox state.

Proof: the agent runs exactly once, stdout receives the reply, and missing Telegram configuration
returns delivery-unavailable rather than success.

### 5. Operator visibility

Land `ziggy sessions <profile>`, then `ziggy doctor <profile>`, as separate read-only slices from
`cli-polish.md`.

### 6. Scheduler

Only after the lease, add the claim-before-wake cron slice from `automation-scheduler.md`.

Live Telegram, Discord, and Slack proofs can run beside this queue whenever disposable
credentials are available. They do not justify durable delivery state yet.

## Explicitly deferred

- Durable gateway ingress/outbound journals and replay.
- A daemon attach protocol, RPC layer, or cross-channel event bus.
- Ziggy-owned provider, session, extension, or memory registries.
- Extension marketplace, provenance, quarantine, update, or remote fetch.
- Named sessions, resume picker, stable main session, voice presets, and dashboards.
