# Portable automation scheduling

Research snapshot: 2026-07-31, Ziggy `77c05182b5f452c9be93d7e44504512c8ed416c6`,
Hermes Agent `5835201de19b099d76b8e4c64afe8af90c98af05`, and OpenClaw
`184c13d01ced6d89fd4f166564f6fa2c2dd43a87`.

This is prospective decision input. The current local contract is
[`automations.md`](../automations.md); implementation and focused tests remain authoritative.

## Decision

Keep Ziggy's schedule evaluation, durable firing claim, gate, agent run, receipt, and delivery
inside the application. Treat launchd, systemd, Cloudflare, Vercel, EventBridge, and plain cron as
replaceable ways to produce a `WakeSignal`, not as scheduling authorities that understand Ziggy
automations.

The first portable slice shouldn't move execution to the cloud. It should separate the existing
foreground scheduler from its local polling clock, prove the same firing can arrive through an
authenticated HTTP adapter, and preserve one invariant: claim
`(profile, automationId, firingId)` durably, then evaluate `wakeGate`, then open Pi.

That ordering already exists locally: the runner creates the deterministic scheduled receipt and
claims it before it enters the per-automation lease; the configured gate runs inside that lease and
before `agent.openChat` ([runner](../../src/application/automation-runner.ts)). Portability should
make this ordering explicit, not replace it.

## What Ziggy ships now

Ziggy has one Profile-owned automation system, not a sketch:

- Definitions are typed Markdown under `automations/<id>.md`; receipts are bounded to 50 Markdown
  files per automation under `.runtime/automations/runs/<id>/`
  ([definitions](../../src/application/automations.ts),
  [receipts](../../src/application/automation-receipts.ts)).
- `cron`, one-shot `at`, and fixed-second `every` share one Effect-based evaluator. A scheduled
  identity is canonicalized as `<automationId>@<scheduled-instant-ISO>`
  ([schedule](../../src/domain/automation-schedule.ts)).
- The foreground scheduler owns one Profile-wide SQLite transaction lease, polls definitions,
  advances per-automation cursors, allows different automation IDs to run concurrently, collapses
  catch-up, and writes an instance-scoped heartbeat
  ([scheduler](../../src/application/automation-scheduler.ts)).
- Manual and scheduled work enter the same runner. A scheduled `firingId` hashes to a deterministic
  receipt filename; atomic hard-link creation rejects a duplicate claim. A separate SQLite lease
  prevents overlapping runs of one automation. Local output is persisted before independent
  Telegram, Discord, or Slack delivery outcomes
  ([runner](../../src/application/automation-runner.ts),
  [run lease](../../src/adapters/bun/automation-run-lease.ts)).
- launchd and systemd-user don't evaluate schedules. Each keeps the same
  `ziggy scheduler <profile>` process alive, while the application owns deadlines and claims
  ([service composition](../../src/application/automation-services.ts),
  [launchd](../../src/adapters/service/launchd.ts),
  [systemd-user](../../src/adapters/service/systemd-user.ts)).

The present limitations are deliberate: no Windows host service, webhook ingress, retry/outbox,
delivery replay, remote administration, or unbounded history
([current contract](../automations.md)). Local unattended work also inherits machine
availability: a launch agent is user-context work, and Apple documents that per-user launchd starts
at login and terminates its agents at logout ([Apple launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)); on Linux,
systemd explicitly requires user lingering to keep the user manager alive after logout
([`loginctl`](https://www.freedesktop.org/software/systemd/man/252/loginctl.html)). Ziggy correctly
surfaces the latter as a diagnostic.

The code is only partly replaceable today. `AutomationScheduleLoader`, `ScheduledAutomationRunner`,
and `AutomationDefinitionLoader` are injected boundaries, and schedule calculation is pure. But the
service status domain explicitly names only launchd and systemd-user; definitions and receipts use a
local `ProfileTarget.path`; claims and run leases use Bun SQLite and filesystem atomicity; the gate
spawns `/bin/sh`; Pi runs locally; and delivery is one closed Telegram/Discord/Slack interface
([service contract](../../src/domain/automation-service.ts),
[service selection](../../src/application/automation-services.ts),
[runner](../../src/application/automation-runner.ts)). A cloud scheduler cannot be added as one
adapter yet. The provider split below is the smallest refactor that should precede the new local
deadline loop.

## The 8,640 question is two questions

There are 86,400 seconds in a day, so the current 10-second loop performs
`86,400 / 10 = 8,640` scheduler scans per Profile per idle day. Each scan rewrites scheduler health,
and an independent 10-second heartbeat rewrites it again, producing about 17,280 health updates per
idle Profile per day. These are local filesystem and CPU operations, not model calls
([scheduler loop](../../src/application/automation-scheduler.ts),
[configured cadence](../../src/main.ts)).

Model tokens are spent only after a firing is due, claimed, enabled, admitted by `wakeGate`, and
sent to Pi. Usage is then the sum of the prompt, injected Profile context, tool/model traffic, and
reply. A gate that declines after the durable claim consumes a small receipt and no model tokens.
Therefore expose and budget two independent quantities:

1. `firings claimed / runs admitted / sessions retained` for disk and operator load;
2. measured model input/output/cache tokens for provider spend.

Replacing the 10-second scan with a next-deadline wake removes idle churn. It does not change the
number of scheduled opportunities or admitted model runs; cadence, gate selectivity, session
retention, and model behavior control those.

## Reference systems: borrow invariants, not scale

Hermes Agent does not create one operating-system job per automation. Its Gateway calls the cron
scheduler every 60 seconds from a background thread
([scheduler entry](https://github.com/NousResearch/hermes-agent/blob/5835201de19b099d76b8e4c64afe8af90c98af05/cron/scheduler.py#L1-L8)).
For recurring work it advances `next_run_at` before dispatch
([advance-before-run](https://github.com/NousResearch/hermes-agent/blob/5835201de19b099d76b8e4c64afe8af90c98af05/cron/scheduler.py#L4151-L4160)).
It also persists an execution as `claimed` before executor/provider dispatch
([execution store](https://github.com/NousResearch/hermes-agent/blob/5835201de19b099d76b8e4c64afe8af90c98af05/cron/executions.py#L135-L154)) and runs its wake gate before
constructing the agent prompt
([wake gate](https://github.com/NousResearch/hermes-agent/blob/5835201de19b099d76b8e4c64afe8af90c98af05/cron/scheduler.py#L2954-L2977)). Ziggy already has the
smaller admission pattern: deterministic claim, no replay after ambiguity, gate before Pi. The
Hermes gate saves model runs; it does not eliminate the Gateway's scheduler tick.

OpenClaw also keeps scheduling inside its Gateway, but its current scheduler calculates the next
wake, arms one `setTimeout`, and clamps long waits to a 60-second maintenance recheck for clock
jumps and recovery
([timer](https://github.com/openclaw/openclaw/blob/184c13d01ced6d89fd4f166564f6fa2c2dd43a87/src/cron/service/timer-scheduler.ts#L56-L116)).
Its larger queue/admission system reserves due work and revalidates it before activation, while its
domain models execution and delivery separately
([outcomes](https://github.com/openclaw/openclaw/blob/184c13d01ced6d89fd4f166564f6fa2c2dd43a87/src/cron/types.ts#L109-L145)). Ziggy should copy the
next-deadline timer and retain the separate outcomes without importing OpenClaw's queue, pacing, or
lifecycle machinery.

## ChatGPT Scheduled Tasks and Codex local work are different products

ChatGPT Scheduled Tasks are managed proactive work: one-off or recurring tasks, monitoring, and
notifications, with plan-specific active-task limits and a minimum one-hour cadence
([OpenAI Scheduled Tasks](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt)). That is a
hosted user-facing scheduling product, not a portable runtime contract for Ziggy.

Codex/ChatGPT desktop scheduled work can run against a local project or isolated worktree, but the
computer must remain on, the desktop app must be running, and the project must remain on disk.
Web-scheduled work can use uploaded context and connected tools but cannot directly use a local
folder; standalone runs start fresh chats, while chat-scoped schedules can retain chat context
([official scheduled-work docs](https://learn.chatgpt.com/docs/automations)). Those are useful UX
comparisons, but neither surface should become Ziggy's scheduler dependency. Ziggy's Profile,
receipts, Pi session paths, delivery credentials, and local gates are its execution authority.

## Provider-neutral scheduling

Cloud providers disagree on cron syntax, timezone, precision, retries, and targets:

- Cloudflare Cron Triggers invoke a Worker `scheduled()` handler in UTC, expose the scheduled time,
  and can take up to 15 minutes for configuration changes to propagate
  ([Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).
  Cloudflare recommends Durable Object alarms for finer-grained, programmatic schedules; alarms
  are at-least-once and one object can store many events while arming only its earliest deadline
  ([Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)).
- Vercel cron makes an HTTP GET to a production function path, uses UTC, doesn't retry failed
  invocations, may overlap runs, and may occasionally deliver the same cron event more than once;
  Vercel explicitly recommends locks and idempotency. Schedule changes are deployment
  configuration, so dynamic Profile CRUD may require a deployment rather than a live provider API
  ([Vercel cron](https://vercel.com/docs/cron-jobs),
  [reliability guidance](https://vercel.com/docs/cron-jobs/manage-cron-jobs)).
- EventBridge Scheduler supports one-time, rate, and cron schedules with timezones and flexible
  windows, and provides at-least-once delivery with configurable retries
  ([AWS schedule API](https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html),
  [delivery semantics](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html)).
- Cloudflare Queues likewise documents at-least-once delivery and recommends a producer-assigned
  unique ID used as a database key or downstream idempotency key
  ([Cloudflare queue guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)).

So don't compile Ziggy definitions into every provider's native cron and then trust provider event
identity. Use either of two replaceable adapters:

1. **Deadline tick:** provider invokes `tick(profileId, observedAt)`. Ziggy loads its definitions,
   evaluates due instants, derives canonical firing IDs, and claims them. This preserves current
   timezone/DST/catch-up semantics and is the recommended default.
2. **Explicit fire:** provider sends a fully resolved `WakeSignal` containing a Ziggy-issued
   canonical `firingId`. Use this only when a Ziggy control plane created the provider schedule and
   can preserve the intended instant across retries.

Traditional cron, launchd, and systemd can invoke the same local tick command. Cloudflare, Vercel,
or EventBridge can call the same authenticated HTTP ingress. The provider owns wake-up reliability;
Ziggy owns due-time meaning and side-effect admission.

## Replaceable contracts

Keep the data plane small and domain-owned. Most providers only need to wake the authoritative
planner; a provider-specific explicit firing remains available when a Ziggy control plane created
that exact schedule:

```ts
type WakeSignal =
  | {
      kind: "tick";
      profileId: string;
      observedAt: string;
      source: string;
      providerEventId?: string;
    }
  | {
      kind: "fire";
      profileId: string;
      automationId: string;
      scheduledInstant: string; // canonical UTC ISO instant
      firingId: string; // automationId@scheduledInstant
      observedAt: string;
      source: string;
      providerEventId?: string;
    };

interface ScheduleProvider {
  capabilities(): Effect<ScheduleCapabilities>;
  reconcile(profile: ProfileTarget): Effect<ScheduleStatus>;
  enable(profile: ProfileTarget): Effect<void>;
  disable(profile: ProfileTarget): Effect<void>;
  status(profile: ProfileTarget): Effect<ScheduleStatus>;
}

interface FiringClaimStore {
  claim(signal: Extract<WakeSignal, { kind: "fire" }>): Effect<"claimed" | "duplicate">;
}

interface WakeGate {
  evaluate(signal: Extract<WakeSignal, { kind: "fire" }>): Effect<"wake" | "skip">;
}

interface WakeIngress {
  accept(signal: WakeSignal): Effect<ReadonlyArray<AutomationRunReceipt>>;
}
```

The control plane and data plane remain separate. `ScheduleProvider` reconciles installation and
projects common status; it may expose optional capabilities such as local `restart` or cloud
`requiresDeployment`. The TUI renders only supported actions rather than pretending restart means
the same thing on launchd, Vercel, and EventBridge.

`source` and `providerEventId` are diagnostic only; neither participates in deduplication. The canonical
`firingId = automationId + "@" + scheduledInstant.toISOString()` is stable across providers and
retries. In a multi-Profile remote service, the actual uniqueness key is
`(profileId, automationId, firingId)`. Authenticate the envelope, validate its bounded clock skew
and Profile binding, then either recalculate due work for a tick or attempt the explicit durable
claim. A repeated firing returns the existing receipt or a duplicate acknowledgement; it never
opens Pi again.

`WakeGate` is also replaceable, but it is never a scheduler-provider responsibility. The local
adapter can keep today's shell command; a cloud-hosted runner could use a Worker function or HTTP
condition adapter; an automation without a configured gate uses an explicit always-wake adapter.
Every implementation runs after the canonical claim and before the executor. If a cloud provider
only wakes a local Profile, the gate still runs locally when Ziggy consumes the signal. If the
machine is offline, the signal must remain queued or become truthfully unreachable; the provider
must not record the agent as having run.

The runner boundary should read, in order:

```text
validate definition and signal
  -> claim firing durably
  -> acquire per-automation run lease
  -> wakeGate
  -> open fresh Pi session and prompt
  -> persist local result
  -> attempt independent deliveries
```

`wakeGate` stays after claim because a declined scheduled opportunity is still a consumed firing;
placing it before claim lets duplicate provider deliveries re-run an arbitrary shell command and
makes the absence of a model run indistinguishable from an unobserved firing. It stays before Pi so
a declined gate spends no model tokens. Gate failure policy remains explicit: current Ziggy
proceeds on spawn failure or timeout and skips only on non-zero exit
([runner](../../src/application/automation-runner.ts)); portability shouldn't silently change it.

## Cloud and offline delivery

Cloud wake-up cannot execute a Profile that exists only on an offline laptop. A provider retry can
bridge a short outage, but provider retention windows differ and aren't Ziggy history. The honest
states are `accepted`, `duplicate`, `temporarily-unreachable`, and `expired`; never report a run as
completed merely because the cloud scheduler fired.

For local Profiles, keep local scheduling authoritative and optionally expose a relay that queues
signed `WakeSignal`s until the machine reconnects. When it reconnects, Ziggy applies its existing
15-minute catch-up policy and records older latest work as skipped. For remotely hosted Profiles,
run the same Ziggy application core beside durable Profile storage and let a cloud adapter call it
directly. Don't split model execution from Profile state merely to claim cloud portability.

## Vertical slices

1. **Extract without behavior change.** Name `WakeSignal`, `FiringClaimStore`, and the runner
   admission function around the existing receipt claim. Make the foreground scheduler call it.
   Prove duplicate signal, gate-decline, and claim-before-gate-before-agent ordering.
2. **Local replaceability.** Replace the polling clock with an earliest-deadline timer and re-arm it
   when definitions change; keep launchd/systemd artifacts unchanged. Add a one-shot
   `ziggy automations tick` or explicit `fire --signal <json>` adapter for traditional cron and
   deterministic tests.
3. **Authenticated HTTP ingress.** Accept one signed tick or explicit firing, recalculate or claim
   it, and return durable receipt identities. Test duplicate and concurrent delivery. Do not add
   retries or an outbox.
4. **One cloud proof.** Use a coarse Cloudflare/Vercel tick or EventBridge invocation to call the
   ingress. Prove online execution, duplicate delivery, machine-offline truth, and reconnect/catch-up.
   Keep provider configuration outside the domain.
5. **Only after demand:** add a durable relay/outbox, remote Profile hosting, or provider control
   plane. Each is a separate product capability, not required for a portable scheduler boundary.

This preserves the useful part of Ziggy's shipped design: one schedule meaning, one claim point,
one exact gate position, and one runner regardless of who wakes it.
