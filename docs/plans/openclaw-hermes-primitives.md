# Borrowed primitives without a second system

Status: proposed implementation packet, 2026-08-04.

## Orientation

Ziggy should borrow operator and ownership **invariants** from OpenClaw and Hermes-Agent, not their gateways, schedulers, stores, or control planes. The current-source audit is in
[`openclaw-hermes-current-primitives.md`](../research/openclaw-hermes-current-primitives.md).

The smallest useful sequence is:

1. expose Pi-owned session metadata through a read-only Ziggy command;
2. add a narrow, read-only Profile doctor using existing decoders;
3. add a face-scoped resident lease only if duplicate channel consumers are a real operator risk.

This order improves visibility first. It adds no provider, session, skill, memory, or transcript authority. It also avoids a Profile-wide lease, which would prevent the currently separate Telegram, Discord, and Slack residents from running together.

## Complexity budget

An `act-now` slice must satisfy all of these rules:

- no new long-running process or background fiber;
- no new durable product record, index, registry, or config format;
- no transcript parsing outside Pi and no transcript content in operator output;
- no network call, repair, migration, or secret output from diagnostic commands;
- no new dependency when an existing Pi or Effect boundary can carry the behavior.

A candidate that violates one of these rules moves to `defer` unless a concrete product requirement justifies the added authority.

## Settled decisions

| Area | Decision | Why it fits |
| --- | --- | --- |
| Sessions | **Act now.** Add `ziggy sessions <profile> [--json]`. | Pinned Pi `0.82.0` already owns and returns session metadata. Ziggy only combines leaf-directory projections. |
| Doctor | **Act next.** Add `ziggy doctor <profile> [--json]`. | It is a read-only composition of Profile-owned decoders and the session projection. |
| Duplicate residents | **Explore after visibility.** Fence `(Profile, face)`, not the whole Profile. | It prevents two copies of one channel consumer without disabling other channels or local faces. |
| Profile-wide lease | **Reject for the current process shape.** | It changes the shipped multi-channel behavior and still provides no attach path for TUI/CLI. |
| Graceful drain | **Defer.** | A correct drain changes signal handling and all three receive loops, but Ziggy has no durable interrupted-turn or recovery promise yet. |
| Automation claims | **Defer until an automatic trigger exists.** | Manual `wake` has no competing dispatcher; a claim store now would be unused durable state. |
| Skill requirements | **Keep Pi-owned.** | Ziggy already supplies ordered roots and Pi parses skills. A Ziggy metadata parser would duplicate ownership. |
| Inbound dedupe | **Keep current behavior.** | All channels already have bounded/process-local suppression or monotonic offsets. |

## Target flow

### Read-only operator path

```text
CLI
  -> application Sessions / Doctor
      -> adapters/pi SessionManager.listAll metadata
      -> existing Profile/channel/automation decoders
  -> stable text or JSON projection
```

The projection never opens an agent session, calls a model, connects a channel, changes a file, or returns transcript previews.

### Optional resident guard

```text
ziggy <channel> <profile>
  -> decode local config
  -> acquire scoped (Profile path, channel kind) SQLite lease
  -> open transport and Pi chats
  -> existing Effect scope closes chats/socket
  -> release lease last
```

The SQLite transaction is the lock. A JSON owner file, PID polling, heartbeat, stale-time policy, and daemon registry are not part of the design.

## Chunk 1 — Pi-backed session inventory

### Behavior delivered

Add:

```text
ziggy sessions <name|path>
ziggy sessions <name|path> --json
```

Text rows are newest-first and contain only:

```text
<modified-iso>  <message-count>  <session-id>  <profile-relative-jsonl-path>
```

JSON returns the same four fields plus `created`. It must not expose Pi's `firstMessage` or `allMessagesText` fields.

### Files and symbols

- `src/domain/session.ts`
  - `SessionListing` inferred from an Effect Schema;
  - typed `SessionInventoryError` carrying operation/path/message but no content.
- `src/adapters/pi/sessions.ts`
  - recursively discover directories below `<profile>/sessions` without following symlinked directories;
  - reject a leaf containing a symlinked `.jsonl` before giving that directory to Pi;
  - call `SessionManager.listAll(leafDirectory)` once for every directory containing direct regular `.jsonl` children, avoiding `list(cwd, customDir)`'s header-cwd filter;
  - immediately map Pi `SessionInfo` to the safe metadata shape;
  - compare discovered regular `.jsonl` paths with returned paths so Pi's silent metadata omission becomes a typed failure.
- `src/application/sessions.ts`
  - expose one client-neutral `list(target)` Effect;
  - normalize paths relative to the Profile and sort by modified time, then relative path.
- `src/main.ts`
  - parse only the exact optional `--json` flag;
  - print `no sessions` for an absent/empty tree;
  - render stable text or JSON.
- Focused tests beside the adapter/application code.

### Ownership and failure behavior

Pi remains the only session-format reader. Directory traversal inspects entry types and paths but does not parse content. A symlinked `.jsonl` or a regular file for which Pi cannot build metadata fails the command rather than disappearing. Missing `sessions/` is a successful empty result. Symlinked directories are not followed. Lines Pi intentionally tolerates are not reclassified by Ziggy.

### Verification

1. Root local, local-main, Telegram, Discord, Slack, and automation leaf directories each appear once.
2. A Pi-readable session appears even when its header `cwd` is empty, imported, or uses another accepted Profile spelling.
3. Rows are newest-first with a deterministic path tie-break.
4. Text and JSON contain no prompt, reply, `firstMessage`, or `allMessagesText`.
5. Missing session root prints `no sessions` and exits zero.
6. A no-header/unreadable regular `.jsonl` produces the typed metadata failure.
7. A directory symlink is ignored; a `.jsonl` file symlink fails before Pi reads the leaf.

### Risk

`SessionManager.listAll(customDirectory)` intentionally swallows files for which it cannot build metadata, while Pi also tolerates malformed non-header lines. The path comparison prevents silent metadata omissions without creating a stricter Ziggy parser. Keep the adapter pinned to documented `0.82.0` behavior and update the Pi surface note when upgrading Pi.

## Chunk 2 — narrow read-only doctor

### Behavior delivered

Add:

```text
ziggy doctor <name|path>
ziggy doctor <name|path> --json
```

Every check has a stable code, `ok | warn | error`, one evidence message, and an optional remedy. Exit nonzero when any check is `error`. Stable codes—not prose—are the JSON contract.

Initial checks:

| Code | Source | Result policy |
| --- | --- | --- |
| `profile.soul` | Explicit local `readFile` plus existing Profile path rule | missing/unreadable/non-file = error |
| `channel.telegram` | `telegram.json` existence + existing decoder | absent = ok/not configured; invalid = error |
| `channel.discord` | `discord.json` existence + existing decoder | absent = ok/not configured; invalid = error |
| `channel.slack` | `slack.json` existence + existing decoder | absent = ok/not configured; invalid = error |
| `sessions.metadata` | Chunk 1 inventory | absent/empty = ok; invalid/unreadable = error |
| `automation.<id>` | Existing automation decoder for direct `automations/*.md` | absent directory = ok; invalid definition = error |

### Files and symbols

- `src/domain/doctor.ts`
  - `DoctorSeverity`, `DoctorCheck`, and `DoctorReport` Effect Schemas;
  - data only—no check implementation.
- `src/application/doctor.ts`
  - read `SOUL.md` to prove local readability, not merely `stat` it;
  - compose checks in a fixed order;
  - catch expected typed failures into report rows;
  - defects still fail the command rather than being mislabeled healthy.
- `src/application/automations.ts`
  - expose/reuse automation reading and parsing instead of creating a second frontmatter parser.
- Existing channel application modules
  - reuse their config loaders only after a local existence check so an optional absent channel is not an error.
- `src/main.ts`
  - render text/JSON and set the exit code from the report.
- Focused tests for aggregation, redaction, order, and exit behavior.

### Explicit limits

Doctor is **not** live health. It does not call `Auth.status` (Pi auth checks may create/refresh credential files), call a provider, poll Telegram, connect Discord/Slack, validate remote credentials, execute tools, load executable extensions, test skill binaries, or repair files. It reports local Profile/config readiness only. `ziggy auth` remains the explicit provider-auth surface, and gateway startup retains live credential/network validation.

### Verification

1. A minimal readable `SOUL.md` with no optional channels exits zero with explicit not-configured rows.
2. Missing, non-file, and unreadable `SOUL.md` each produce `profile.soul` error.
3. Each invalid optional config produces one stable error without revealing a token.
4. One malformed automation is attributed by ID/path and does not hide other checks.
5. Session inventory failure is rendered once and exits nonzero.
6. Text and JSON have identical check codes, severities, and order.
7. No check creates/refreshes `auth.json`, changes Profile mtimes, or opens a network connection.

### Risk

A broad doctor becomes a second policy engine quickly. Keep every check attached to an existing owner and require a separate decision before adding network probes, repair actions, skill/package requirements, security scoring, or compatibility policy. `Profiles.listSkills` intentionally ignores malformed candidates rather than diagnosing them, so skill validation is not part of this slice.

## Chunk 3 — optional face-scoped resident lease

### Behavior delivered

Prevent two concurrent copies of the same resident face for one Profile:

```text
(Profile, telegram)  !=  (Profile, discord)  !=  (Profile, slack)
```

A duplicate exits with a typed, actionable error before channel or Pi work. Different channel faces and local TUI/`run`/`wake` remain allowed.

### Files and symbols

- `src/domain/resident.ts`
  - `ResidentKind = telegram | discord | slack`;
  - `ResidentAlreadyRunning` typed failure.
- `src/adapters/bun/resident-lease.ts`
  - create `<profile>/.runtime/resident-leases/<kind>.sqlite`;
  - hold `BEGIN IMMEDIATE` for the Effect scope;
  - map `SQLITE_BUSY` to `ResidentAlreadyRunning`;
  - rollback and close idempotently on scope release.
- `src/application/resident.ts`
  - one `withLease(target, kind, effect)` capability.
- `src/main.ts`
  - wrap each resident command after local config decode and before `runLoop`.
- Focused two-process and fake-transport tests.

### Verification

1. First same-face owner acquires; second receives `ResidentAlreadyRunning`.
2. Different faces acquire concurrently for the same Profile.
3. TUI, `run`, and `wake` are unchanged.
4. A refused duplicate performs zero transport and Pi calls.
5. Normal interruption and process death both permit the next acquire.
6. Alternate path spelling that resolves through the same Profile directory still reaches the same SQLite file; no realpath identity rule is introduced.

### Risk and gate

Do not implement this merely for parity. First reproduce or operationally confirm duplicate provider consumers. If no one runs resident channels unattended, sessions and doctor deliver more value with less lifecycle code.

## Verification matrix

| Contract | Unit | Integration | Full gate |
| --- | --- | --- | --- |
| Session metadata only | safe mapper + sort | recursive tree, cwd variants, symlink refusal | `bun test`, `bun run check` |
| Doctor is read-only and stable | report aggregation | temporary configs/automations + no auth-file creation | `bun test`, `bun run check` |
| Same-face exclusion | SQLite lease | child-process death + fake gateway | `bun test`, `bun run check` |
| Existing faces unchanged | existing gateway/application suites | current walking skeletons | `bun test`, `bun run check` |

## Rollout

Each chunk is an independent PR. Ship session inventory first and use it to prove the doctor session check. Ship doctor without any fixer. Treat the face lease as a separately accepted behavior change because it can reject a command that currently starts.

No migration is required. The first two chunks write nothing. The optional lease creates only `.runtime` coordination state; the held SQLite lock, not file contents, is authoritative.

## Residual risks

- Pi's listing API may change on upgrade; keep all `SessionInfo` handling inside `src/adapters/pi/`.
- Local channel-config checks cannot promise remote credentials are valid; output must say `configured`, not `healthy`.
- A face lease prevents duplicate consumers but does not make accepted channel work durable.
- Scoped shutdown can still interrupt an in-flight reply; that remains truthful until a delivery/recovery contract is selected.

## Work kept out

- unified daemon, attach/RPC, web control plane, or resident event bus;
- Profile-wide lease while channels are separate commands;
- custom session parser/index, transcript search, or resume picker;
- durable gateway ingress/outbound journal, replay, or receipts;
- scheduler, cron claim ledger, retries, run history, or dashboards;
- Ziggy-owned skill metadata parser, tool search bridge, or package marketplace;
- graceful-drain lifecycle state before interrupted work has a promised outcome.

## Open decisions

Only one decision gates code after the first two chunks: whether duplicate same-face resident processes are common enough to justify the lease. Session inventory and doctor do not depend on that choice.
