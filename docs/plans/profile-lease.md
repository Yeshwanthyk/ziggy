# Profile lease

## Why this is next

Telegram, Discord, and Slack can currently run as separate resident processes for the same
Profile. Local TUI and `run` can also open while a gateway is resident. Their session files are
separate, but they share Profile policy, memory, auth, and runtime state.

The next code slice is one Profile-scoped resident lease. It is an ownership guard, not an attach
protocol.

## Slice

Use a stable SQLite lock at `<profile>/.runtime/gateway-lease.sqlite`.

1. Add a `ProfileLease` Effect service backed by `BEGIN IMMEDIATE`.
2. Hold the database connection for the resident scope. Rollback and close on shutdown; process
   death releases the OS lock automatically.
3. Write diagnostic owner metadata to `<profile>/.runtime/gateway-owner.json` after acquisition.
   Ownership comes from the SQLite lock, never from the metadata file.
4. Telegram, Discord, and Slack acquire before any network call or Pi runtime construction.
5. TUI and `run` probe the lease and refuse while held unless `--force` is explicit.
6. `wake` remains allowed because it uses a fresh session and serialized memory writes.

The owner metadata contains the gateway kind, PID, and acquisition time. A stale metadata file is
cleaned only after Ziggy proves the SQLite lease is free.

## Invariants

- At most one resident gateway owns a Profile.
- A refused gateway performs zero channel and Pi work.
- Normal interruption and process death both release ownership.
- `--force` never removes or changes the resident lease.
- A missing or stale metadata file cannot create or revoke ownership.
- Telegram, Discord, and Slack use the same lease path and service.

## Focused proof

Tests should use fake gateway transports and a temporary Profile:

1. Hold the lease; a second hold gets a typed `ProfileLeaseHeld` failure.
2. Close the holder; the next hold succeeds.
3. Kill a child holder; the next hold succeeds without deleting a lock file.
4. Start each gateway while held; assert zero transport and Pi calls.
5. Guard TUI and `run`; assert refusal without `--force` and one warning with it.
6. Confirm `wake` is unchanged.

Then run:

```sh
bun test
bun run check
```

## Not in this slice

- Attaching local faces to the resident process.
- Multiple resident channels for one Profile.
- Session migration or RPC.
- Heartbeats or time-based stale takeover.
