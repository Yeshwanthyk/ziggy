# Finish-line reference audit

## Scope and provenance

This is a narrow source audit, not a parity survey. It considers only automation
scheduling/admission/gates/delivery outcomes, resident ownership, operator
visibility, and graceful shutdown. Starman was not inspected.

| Repository | Audited commit | Disposable checkout |
|---|---|---|
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/ad6df5eb95b1e96da9b6c2c9b037aecdb5cfc692) | `ad6df5eb95b1e96da9b6c2c9b037aecdb5cfc692` | `/tmp/ziggy-hermes-agent.zxi6YJ` |
| [openclaw/openclaw](https://github.com/openclaw/openclaw/tree/49c62f35055dfec024ac02e7c818e7ec4f0a3633) | `49c62f35055dfec024ac02e7c818e7ec4f0a3633` | `/tmp/ziggy-openclaw.5YrKjT` |

Ziggy was read at `3f283d781f7b60017712b688c14a3eccdd7764c2`.

## Conclusion

Hermes and OpenClaw prove five invariants that matter at their scale. They do
not prove that Ziggy currently needs a Profile-wide lease, durable automation
run records, or a lifecycle state machine. Those mechanisms remain product
choices, not reference-driven requirements.

The one immediate Ziggy gap is smaller: an automation that explicitly requests
Telegram delivery can finish successfully after configuration loading was
skipped. After that, scheduler ownership must be settled before cron code is
shaped. The remaining sections preserve the upstream evidence and then filter
it through Ziggy's current boundaries.

### 1. One profile has at most one resident owner

**Proven invariant.** A resident acquires an exclusive, profile/state-scoped
lease before opening channels or sessions, keeps it for the whole lifecycle,
and releases it last. The lease identifies an owner strongly enough to avoid
PID-reuse errors; stale recovery removes a lease only when its owner is proven
dead and otherwise fails closed. OpenClaw records PID, random owner ID, process
start time, config, state directory, and port
([lock payload](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/infra/gateway-lock.ts#L25-L67)),
checks PID plus start identity before declaring an owner live or dead
([owner check](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/infra/gateway-lock.ts#L175-L219)),
and holds both state- and config-scoped locks until explicit release
([acquire/release](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/infra/gateway-lock.ts#L358-L426)).

**Ziggy contrast.** The specification says that the first resident gateway
becomes the exclusive owner of live Profile sessions and local faces attach
([minimal architecture](./minimal-ziggy-scout.md#L9-L15)), but the live CLI
starts Telegram, Discord, and Slack as independent processes and still opens
local TUI/run sessions directly
([entrypoint](../../src/main.ts#L195-L262)). None acquires a Profile lease.
Per-chat semaphores protect only one process-local chat; they do not fence a
second gateway or local face
([Telegram path](../../src/application/gateway.ts#L203-L273)).

**Possible Ziggy slice.** A Profile runtime lease would enforce the original
single-resident architecture, but it would also make the current separate
Telegram, Discord, and Slack commands mutually exclusive. Ziggy must first
choose whether one Profile-wide resident or independent channel residents are
the intended product. Do not add a lease merely because the references have
one.

### 2. Every automation attempt is durably reserved before model or delivery effects

**Proven invariant.** Eligibility is only a snapshot; execution requires a
durable per-run reservation written under serialization, followed by a
revalidation immediately before activation. OpenClaw persists `queuedAtMs`
before releasing its service lock
([reservation](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/cron/service/ops-run-preparation.ts#L294-L341)),
then reloads and rechecks stopped state, job existence, reservation identity,
current eligibility, and spec validity after any admission wait
([activation](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/cron/service/ops-run-preparation.ts#L402-L471)).
Hermes independently persists one-shot run claims while finding due work and
uses owner-matched heartbeats so another scheduler skips a live run but can
recover a dead one
([claim and stale-owner policy](https://github.com/NousResearch/hermes-agent/blob/ad6df5eb95b1e96da9b6c2c9b037aecdb5cfc692/cron/jobs.py#L2048-L2082),
[claim creation](https://github.com/NousResearch/hermes-agent/blob/ad6df5eb95b1e96da9b6c2c9b037aecdb5cfc692/cron/jobs.py#L2247-L2272)).

**Ziggy contrast.** `wake` reads a file, optionally runs a gate, opens a fresh
session, prompts, prints, and optionally sends Telegram
([wake path](../../src/application/automations.ts#L148-L189)). There is no
scheduler, run ID, due-time claim, running marker, terminal record, retry
policy, or same-automation exclusion. Concurrent or replayed invocations are
independent side effects.

**Possible Ziggy slice.** Keep automation definitions as Markdown. Once a
scheduler owner exists, atomically claim one deterministic firing ID before
calling the current fresh-session wake path. A full
`reserved -> running -> terminal` ledger is not required by the current
at-most-once, no-retry scheduler plan. If Ziggy later promises recovery or run
history, Hermes' rule is useful: abandoned claimed/running executions become
`unknown` rather than silently inferred success
([interrupted recovery](https://github.com/NousResearch/hermes-agent/blob/ad6df5eb95b1e96da9b6c2c9b037aecdb5cfc692/cron/executions.py#L182-L207)).

### 3. A configured gate is an admission decision, and execution and delivery have separate outcomes

**Proven invariant.** Gate evaluation happens before agent construction or
prompt execution. Hermes runs its pre-check before building the prompt and
returns without an agent run when the gate declines
([wake-gate ordering](https://github.com/NousResearch/hermes-agent/blob/ad6df5eb95b1e96da9b6c2c9b037aecdb5cfc692/cron/scheduler.py#L2954-L2974)).
This ordering is the reusable fact; Hermes' permissive parser is not a policy
for Ziggy.

Execution success does not imply delivery success. Hermes stores
`last_status`/`last_error` separately from `last_delivery_error`
([job result](https://github.com/NousResearch/hermes-agent/blob/ad6df5eb95b1e96da9b6c2c9b037aecdb5cfc692/cron/jobs.py#L1641-L1669)).
OpenClaw makes the distinction explicit with run states
`ok | error | skipped` and delivery states
`delivered | not-delivered | unknown | not-requested`
([outcome types](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/cron/types.ts#L108-L145));
its run history carries run ID, timing, session identity, diagnostics, and
delivery result separately
([run log](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/cron/run-log-types.ts#L12-L34)).

**Ziggy contrast.** A non-zero gate exit declines correctly, while spawn
failure or timeout intentionally logs “proceeding” and reaches the model
([gate handling](../../src/application/automations.ts#L64-L121),
[admission](../../src/application/automations.ts#L152-L170)). A manual wake
still has direct user input; a future scheduled wake must require a passed
gate. Missing Telegram config is the current concrete gap: it is logged and
treated as a successful return, while send failure remains typed
([delivery](../../src/application/automations.ts#L123-L146)).

**Smallest Ziggy requirement.** If `telegram-chat` is configured, configuration
or send failure must fail the wake after stdout receives the local result. A
manual wake without requested delivery remains unchanged. For scheduling,
require a configured gate to return exit zero before the firing reaches Pi.
Do not add persisted delivery states until recovery or run-history behavior is
actually promised.

### 4. Operators can inspect stored truth and live ownership without opening a model session

**Proven invariant.** Operator surfaces separate static diagnosis, live health,
and stored-session inventory. OpenClaw registers read-only `status`, live
gateway `health`, and a filterable/JSON-capable `sessions` command
([CLI surfaces](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/cli/program/register.status-health-sessions.ts#L111-L219)).
Its session projection includes identity, kind, channel, timestamps, token
counts, and run state
([session row contract](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/agents/tools/sessions-list-tool.ts#L52-L121)).
Hermes' smaller shared listing policy is source-scoped by default, can widen or
search explicitly, excludes the current session, and orders search by recent
activity
([session listing](https://github.com/NousResearch/hermes-agent/blob/ad6df5eb95b1e96da9b6c2c9b037aecdb5cfc692/hermes_cli/session_listing.py#L45-L84)).

**Ziggy contrast.** The CLI can list Profiles and auth status, but has no
resident status, doctor, automation-run status, or recursive session listing
([command surface](../../src/main.ts#L55-L252)). `run -c` selects an implicit
recent local session, while channel and automation sessions live in separate
nested roots; the operator cannot see that topology from Ziggy.

**Possible Ziggy slices.**

- `ziggy status <profile>`: lease owner, process start, lifecycle state, active
  turns/wakes, and latest automation/delivery outcomes.
- `ziggy doctor <profile>`: read-only validation of Profile/config/automation
  files, lease-owner liveness, session-tail readability, and interrupted or
  unknown runs.
- `ziggy sessions <profile>`: recursively list session path, face/chat key,
  session ID, modified time, and active-writer status; offer JSON output.

For the current milestone, `sessions` and `doctor` are enough. `status` should
wait until Ziggy owns live lease or run state worth projecting. These reads are
projections over Pi and Profile files, not new authorities.

### 5. Shutdown closes admission first, drains bounded work, records ambiguity, then releases ownership

**Proven invariant.** Shutdown is a one-way state transition. OpenClaw marks
itself shutting down and ignores duplicate signals
([signal admission](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/cli/gateway-cli/run-loop.ts#L787-L838));
on restart it rejects new work, reports active blockers, waits within a budget,
marks interrupted sessions when the budget expires, and only then closes the
server
([drain path](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/cli/gateway-cli/run-loop.ts#L581-L755)).
Its close handler drains sessions and cron before closing WebSocket/HTTP
listeners with bounded grace periods
([close sequence](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/gateway/server-close.ts#L713-L890),
[transport close](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/gateway/server-close.ts#L931-L1032)),
then returns duration plus warnings
([shutdown result](https://github.com/openclaw/openclaw/blob/49c62f35055dfec024ac02e7c818e7ec4f0a3633/src/gateway/server-close.ts#L1054-L1068)).

**Ziggy contrast.** Effect scopes do dispose cached handles, and Discord/Slack
also close their socket
([Telegram finalizer](../../src/application/gateway.ts#L182-L212),
[Discord finalizer](../../src/application/discord-gateway.ts#L209-L218),
[Slack finalizer](../../src/application/slack-gateway.ts#L213-L221)).
That is resource cleanup, not a lifecycle contract: there is no close-admission
state, drain budget, durable interrupted/unknown outcome, resident lease, or
operator-visible shutdown result. Discord and Slack turns are forked into the
scope and are interrupted when it closes
([Discord dispatch](../../src/application/discord-gateway.ts#L257-L266),
[Slack dispatch](../../src/application/slack-gateway.ts#L260-L269)), while the
entrypoint maps interrupt-only gateway exits to status zero
([teardown](../../src/main.ts#L317-L329)).

**Possible Ziggy slice.** Current Effect scopes already close sockets and Pi
handles. Add admission closure, bounded drain, and durable interrupted outcomes
only when Ziggy has selected a resident scheduler and owns in-flight state that
must survive termination. Do not build shutdown infrastructure ahead of that
state.

## Ziggy gap filter

### Do now

1. Make explicitly configured automation delivery fail truthfully.
2. Decide whether scheduled work belongs to one Profile-wide resident or a
   scheduler-specific resident.
3. Implement one deterministic claim-before-wake cron slice after that choice.
4. Add read-only `sessions`, then `doctor`.

### Keep deferred

- A general automation run ledger or retry engine.
- Profile-wide process ownership until the multi-channel product choice is
  explicit.
- `status` before there is live Ziggy-owned state to project.
- A shutdown state machine before scheduled claims or durable runs exist.
- Durable gateway delivery journals before gateways are load-bearing.
