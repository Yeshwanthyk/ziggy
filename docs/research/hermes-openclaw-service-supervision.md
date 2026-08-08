# Hermes Agent and OpenClaw service supervision

Research date: 2026-08-08. Primary sources only.

## Scope and source pins

- Hermes source installed at `/Users/yesh/.hermes/hermes-agent`, version `v0.20.0`, commit `36cb5ae5530a75def7df3195e49b7a4aa2add482`.
- Hermes upstream source at [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/36cb5ae5530a75def7df3195e49b7a4aa2add482).
- OpenClaw source and docs use official commit [`7492f6937c6144121a42632408dd7ffa01f850f1`](https://github.com/openclaw/openclaw/tree/7492f6937c6144121a42632408dd7ffa01f850f1).
- Current Ziggy evidence is from this repository; no production code was changed for this report.

The central distinction is **supervisor truth** versus **application truth**:

- Supervisor truth: launchd/systemd/Task Scheduler says a job is loaded, running, stopped, or restarting.
- Application truth: the gateway owns its scoped state, has a live process identity, and answers a bounded health/readiness probe.
- Scheduler truth is separate again: a ticker heartbeat says the scheduler loop is alive, while a run ledger says what actually ran and how delivery ended.

---

## Hermes Agent

### CLI and service backends

The gateway CLI exposes the same lifecycle verbs on macOS and Linux:

```sh
hermes gateway install [--force] [--system] [--run-as-user USER] \
  [--start-now|--no-start-now] [--start-on-login|--no-start-on-login]
hermes gateway start [--system] [--all]
hermes gateway stop [--system] [--all]
hermes gateway restart [--system] [--all]
hermes gateway status [--deep] [-l|--full] [--system]
hermes gateway uninstall [--system]
```

A named profile is selected with `hermes -p PROFILE gateway ...`; system scope generally requires `sudo`. The parser and dispatch are in the installed source at [`/Users/yesh/.hermes/hermes-agent/hermes_cli/subcommands/gateway.py:L101-L218`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/hermes_cli/subcommands/gateway.py#L101-L218).

- macOS uses a per-user launchd LaunchAgent.
- Linux uses a user systemd unit by default, or a system unit with `--system`.
- The generated service runs the gateway as `python -m hermes_cli.main [--profile PROFILE] gateway run`; macOS adds `--replace` so a service restart can take over its expected owner.

### Linux systemd

Generated unit paths are `~/.config/systemd/user/hermes-gateway[-PROFILE].service` and, for system scope, `/etc/systemd/system/hermes-gateway[-PROFILE].service`. Generation is in [`hermes_cli/gateway.py:L2837-L2967`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/hermes_cli/gateway.py#L2837-L2967).

Important generated settings:

```ini
[Unit]
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple                 # Type=notify when systemd watchdog is configured
Restart=always
RestartSec=5
RestartForceExitStatus=75  # intentional gateway restart
RestartPreventExitStatus=78 # fatal configuration
KillMode=mixed
KillSignal=SIGTERM
ExecReload=/bin/kill -USR1 $MAINPID
TimeoutStopSec=max(60, restart_drain_timeout + 30)
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target   # user unit
WantedBy=multi-user.target # system unit
```

The unit pins an absolute Python executable, `WorkingDirectory=HERMES_HOME`, and environment such as `HOME`, `USER`, `LOGNAME`, `PATH`, `VIRTUAL_ENV`, and `HERMES_HOME` (system units also set `User` and `Group`). The service manager therefore does not accidentally switch to `/root/.hermes` when an operator uses `sudo`.

Lifecycle implementation is [`hermes_cli/gateway.py:L3304-L3686`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/hermes_cli/gateway.py#L3304-L3686):

- **install** writes or refreshes the unit, runs `daemon-reload`, optionally enables it, and starts immediately by default. It prints the journal command: `journalctl --user -u hermes-gateway.service -f` or `journalctl -u hermes-gateway.service -f`.
- **start** refreshes an outdated generated unit before `systemctl [--user] start`.
- **stop** writes a planned-stop marker, then waits up to 90 seconds for drain/shutdown.
- **restart** requests a drain-aware `SIGUSR1` restart, resets failed state, and restarts; it has a forced fallback for a stuck or unavailable graceful restart.
- **status** combines `systemctl status --no-pager`/`is-active` with Hermes runtime state. `--deep` includes recent journal lines.
- **uninstall** stops, disables, removes the unit, and reloads systemd.

User services need lingering to survive logout and headless reboot: `sudo loginctl enable-linger "$USER"`. System services use `multi-user.target` and do not need user lingering ([source](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/hermes_cli/gateway.py#L2433-L2494)).

### macOS launchd

Hermes writes `~/Library/LaunchAgents/ai.hermes.gateway[-PROFILE].plist` under the real macOS account home. The plist generator is [`hermes_cli/gateway.py:L4053-L4153`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/hermes_cli/gateway.py#L4053-L4153).

Generated policy:

```xml
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>25</integer>
<key>StandardOutPath</key><string>$HERMES_HOME/logs/gateway.log</string>
<key>StandardErrorPath</key><string>$HERMES_HOME/logs/gateway.error.log</string>
```

It sets `WorkingDirectory=HERMES_HOME`, `HERMES_HOME`, `PATH`, and `VIRTUAL_ENV`; it limits load to Aqua/Background sessions. Because `KeepAlive` is unconditional, **stop must unload the job**, not merely send SIGTERM, or launchd immediately respawns it.

The lifecycle is [`hermes_cli/gateway.py:L4335-L4686`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/hermes_cli/gateway.py#L4335-L4686):

- **install** writes the plist and calls `launchctl bootstrap`; it prints `tail -f $HERMES_HOME/logs/gateway.log`.
- **start** bootstraps a missing job and uses `launchctl kickstart`.
- **stop** writes a planned-stop marker, calls `launchctl bootout`, waits for exit, and after the grace period sends SIGKILL only to the recorded gateway PID.
- **restart** asks the current gateway for a drain-aware restart through `SIGUSR1` when possible; otherwise it terminates/drains and uses `kickstart -k` (re-bootstrap if unloaded).
- **status** inspects the launchd label and PID, then combines that with Hermes runtime state. A registered plist without an actual PID is not reported as a healthy running gateway; `--deep` includes recent log lines.
- **uninstall** boots the job out and removes the plist.

### Hermes profile scope, runtime truth, and health

`HERMES_HOME` is the scope boundary for `config.yaml`, `.env`, logs, PID/lock files, runtime state, and cron state. Profile and service identity/path rules are in [`hermes_cli/gateway.py:L1754-L1842`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/hermes_cli/gateway.py#L1754-L1842) and [`hermes_constants.py:L62-L139`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/hermes_constants.py#L62-L139). Named profiles append a profile identity; arbitrary `HERMES_HOME` paths are distinguished by an eight-character hash.

The application writes:

- `$HERMES_HOME/gateway.pid`
- `$HERMES_HOME/gateway_state.json`
- `$HERMES_HOME/gateway.lock`
- `$HERMES_HOME/state/gateway.heartbeat`

`gateway_state.json` carries gateway/platform state, PID, start time, active agents, restart intent, errors, served profiles, and update time ([`gateway/status.py:L980-L1034`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/status.py#L980-L1034)). The status command uses this application state to detect a supervisor record that says “running” while the PID has disappeared.

Hermes also exposes `GET /health` and authenticated `GET /health/detailed` ([`gateway/platforms/api_server.py:L2862-L2915`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/platforms/api_server.py#L2862-L2915)). Its bounded readiness collector checks read-only SQLite state, config validity, disk pressure, model availability, gateway lifecycle state, platform counts, and queue counts. That is application readiness, not launchd/systemd state. When `gateway.systemd_watchdog_seconds > 0`, Hermes additionally emits systemd `READY=1`, periodic `WATCHDOG=1`, and `STOPPING=1`; otherwise the generated unit is `Type=simple` ([`gateway/systemd_notify.py:L17-L175`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/systemd_notify.py#L17-L175).

### Single instance, stale state, and clean shutdown

Hermes has more than a PID file:

- The runtime lock is an OS-held `fcntl` lock (Windows has a byte-lock equivalent), so abrupt process death releases ownership. PID creation uses atomic `O_CREAT|O_EXCL` ([`gateway/status.py:L688-L977`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/status.py#L688-L977)).
- Liveness combines an active runtime lock with a live PID, process start identity, and command/profile identity. A runtime-status file is only a fallback and has a 120-second freshness TTL ([`gateway/status.py:L1056-L1096`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/status.py#L1056-L1096); [`gateway/status.py:L1293-L1340`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/status.py#L1293-L1340)).
- Token-scoped locks under `$XDG_STATE_HOME/hermes/gateway-locks` use live-PID/start-time/cmdline checks and atomic stale tombstones. Unknown ownership fails conservatively rather than being deleted ([`gateway/status.py:L1350-L1490`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/status.py#L1350-L1490)).
- `gateway run --replace` requests takeover, waits, escalates to SIGKILL, and refuses to start if the old live owner cannot be displaced.

Shutdown writes a planned-stop marker so expected service stops are not treated as crashes. The gateway fences/drains active agents, flushes state, releases PID/locks, and writes `.clean_shutdown` only after a completed drain; an interrupted drain omits it so startup can recover/suspend affected work ([`gateway/run.py:L12929-L13051`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/run.py#L12929-L13051)). A restart exits `75`; fatal configuration exits `78` ([`gateway/restart.py:L8-L24`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/restart.py#L8-L24)). Systemd restarts ordinary crashes and intentional restart `75`, but suppresses `78`; launchd’s unconditional `KeepAlive` has no equivalent fatal-config suppression. A shutdown watchdog writes diagnostics and forces exit if drain hangs ([`gateway/shutdown_watchdog.py:L344-L425`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/gateway/shutdown_watchdog.py#L344-L425)).

### Cron hosted by the Hermes gateway

Hermes’s built-in `InProcessCronScheduler` is a gateway-owned, daemon-thread ticker with a historical 60-second interval; the gateway owns its stop event and lifecycle ([`cron/scheduler_provider.py:L1-L75`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/cron/scheduler_provider.py#L1-L75)). It is not a second OS service.

Cron separates three facts:

1. The ticker writes atomic heartbeat and last-success markers. A fresh ticker heartbeat can coexist with a stale last-success marker, meaning “loop alive but jobs failing” ([`cron/jobs.py:L835-L918`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/cron/jobs.py#L835-L918)).
2. A one-shot run claim has an owner and TTL; its heartbeat keeps the claim alive. Expired claims are recoverable, preventing permanent stuck ownership ([`cron/jobs.py:L1839-L1948`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/cron/jobs.py#L1839-L1948), [`cron/jobs.py:L2270-L2312`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/cron/jobs.py#L2270-L2312)).
3. The durable execution ledger is `$HERMES_HOME/cron/executions.db` ([`cron/executions.py`](https://github.com/NousResearch/hermes-agent/blob/36cb5ae5530a75def7df3195e49b7a4aa2add482/cron/executions.py)).

---

## OpenClaw

### CLI and platform mapping

The lifecycle CLI is:

```sh
openclaw gateway install
openclaw gateway status [--no-probe] [--require-rpc] [--deep] [--json]
openclaw gateway start
openclaw gateway stop [--disable] [--force]
openclaw gateway restart [--safe] [--skip-deferral] [--force] [--wait]
openclaw gateway uninstall
```

The command registration is in [`src/cli/daemon-cli/register-service-commands.ts:L65-L158`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/cli/daemon-cli/register-service-commands.ts#L65-L158). The platform registry maps macOS to LaunchAgent, Linux to a user systemd unit, and Windows to a Scheduled Task ([`src/daemon/service.ts:L338-L380`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/service.ts#L338-L380)). There is no OpenClaw macOS LaunchDaemon: it is a per-user LaunchAgent and loads with that user’s GUI/login domain ([official wizard](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/docs/reference/wizard.md#L129-L136)).

Named profiles are separate service identities: the canonical state directory is `.openclaw` or `.openclaw-PROFILE`, with profile-specific labels/task/unit names. Service management refuses to silently retarget a service whose installed state directory, config, or port differs from the current shell; reinstall/force is required. See [`src/daemon/service-env.ts:L333-L368`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/service-env.ts#L333-L368) and [gateway CLI profile guidance](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/docs/cli/gateway.md#L146-L152).

### macOS launchd

Identity is `ai.openclaw.gateway` or `ai.openclaw.PROFILE`, with plist `~/Library/LaunchAgents/<label>.plist` ([`src/daemon/constants.ts:L19-L39`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/constants.ts#L19-L39); [`src/daemon/launchd.ts:L165-L183`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/launchd.ts#L165-L183)). The renderer emits:

```xml
RunAtLoad       true
KeepAlive       true
ExitTimeOut     20
ProcessType     Interactive
ThrottleInterval 10
Umask           63 (077 octal)
ProgramArguments <node> <entrypoint> gateway --port <resolved-port>
StandardInPath  /dev/null
```

The exact renderer is [`src/daemon/launchd-plist.ts:L5-L14`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/launchd-plist.ts#L5-L14) and [`:L314-L342`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/launchd-plist.ts#L314-L342). `ThrottleInterval=10` bounds crash-loop respawn frequency.

Install writes a profile-scoped environment file at mode `0600`, uses a mode-`0700` wrapper, clears old disabled state, and bootstraps the job ([`src/daemon/launchd.ts:L65-L73`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/launchd.ts#L65-L73); [`:L1285-L1392`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/launchd.ts#L1285-L1392)). Secrets are not put in the world-readable plist. Logs are `~/Library/Logs/openclaw/gateway[-PROFILE].log` and `.err.log`; lifecycle handoffs append to `<stateDir>/logs/gateway-restart.log` ([`src/daemon/restart-logs.ts:L27-L72`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/restart-logs.ts#L27-L72)).

- **start** enables and kickstarts the label, bootstrapping if needed.
- **stop** uses `launchctl bootout`; `--disable` additionally persists disabled state across reboot/login. Plain stop unloads the current job but leaves `KeepAlive`/`RunAtLoad` policy intact for later starts/crashes.
- **restart** uses `kickstart -k`; changed definitions are booted out and bootstrapped, and an in-service caller uses a detached handoff.
- **uninstall** boots out and removes the plist.

The control implementation is [`src/daemon/launchd.ts:L1154-L1205`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/launchd.ts#L1154-L1205) and [`:L1492-L1663`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/launchd.ts#L1492-L1663).

### Linux systemd

OpenClaw generates `~/.config/systemd/user/openclaw-gateway[-PROFILE].service`. The exact unit renderer is [`src/daemon/systemd-unit.ts:L55-L104`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/systemd-unit.ts#L55-L104):

```ini
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60
Restart=always
RestartSec=5
RestartPreventExitStatus=78
TimeoutStartSec=30
TimeoutStopSec=30
SuccessExitStatus=0 143
OOMPolicy=continue
KillMode=control-group
WantedBy=default.target
```

Install runs `systemctl --user daemon-reload`, `enable`, and restart; lifecycle operations use `systemctl --user start|stop|restart` and reset failed state before start/restart ([`src/daemon/systemd.ts:L1514-L1557`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/systemd.ts#L1514-L1557); [`:L1624-L1705`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/systemd.ts#L1624-L1705)). Logs are inspected with `journalctl --user -u openclaw-gateway[-PROFILE].service -n 200 --no-pager` ([`src/daemon/runtime-hints.ts:L28-L32`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/runtime-hints.ts#L28-L32)).

The service environment pins `HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_PROFILE`, port, service identity, and a minimal `PATH`. Operator-added secrets live in `<stateDir>/gateway.systemd.env` at `0600`, referenced by an optional `EnvironmentFile`; restaging removes stale managed values ([`src/daemon/service-env.ts:L398-L462`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/service-env.ts#L398-L462); [`src/daemon/systemd.ts:L1357-L1451`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/systemd.ts#L1357-L1451)). User units need `loginctl enable-linger` for logout/reboot persistence ([official runbook](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/docs/gateway/index.md#L223-L237)).

### Windows Task Scheduler

OpenClaw does use Windows Task Scheduler, not a Windows service. It creates `OpenClaw Gateway` or `OpenClaw Gateway (PROFILE)`, normally through a hidden VBS launcher. The generated XML has a logon trigger, `MultipleInstancesPolicy=IgnoreNew`, `LeastPrivilege`, on-demand start, unlimited execution, and no battery/network restriction ([`src/daemon/schtasks-layout.ts:L104-L159`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/schtasks-layout.ts#L104-L159)).

Install uses `schtasks /Create /F /TN NAME /XML FILE`, then `/Run`; on permission/timeout failure it falls back to a per-user Startup-folder VBS/CMD login item ([`src/daemon/schtasks-install.ts:L235-L300`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/schtasks-install.ts#L235-L300)). Start uses `/Run`; stop uses `/End` and verifies process-tree termination and port release; restart does `/End`, verifies cleanup, then `/Run` ([`src/daemon/schtasks-control.ts:L268-L410`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/schtasks-control.ts#L268-L410)).

The generated XML has **no `RestartOnFailure`**. Thus logon/reboot persistence and explicit `/Run` exist, but the native Windows service definition does not itself replace a process after a crash. Inspection uses `schtasks /Query /TN "NAME" /V /FO LIST`, and logs use `<stateDir>\\logs\\gateway-restart.log` ([`src/daemon/runtime-hints.ts:L34-L38`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/runtime-hints.ts#L34-L38)).

### OpenClaw status probes and application health

`openclaw gateway status` reports the installed/loaded service and, by default, performs a non-mutating WebSocket connection and authentication-capability probe. `--no-probe` is supervisor/service-only; `--require-rpc` adds a read-scope `status` RPC; `--deep` expands channel/plugin checks. The CLI probe is [`src/cli/daemon-cli/probe.ts:L49-L109`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/cli/daemon-cli/probe.ts#L49-L109).

The service adapter does not equate “loaded” with “healthy”: it reads supervisor state and the gateway’s runtime record, returning installed/loaded/running separately ([`src/daemon/service.ts:L183-L264`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/daemon/service.ts#L183-L264)). Restart health additionally requires a running runtime and ownership of the configured port, then optionally verifies live reachability/plugin/channel probes ([`src/cli/daemon-cli/restart-health.ts:L80-L249`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/cli/daemon-cli/restart-health.ts#L80-L249)).

HTTP/application truth is separate from service truth:

- `/health` and `/healthz` are liveness routes; `/ready` and `/readyz` are readiness routes ([`src/gateway/gateway-http-route-contracts.ts:L1-L23`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/gateway/gateway-http-route-contracts.ts#L1-L23); [`src/gateway/server-http.ts:L178-L230`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/gateway/server-http.ts#L178-L230)).
- External uptime should use `GET /health`, which is immediate and does not require a session or LLM; readiness can return `503` during startup, draining, or required-channel failure ([official health docs](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/docs/gateway/health.md#L57-L68)).
- The health RPC returns a cached snapshot by default; `probe=true` forces refresh. It includes event-loop health and avoids confusing a cached snapshot with a live probe ([`src/gateway/server-methods/health.ts:L147-L208`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/gateway/server-methods/health.ts#L147-L208)).
- The periodic “heartbeat” is an agent turn owned by the automation scheduler, not a daemon liveness timer; disabling cron disables scheduled heartbeat turns ([official heartbeat docs](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/docs/gateway/heartbeat.md#L14-L20)).

### Locking, shutdown, and recovery

OpenClaw locks the canonical state directory and normally the config path. Lock payloads include PID, owner UUID, state/config paths, port, and process-start identity. Defaults are a five-second acquisition timeout, 100ms polling, and a 30-second stale threshold ([`src/infra/gateway-lock.ts:L25-L99`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/infra/gateway-lock.ts#L25-L99)). A SQLite coordinator serializes stale inspection/replacement; dead or PID-reused owners are reclaimed, while unreadable lock state fails closed. `OPENCLAW_ALLOW_MULTI_GATEWAY=1` skips only the config lock, never state ownership ([`src/infra/gateway-lock.ts:L175-L271`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/infra/gateway-lock.ts#L175-L271); [`:L359-L425`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/infra/gateway-lock.ts#L359-L425)).

A lock conflict probes the existing `/healthz`. Under systemd, a healthy existing owner exits `78`, deliberately stopping `Restart=always`; under launchd/Task Scheduler the existing owner remains in control ([`src/cli/gateway-cli/run.ts:L602-L669`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/cli/gateway-cli/run.ts#L602-L669)).

Shutdown fences new work, drains active tasks, marks interrupted sessions for recovery, closes the server, and releases locks. A timeout writes a stability bundle and exits nonzero so the supervisor can recover ([`src/cli/gateway-cli/run-loop.ts:L449-L539`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/cli/gateway-cli/run-loop.ts#L449-L539); [`:L580-L806`](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/src/cli/gateway-cli/run-loop.ts#L580-L806)). Recovery covers interrupted sessions, subagents, background work, outbound delivery, and cron; three unclean boots in five minutes suppress channel/side-service autostart until the breaker clears ([official recovery docs](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/docs/gateway/restart-recovery.md#L20-L42), [crash-loop breaker](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/docs/gateway/restart-recovery.md#L181-L207)).

### Uninstall semantics

Normal OpenClaw uninstall stops/removes the service and then removes the state directory only when explicitly requested ([official uninstall](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/docs/install/uninstall.md#L40-L60)). Manual service-only removal is:

```sh
# macOS
launchctl bootout gui/"$UID"/ai.openclaw.gateway
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# Linux
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

Windows removes the `OpenClaw Gateway` task and state-dir launcher files. Profile labels/units/tasks must be substituted as appropriate ([official uninstall cleanup](https://github.com/openclaw/openclaw/blob/7492f6937c6144121a42632408dd7ffa01f850f1/docs/install/uninstall.md#L91-L125)).

---

## Comparison with current Ziggy

Ziggy intentionally has a smaller boundary. `ziggy serve PROFILE` is one resident process; the OS service manager is the supervisor. Ziggy does not install a service, expose a daemon protocol, or create a second scheduler ([`docs/operations/serve.md:L1-L14`](../operations/serve.md)).

| Concern | Hermes | OpenClaw | Ziggy today |
|---|---|---|---|
| Supervisor | launchd or systemd | launchd, systemd user, or Windows Task Scheduler | external launchd/systemd recipe |
| Local process authority | OS lock + PID/start identity + runtime state | state/config locks + SQLite coordinator + runtime/port | `.runtime/gateway-owner.lock`, atomic hard-link, PID check |
| Status | supervisor + `gateway_state.json` + optional readiness | installed/loaded/running + WebSocket/RPC/HTTP probes | read-only owner status: running/stopped/stale |
| Scheduler truth | gateway-owned cron ticker heartbeat, success markers, execution DB | automation-owned heartbeat; separate gateway health | SQLite scheduler heartbeat/status |
| Run truth | cron execution ledger and run claims | recovery/automation/session records | SQLite automation run ledger |
| Graceful stop | planned marker, SIGUSR1 drain, watchdog, clean marker | fence/drain/recovery and supervisor handoff | scoped Effect disposal; SIGINT/SIGTERM exit 0 |
| Crash/reboot | systemd `Restart=always`; launchd KeepAlive/30s throttle; linger/login scope | systemd restart/limit; launchd KeepAlive/10s throttle; Windows logon task without crash restart | external `Restart=on-failure` / KeepAlive recipe |

Ziggy’s exact projections are documented in [`docs/operations/serve.md:L80-L98`](../operations/serve.md):

1. **Resident process state:** `ziggy serve status PROFILE` reads the owner file and checks its PID; it is read-only and reports `running`, `stopped`, or `stale`.
2. **Scheduler health:** `ziggy automations status PROFILE` reads heartbeat freshness, last tick, definitions, and next due occurrence. A fresh heartbeat is not proof that the resident process is currently alive.
3. **Run history:** `ziggy automations runs PROFILE [ID]` reads the run ledger and delivery outcomes.

The owner implementation is [`src/adapters/bun/gateway-owner.ts:L90-L149`](../../src/adapters/bun/gateway-owner.ts#L90-L149) and [`:L177-L265`](../../src/adapters/bun/gateway-owner.ts#L177-L265): it uses a temporary record, `fsync`, atomic hard-link acquisition, owner UUID matching on release, and conservative liveness (`ESRCH` is the only proof of death; unknown errors stay alive). It deliberately does not auto-delete a stale owner record.

The scheduler immediately scans, commits heartbeat and claims transactionally, then sleeps no longer than 60 seconds ([`src/application/automation-scheduler.ts:L186-L297`](../../src/application/automation-scheduler.ts#L186-L297); [`src/adapters/bun/automation-sqlite.ts:L261-L372`](../../src/adapters/bun/automation-sqlite.ts#L261-L372)). That is already the smallest useful version of Hermes/OpenClaw’s “heartbeat is not run success” distinction.

## Smallest useful Ziggy adaptations

1. **Keep the external supervisor boundary.** Do not copy Hermes/OpenClaw’s custom runtimes or implement a cross-platform service manager. If install ergonomics become necessary, add a narrow renderer for one Profile-scoped launchd plist and one systemd user unit, with absolute `ExecStart`, stable Profile identity, explicit environment, log paths, and a generated-definition fingerprint. Keep `serve status` independent of that installer.
2. **Add explicit supervisor/app fields, not a daemon protocol.** A future `serve status --json` could report `supervisor: unknown|external`, `owner: running|stopped|stale`, `pid`, `schedulerHeartbeat`, and `lastRun` separately. It should never call the scheduler or mutate stale state. A health endpoint is only worth adding when remote monitoring or an attach protocol is a real requirement.
3. **Borrow exit intent and bounded drain.** Add a small planned-stop/restart intent plus typed exit classes if Ziggy needs supervisors to distinguish operator stop, graceful restart, and crash. Preserve the current scoped shutdown; only add a deadline and process-group escalation when resident work or child processes make it necessary.
4. **Preserve conservative ownership, optionally strengthen identity.** The existing hard-link owner is safer than blindly deleting stale PID files. A later small improvement could record process start identity where the platform provides it and compare command/profile identity; unknown inspection must remain fail-closed. Do not adopt OpenClaw’s broad SQLite lock coordinator solely for this one owner.
5. **Extend scheduler claims only when needed.** If scheduled work becomes long-running, add an owner/heartbeat/TTL to the existing run ledger and recover only expired claims. Do not add an external cron tick: `ziggy serve` remains the sole scheduler owner, and scheduler heartbeat, run outcome, and process status remain distinct.

These adaptations preserve Ziggy’s current architecture: one supervised `serve`, read-only projections, Profile-local state, and no second runtime or broad service-management subsystem.
