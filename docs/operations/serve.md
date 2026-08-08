# Supervise `ziggy serve`

`ziggy serve <profile>` is the only production scheduler host. It owns the Profile's automation
scheduler and any configured Telegram, Discord, or Slack loops. Run at most one resident per
resolved Profile path.

Ziggy installs one user service per Profile and delegates restart policy to launchd on macOS or
systemd user services on Linux. It does not expose a daemon socket, public scheduler tick, or second
scheduler process.

Channel setup guides:

- [Connect a Profile to Slack](slack.md)

## Lifecycle commands

```sh
ziggy serve install <profile> [--force] [--no-start]
ziggy serve start <profile>
ziggy serve stop <profile>
ziggy serve restart <profile>
ziggy serve status <profile>
ziggy serve logs <profile> [--follow]
ziggy serve uninstall <profile>
```

`install` writes and starts the service by default. Use `--no-start` to write it without loading it
on macOS, or to write and enable it without starting it on Linux. `start` and `restart` validate the
Profile before asking the service manager to run it. `stop`, `status`, `logs`, and `uninstall` can
still identify the service from the original absolute path if the Profile has moved or disappeared.

`gateway <profile>` remains a foreground compatibility alias. Lifecycle subcommands exist only
under `serve`.

## Managed files and safety

The resolved absolute Profile path determines a bounded readable service name plus a SHA-256 path
digest. Equal folder names at different paths therefore receive different service identities.

- macOS definition: `~/Library/LaunchAgents/works.earendil.ziggy.serve.*.plist`
- macOS logs: `$ZIGGY_HOME/logs/serve/*.stdout.log` and `*.stderr.log`
- Linux definition: `~/.config/systemd/user/ziggy-serve-*.service`
- Linux logs: the user journal

Definitions contain absolute argument arrays, the Profile path, a managed marker, and a deterministic
fingerprint. They do not contain provider credentials or channel tokens. Ziggy writes definitions
atomically and refuses unmanaged, symlinked, or non-regular destinations. It also refuses a changed
managed definition unless `install --force` is explicit.

`uninstall` stops the job and removes only its recognized managed definition. It retains the
Profile, `.runtime/`, automation history, Pi sessions, and logs.

## macOS privacy

A LaunchAgent does not inherit Terminal's Files & Folders permission. If a Profile is inside a
macOS-protected folder such as `Documents`, the launched Ziggy executable must already have access
to that folder; otherwise macOS can block directory enumeration while the owner process still looks
alive. Prefer an unprotected Profile location such as `$ZIGGY_HOME/profiles`, or grant the exact
installed/compiled Ziggy executable the required access before installation. Verify scheduler
freshness after every first install rather than treating process ownership as health.

## Read combined status

```sh
ziggy serve status <profile>
```

The output intentionally keeps these facts separate:

```text
managed service: installed|not-installed|drifted|unknown
service manager: launchd|systemd|unsupported
supervisor: running|stopped|failed|unknown
process: running|stopped|stale
scheduler: active|stale|unknown
tick: ok|error|unknown
next due: ...
active runs: ...
latest run: ...
```

A loaded supervisor without a live owner is not healthy. A live owner with a stale or unknown
scheduler is also not healthy. A recently stopped process can temporarily have a fresh persisted
heartbeat; the process field remains authoritative for process liveness. Any unreadable or degraded
section makes status exit 1 while preserving the other section results. Status is read-only: it does
not create `.runtime`, initialize SQLite, repair ownership, or contact a model.

Use the detailed projections when needed:

```sh
ziggy automations status <profile>
ziggy automations runs <profile> [automation-id]
ziggy sessions list <profile>
```

## Crash and restart behavior

Resident exclusion is an OS-released SQLite lease in `.runtime/serve-owner.sqlite`. The JSON
`gateway-owner.lock` file is only a status and legacy-compatibility projection. A normal stop removes
the matching projection and releases the lease. SIGKILL may leave stale JSON, but closing the dead
process releases the authoritative SQLite lock, so the service manager can start a new owner without
manual lock deletion.

Scheduled claims store the resident owner UUID and PID. On startup, a new resident marks active
claims from an older resident UUID `unknown` with `process-start`. Their schedule cursor was already
advanced in the claim transaction, so Ziggy never replays the crashed occurrence.

## Platform notes

On macOS, Ziggy uses `launchctl bootstrap`, `bootout`, `kickstart`, and `print` in the current GUI
user domain. The generated LaunchAgent has `RunAtLoad`, `KeepAlive`, bounded restart throttling, and
a bounded exit timeout.

On Linux, Ziggy uses `systemctl --user`, writes a `Type=simple` unit with `Restart=always`, and keeps
output in the user journal. Installation warns when user lingering is not enabled and prints the
operator command, but never invokes `sudo` or enables lingering itself.

When troubleshooting, capture all three views before changing files:

```sh
ziggy serve status <profile>
ziggy serve logs <profile>
ziggy automations runs <profile>
```
