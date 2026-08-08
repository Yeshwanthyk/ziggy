# Finish `serve` and scheduled automations

## Orientation

Ziggy can already run scheduled automations correctly while `ziggy serve` is alive. It has visible
Markdown definitions, pause and resume, wake gates, deterministic schedule claims, a durable run
ledger, fresh Pi sessions, delivery outcomes, scheduler status, and run history.

The unfinished part is resident operation. Today an operator must start `serve` in a terminal or
write an OS service by hand. A hard crash can leave the owner projection behind, and the next
`serve` refuses to start until an operator removes it. Active run ownership also relies on a PID,
which is not a full process identity.

This plan finishes the feature without adding a Ziggy daemon protocol, public tick, retry engine,
or hidden automation registry. The operating system supervises one normal `ziggy serve` process.
Ziggy adds a narrow CLI to install and control that service. A crash-safe local lease makes restart
automatic. The existing scheduler and run ledger continue to own automation correctness.

The finished operator journey is:

```text
create or edit automations/<id>.md
→ ziggy automations validate <profile> <id>
→ ziggy serve install <profile>
→ OS starts and supervises ziggy serve
→ scheduler claims due occurrences before work
→ each run gets a fresh Pi session
→ ziggy serve status <profile>
→ ziggy automations runs <profile> [id]
```

## Settled decisions

### Product boundary

- `ziggy serve <profile>` remains the only production scheduler host.
- The OS service manager supervises the process.
- Ziggy does not add a socket, attach client, HTTP health server, or second scheduler.
- There is no public `automations tick` command.
- There are no automatic run retries.
- A crashed or interrupted attempt is never replayed.
- Profile automation policy remains in `automations/<id>.md` or
  `automations/<id>.paused.md`.
- SQLite remains machine-owned schedule, claim, heartbeat, delivery, and run truth.
- Pi JSONL remains the only transcript and agent-session authority.

### Supported service managers

- macOS uses one per-Profile user LaunchAgent.
- Linux uses one per-Profile systemd user unit.
- Windows service installation is out of scope.
- Linux system scope and automatic `loginctl enable-linger` are out of scope.
- Install warns when user lingering may be required. It never invokes `sudo`.

### CLI

```text
ziggy serve <profile>                         foreground process
ziggy serve install <profile> [--force] [--no-start]
ziggy serve start <profile>
ziggy serve stop <profile>
ziggy serve restart <profile>
ziggy serve status <profile>
ziggy serve logs <profile> [--follow]
ziggy serve uninstall <profile>
```

- `install` writes, enables, and starts the user service by default.
- `--no-start` writes and enables it without starting it.
- `--force` may replace only a changed Ziggy-managed definition. A non-Ziggy, symlinked, or
  non-regular destination is never overwritten.
- On macOS, `--no-start` writes the plist but does not call `launchctl bootstrap`; a later `start`
  bootstraps it. On Linux, it writes and enables the unit without calling `systemctl start`.
- `uninstall` stops and removes only the managed service definition.
- `uninstall` never removes the Profile, automation database, sessions, logs, or human files.
- The `gateway` compatibility alias remains foreground-only. It does not gain service lifecycle
  commands.
- Guided `init` does not install a service in this slice.

### Service identity and files

- Service identity derives from the resolved absolute Profile path, not only its folder name.
- The machine-safe identity contains a bounded readable name and a truncated SHA-256 path digest.
- The digest prevents collisions between equal folder names at different paths.
- The generated definition records its Ziggy service identity, Profile path, launch command, and
  definition fingerprint.
- No credential or token enters a plist, unit, process argument, or generated environment file.
- macOS logs go to a Profile-keyed location under the Ziggy home.
- Linux logs stay in the user journal.
- The service definition is the only install authority. Ziggy adds no service registry.

### Crash and run recovery

- Resident ownership uses an OS-released lock held through one scoped SQLite write transaction in a
  dedicated `.runtime/serve-owner.sqlite` database.
- Lease acquisition uses nested scoped resources in this order: open database, begin immediate
  transaction, publish owner projection. Finalizers run in reverse order: remove the matching
  projection, roll back the transaction, close the database. Rollback and close run even when
  publication or projection cleanup fails.
- The current JSON owner file remains a read-only status projection for current code. It never
  grants current ownership. During the version-1 transition it is also a compatibility barrier:
  a live legacy record blocks a new lease, and the new lease publishes its live record before
  migration so a legacy binary cannot start beside it.
- A process crash releases the SQLite lock automatically.
- The next process that acquires the SQLite lock may replace a stale JSON owner projection.
- A live owner keeps the database lock for its full scoped lifetime.
- Every scheduled claim stores the current resident owner UUID as well as its PID.
- After a new resident acquires the lease, its startup recovery changes active scheduled runs owned
  by an older resident UUID to terminal `unknown` with reason `process-start`.
- Only resident startup may fence old resident claims. A manual command never infers that another
  resident UUID is stale.
- Manual wake runs use a process-local UUID and PID. A separate conservative recovery operation may
  mark only dead manual owners `unknown`.
- Recovery does not replay an old occurrence.
- Unknown PID inspection remains fail-closed.

### Shutdown

- `stop` and `restart` act through launchd or systemd. They do not contact a Ziggy daemon.
- SIGINT and SIGTERM close admission by interrupting the resident Effect scope.
- Scoped workers receive interruption and attempt the existing terminal `interrupted` commit.
- Channel loops close before resident ownership is released.
- Service definitions provide a bounded OS stop timeout. The OS may force-kill a stuck process.
- A force-killed active run becomes `unknown` on the next resident start.

## Scope

This plan includes:

- crash-safe resident ownership;
- resident owner identity in scheduled run claims;
- one explicit and exclusively authorized automation database migration;
- macOS LaunchAgent rendering and lifecycle control;
- Linux systemd user-unit rendering and lifecycle control;
- install, start, stop, restart, status, logs, and uninstall commands;
- combined read-only serve status;
- clean-stop and hard-crash proofs;
- one real scheduled Luna/high proof in the retained dump workspace.

This plan excludes:

- gateway routing or channel setup changes;
- external delivery as a finish criterion;
- Windows service management;
- system-level services;
- remote health endpoints;
- a daemon attach protocol;
- public tick, replay, retry, or repair commands;
- an automation editor or remove command;
- output storage outside Pi sessions;
- service installation from `ziggy init`;
- background agent trees.

## Authoritative state

| Fact | Authority | Projection or display |
| --- | --- | --- |
| Automation prompt, schedule, gate, delivery, lifecycle | Profile Markdown filename and body | Parsed runtime value; scheduler definition row |
| Next schedule cursor and consumed occurrence | `.runtime/automation-scheduler.sqlite` | `automations status` |
| Run and delivery outcome | `.runtime/automation-scheduler.sqlite` | `automations runs` and serve summary |
| Model transcript and tool history | Pi JSONL | `sessions list/show` metadata only |
| Live resident exclusion | Scoped SQLite lock in `.runtime/serve-owner.sqlite` | JSON owner projection |
| Installed service definition | LaunchAgent plist or systemd user unit | `serve status` managed-definition fields |
| Process restart policy | launchd or systemd | `serve status` supervisor fields |
| Scheduler freshness | Scheduler heartbeat row | `automations status` and serve summary |

The owner JSON file cannot grant ownership. A fresh heartbeat cannot prove process ownership. A
running service cannot prove a healthy scheduler. A completed model run cannot prove successful
delivery.

## State transitions

### Resident lifecycle

```text
not-installed
  └─ install ─→ installed/stopped or installed/running

installed/stopped
  └─ start ─→ supervisor-starting ─→ lease-held/running

lease-held/running
  ├─ clean stop ─→ interrupt workers ─→ release owner projection ─→ release SQLite lock
  ├─ restart ─→ clean stop ─→ new process and new owner UUID
  └─ hard crash ─→ OS releases SQLite lock; JSON may remain stale

stale JSON with released SQLite lock
  └─ supervised start ─→ acquire SQLite lock ─→ replace stale JSON ─→ running

installed/*
  └─ uninstall ─→ stopped ─→ definition removed; Profile state retained
```

### Scheduled run lifecycle

```text
due cursor
  └─ transaction: advance cursor + insert claimed(owner UUID, PID)
      └─ worker registration
          └─ running
              ├─ completed
              ├─ failed
              ├─ skipped-gate
              ├─ interrupted
              └─ process crash → next owner marks unknown
```

Terminal states never transition. No recovery path returns a run to `claimed` or `running`.

## Required invariants

1. At most one process holds the resident lease for one resolved Profile path.
2. A hard process exit releases the authoritative lease without filesystem cleanup.
3. The owner JSON projection never grants current ownership. During version-1 migration it remains
   the required legacy exclusion barrier.
4. A new lease refuses migration while a valid legacy owner PID is alive.
5. The new lease publishes its owner projection before migration, so a legacy resident start fails.
6. The owner projection names the same owner UUID as the process holding the lease.
7. Service identity is stable for one resolved Profile path and distinct for different paths.
8. Install never writes secrets.
9. Install never overwrites a changed managed definition without `--force`.
10. Read-only status never creates `.runtime`, a database, a service file, or a scheduler heartbeat.
11. A scheduled occurrence is claimed and its cursor advances in one transaction before gate, Pi,
   print, or delivery work.
12. A scheduled worker can start or finish only the run claimed by its resident owner UUID.
13. A manual process cannot recover, fence, start, or finish a resident-owned claim.
14. A new resident marks old active scheduled claims `unknown` before admitting later work.
15. An `unknown` run is never replayed.
16. Pause prevents later admission but does not cancel work already claimed.
17. A normal stop records interruption when the database remains writable.
18. A forced stop leaves ambiguity that startup records as `unknown`.
19. Supervisor state, owner state, scheduler freshness, and run outcome remain separate fields.
20. Only a process holding the full resident exclusion can change the automation database schema.
21. The migration transaction checks version-1 active owners while holding the database write lock.
22. A live version-1 resident or manual writer is never migrated underneath its work.

## Target production paths

### Service install

```text
CLI decode
→ resolve and validate Profile
→ resolve stable Ziggy launch command
→ derive Profile-scoped service identity
→ render platform definition
→ inspect existing definition
→ refuse drift or atomically write managed definition
→ on macOS: bootstrap only when starting
→ on Linux: daemon-reload and enable; start unless --no-start
→ wait for bounded supervisor and owner observations
→ print identity, definition path, process state, and logs command
```

### Supervised start after a hard crash

```text
launchd/systemd starts ziggy serve <absolute-profile>
→ validate Profile and present channel configs
→ acquire scoped SQLite resident lock
→ inspect legacy/current owner JSON projection
→ if its PID is live, release SQLite lock and refuse coexistence
→ otherwise replace stale projection and publish new owner UUID/PID/acquired time
→ while both barriers are held, exclusively initialize or migrate automation database
→ mark active scheduled runs from older owner UUID unknown
→ reconcile definitions and missed ranges
→ start scheduler and configured channel loops
```

### Read-only status

```text
resolve Profile
→ inspect managed definition without writing
→ query launchd/systemd without changing it
→ inspect owner JSON and PID without repairing it
→ read scheduler projection without creating SQLite
→ read latest run projection without recovery
→ render separate managed-service, supervisor, process, scheduler, and run fields
→ return exit 1 when any present section is unreadable while preserving the other section results
```

## Implementation chunks

### Chunk 1 — Prove and introduce the crash-safe resident lease

**Behavior delivered**

A hard-killed foreground `serve` can start again without manual deletion. Two concurrent starts
still admit exactly one owner.

**Files and symbols**

- Change `src/adapters/bun/gateway-owner.ts`.
- Extend `GatewayOwnerHandle` with PID and acquisition time if needed by later chunks.
- Keep `inspectGatewayOwner` read-only.
- Update `src/domain/gateway.ts` only for typed lease or projection failures.
- Extend `src/adapters/bun/gateway-owner.test.ts`.
- Extend the subprocess proofs in `src/application/resident-gateway.test.ts`.

**Boundary change**

`acquireGatewayOwner` is a nested scoped acquisition. It opens `.runtime/serve-owner.sqlite` and
registers close, begins an immediate write transaction and registers unconditional rollback, then
inspects `gateway-owner.lock`. A valid live PID, including a version-1 owner, blocks acquisition.
Otherwise it publishes the new projection and registers matching-projection cleanup. Publishing
before any automation migration prevents a legacy resident from acquiring its hard-link owner.
Only the SQLite lock holder may publish or replace a stale projection. The existing resident
application ordering remains unchanged: scheduler and channel finalizers run before the owner
finalizers.

**Proof**

- A second process fails while the first holds the SQLite lock.
- A new binary refuses a live version-1 owner record.
- A version-1 binary refuses the live projection published by a new lease holder.
- SIGTERM releases both the projection and lock.
- SIGKILL leaves a stale projection but releases the SQLite lock.
- The next process replaces the stale projection and starts.
- Two simultaneous post-crash contenders produce one winner.
- `serve status` against a never-started Profile creates nothing.

**Risk**

A lifetime SQLite write transaction is the one new mechanism. Prove its cross-process behavior in
a focused disposable subprocess test before replacing the current lease.

### Chunk 2 — Fence scheduled runs with resident owner identity

**Behavior delivered**

A restarted resident can identify its own scheduled workers even if a PID is reused. Old active
scheduled runs become `unknown` once and never block the automation forever.

**Files and symbols**

- Change schemas and identities in `src/domain/automation.ts`.
- Change `SCHEMA`, `RunRow`, `commitScheduleTick`, `recoverAutomationRuns`, and
  `makeAutomationRunStore` in `src/adapters/bun/automation-sqlite.ts`.
- Pass `GatewayOwnerHandle.ownerId` from `src/application/resident-gateway.ts` into
  `AutomationScheduler.run`.
- Change scheduled dispatch in `src/application/automation-scheduler.ts`.
- Change scheduled start/finish ownership in `src/application/automations.ts`.
- Update focused database, scheduler, automation, and resident tests.

**State change**

Add `owner_id` and `owner_kind` to active run rows. `owner_kind` is `resident` or `manual`.
Terminal rows clear both owner fields. Split recovery into explicit operations:

- resident startup fences active `resident` rows whose owner UUID differs from the current lease;
- ordinary scheduler scans may recover only dead `manual` rows by conservative PID inspection;
- manual wake admission may recover only dead `manual` rows and never touches resident rows.

Carry identity explicitly through `GatewayOwnerHandle → AutomationSchedulerShape.run →
commitScheduleTick → scheduled AutomationTrigger → AutomationRunStore.start/finish`.

**Migration**

Bump the scheduler database to version 2. Implement only a checked version-1 to version-2
migration. The resident lease holder is the normal migration authority. It holds both the new
SQLite lease and the published legacy-compatible owner projection for the whole schema
transaction.

A manual wake that encounters version 1 must temporarily acquire that same full resident
exclusion. It then begins the automation database write transaction and checks active version-1
owner PIDs inside that transaction. If a live version-1 writer exists, it rolls back, releases the
temporary resident exclusion, and fails with a typed upgrade-required message. If none exists, it
migrates, commits, releases the temporary resident exclusion, and then performs normal version-2
manual admission. A concurrent legacy manual writer either commits before the migration lock and
is observed, or waits and then fails closed on version 2.

Preserve terminal rows and delivery outcomes. Convert only dead version-1 active rows to
`unknown/process-start`, because their full owner identity is unavailable. Refuse all other unknown
versions and schema shapes. An old process that encounters version 2 fails closed; service upgrade
must stop the old resident before the new process starts.

**Proof**

- A live version-1 resident blocks new lease acquisition and migration.
- A temporary manual migrator holds resident exclusion through the schema commit.
- A version-1 manual writer that wins the database race blocks migration; one that loses fails on
  version 2 without corrupting it.
- A new resident UUID recovers old active scheduled claims even when the PID is reported alive.
- The current resident does not recover its own active workers.
- Manual recovery never changes resident-owned rows.
- A live manual wake remains active while `serve` starts.
- A dead manual owner becomes unknown.
- Version-1 terminal history survives migration byte-for-value.
- Dead version-1 active rows migrate to unknown without replay; live version-1 writers block migration.

**Risk**

This is the only persistent schema change. Land it before service installation so supervised
restart never meets ambiguous old claims.

### Chunk 3 — Render managed service definitions

**Behavior delivered**

Ziggy can derive and inspect one visible OS service definition for one Profile without starting it.

**Files and symbols**

- Add `src/domain/resident-service.ts` for service identity, launch vector, definition state, and
  typed failures.
- Add `src/adapters/bun/resident-service.ts` for platform detection, filesystem operations, and
  subprocess calls.
- Add pure renderers under `src/adapters/bun/launchd-service.ts` and
  `src/adapters/bun/systemd-service.ts`, or equivalent focused modules.
- Add `src/application/resident-service.ts` for install and lifecycle orchestration.
- Add focused renderer and adapter tests.

**Definition policy**

- Build the launch vector in `src/main.ts` from the actual runtime entrypoint. In source mode it is
  `[realpath(process.execPath), realpath(Bun.main)]`; in a compiled build it is the compiled Ziggy
  executable alone. Append `serve` and the absolute Profile path as separate arguments. Reject an
  entrypoint that cannot be resolved to stable regular files.
- Use absolute launch and Profile paths.
- Use `RunAtLoad`, `KeepAlive`, and a bounded throttle on macOS.
- Use `Restart=always`, restart throttling, a bounded stop timeout, and a user target on Linux.
- Pin `HOME`, Ziggy home, and a minimal stable `PATH` only when required.
- Put no auth or gateway token in generated definitions.
- Write atomically.
- Mark generated content and fingerprint it.
- Refuse every non-Ziggy, symlinked, or non-regular destination. `--force` applies only to a
  recognized Ziggy-managed definition whose fingerprint drifted.

**Proof**

- Stable Profile path produces stable identity and exact deterministic output.
- Different equal-named paths produce different identities.
- Rendered arguments preserve spaces and special characters without shell interpolation.
- Reinstall is idempotent.
- Drift refuses without `--force`.
- Symlinked or non-regular destination files fail closed.
- No fixture secret appears in output.

### Chunk 4 — Add install and lifecycle CLI commands

**Behavior delivered**

An operator can install, start, stop, restart, inspect logs, and uninstall the resident service
without learning launchctl or systemctl commands.

**Files and symbols**

- Extend `CliCommand` in `src/domain/cli.ts`.
- Extend parsing and help in `src/faces/cli.ts`.
- Add stable rendering in `src/faces/serve-cli.ts`.
- Wire `ResidentService` through `src/main.ts` and its Layers.
- Add application, parser, renderer, and subprocess tests.

**Lifecycle contracts**

- Platform operations use argument arrays. They never invoke a shell.
- Install, start, and restart require a valid initialized Profile. Stop, status, logs, and uninstall
  require only the resolved target path so an operator can clean up a moved or deleted Profile.
- Every Promise-returning subprocess operation is wrapped once at the Bun adapter boundary.
- Start waits for bounded supervisor and owner observations.
- Stop waits for the supervisor to stop, then reports owner state honestly.
- Restart proves a new owner observation or reports that readiness was not reached.
- Logs uses `journalctl --user` on Linux and the generated log paths on macOS.
- Replace `src/main.ts` raw `serve != status` teardown detection with an exact foreground-command
  predicate. Service lifecycle subcommands use normal CLI teardown.
- Uninstall is idempotent and preserves Profile state.

**Proof**

Use fake platform command runners for deterministic command and failure tests. Add one guarded live
platform test that installs only a disposable test Profile service and always uninstalls it in a
finalizer.

### Chunk 5 — Make `serve status` the combined read-only entry point

**Behavior delivered**

One command answers whether the managed service exists, whether the supervisor runs it, whether a
resident owns the Profile, whether the scheduler is fresh, and what the latest run did.

**Stable field groups**

```text
profile: ...
managed service: installed|not-installed|drifted|unknown
service manager: launchd|systemd|unsupported
supervisor: running|stopped|failed|unknown
process: running|stopped|stale
pid: ...
acquired at: ...
scheduler: active|stale|unknown
tick: ok|error|unknown
next due: ...
active runs: ...
latest run: ...
```

**Files and symbols**

- Compose `ResidentService.status`, `ResidentGateway.status`, and
  `AutomationScheduler.status` in the application layer as independent `Result` values.
- Keep filesystem and supervisor queries in their adapters.
- Extend `renderServeStatus` in `src/faces/serve-cli.ts`.
- Keep `automations status` and `automations runs` as the detailed automation projections.

**Proof**

- Every combination preserves separate facts.
- An unreadable owner, service definition, supervisor response, or scheduler database renders that
  section `unknown` with a bounded reason, preserves all other sections, and makes status exit 1.
- A loaded service with no owner is not called healthy.
- A running owner with a stale scheduler is shown as disagreement.
- A stopped process with a fresh old heartbeat remains stopped.
- Missing scheduler storage renders unknown and creates nothing.
- Status does not repair stale state or contact a model.

### Chunk 6 — Prove clean stop, hard crash, and automatic return

**Behavior delivered**

The full service can survive ordinary control and process failure while preserving honest run and
session history.

**Automated scenarios**

1. Install without start and prove macOS did not bootstrap or Linux did not start the unit, then
   start and observe owner plus heartbeat.
2. Stop with no active run and prove exit zero, closed channels, released owner, and stopped
   supervisor.
3. Stop during a scheduled run and prove terminal `failed/interrupted` when the terminal write
   succeeds.
4. SIGKILL during a scheduled run and prove supervisor restart, new owner UUID, old run `unknown`,
   and no replay of its occurrence.
5. Restart and prove a new process plus continued future scheduling.
6. Pause an automation while serve stays resident and prove no later admission.
7. Resume and prove the cursor starts at a fresh future occurrence.
8. Uninstall and prove service artifacts disappear while Profile and runtime history remain.

**Files**

- Add a focused subprocess/service integration test under `src/application/` or `tooling/`.
- Update `docs/operations/serve.md` and `docs/operations/automations.md`.
- Update `LOG.md`.

**Risk**

Live OS service tests can leave artifacts after a test-runner crash. Use a unique Profile digest,
pre-test cleanup, Effect finalizers, and a documented manual cleanup command.

## Verification matrix

| Contract | Unit or boundary proof | Integration proof | Live proof |
| --- | --- | --- | --- |
| One resident owner | competing SQLite lock processes | two concurrent `serve` starts | managed service plus rejected foreground duplicate |
| Hard-crash recovery | SIGKILL lock-holder test | restart with stale JSON | service manager restarts automatically |
| No scheduled replay | owner-UUID recovery test | killed active run becomes unknown | exact run IDs before and after restart |
| Run session durability | existing Pi session tests | scheduled run session path | Luna/high root JSONL under automation path |
| Pause/resume | existing transition and scheduler tests | resident remains up during change | no paused run; fresh future run after resume |
| Service definition safety | exact renderer and drift tests | install/reinstall/uninstall | visible plist or unit inspection |
| Read-only status | before/after tree snapshots | mixed-state projections | service/process/scheduler/run comparison |
| Clean shutdown | scoped finalizer order | SIGTERM active and idle | stop command returns stopped state |
| Profile preservation | uninstall boundary test | state hash before and after | Profile Markdown and sessions retained |

Every implementation chunk runs its focused tests and `bun run check`. The final chunk runs
`bun test` and the helper suite. No chunk is complete with a failing relevant check.

## Rollout

1. Land the crash-safe resident lease before exposing service installation.
2. Land owner-fenced scheduled claims and the version-1 to version-2 migration next.
3. Land pure service renderers before executing launchctl or systemctl.
4. Ship lifecycle commands with status and logs in the same operator slice.
5. Update operations docs before the first live install.
6. Run the final macOS proof in a fresh retained directory under
   `/Users/yesh/Documents/personal/dump/ziggy-core-parity/serve-automation-finish/`.
7. Use the authorized `openai-codex/gpt-5.6-luna` model with high reasoning for one scheduled
   model-backed run.
8. Schedule the proof at least two minutes ahead.
9. Retain commands, service definition, timestamps, status output, run rows, and session metadata.
10. Uninstall the disposable service after proof while retaining the Profile evidence.

## Residual risks

- A Linux user service does not survive logout or reboot without user lingering. Ziggy warns and
  prints the exact operator command but does not use `sudo`.
- A macOS LaunchAgent starts only in the user's login domain. It is not a system LaunchDaemon.
- Persistent invalid configuration can cause throttled restart attempts. Status and logs must make
  this visible. Fatal-exit classification can be added later if the restart loop becomes a real
  operator problem.
- Moving or deleting the Ziggy executable makes the generated definition drift or fail. Reinstall
  refreshes its absolute launch path.
- Manual wake ownership still uses conservative PID liveness. Resident scheduled runs receive the
  stronger owner UUID guarantee in this milestone.
- SIGKILL can lose the last in-memory output. The run becomes `unknown`; Ziggy does not infer
  success or replay it.

## Open decisions and deferred work

No decision blocks the six chunks above.

The following decisions stay deferred until a concrete workflow needs them:

- whether guided init should offer service installation;
- whether Ziggy needs JSON status output;
- whether Linux system services or Windows services are required;
- whether fatal configuration needs a dedicated no-restart exit class;
- whether long manual wakes need process-start identity beyond PID;
- whether remote health or an attach protocol is needed;
- whether any failed delivery should ever be retried.
