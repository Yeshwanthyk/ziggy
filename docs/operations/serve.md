# Supervise `ziggy serve`

Run exactly one resident process per Profile:

```sh
ziggy serve /ABSOLUTE/PATH/TO/PROFILE
```

That existing command owns the Profile's scheduler and configured channel loops. Use the operating
system's service manager to keep it resident. Ziggy does not install a service, expose a daemon
protocol, or provide a second scheduler.

Use absolute paths in service definitions. Replace every placeholder below and create log
directories yourself before loading the service.

## launchd (macOS)

Save this as `~/Library/LaunchAgents/com.example.ziggy.PROFILE.plist` for a user service. Use a
unique label and one plist per Profile.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.ziggy.PROFILE</string>

  <key>ProgramArguments</key>
  <array>
    <string>/ABSOLUTE/PATH/TO/ziggy</string>
    <string>serve</string>
    <string>/ABSOLUTE/PATH/TO/PROFILE</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>

  <key>StandardOutPath</key>
  <string>/ABSOLUTE/PATH/TO/LOGS/ziggy-PROFILE.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/ABSOLUTE/PATH/TO/LOGS/ziggy-PROFILE.stderr.log</string>
</dict>
</plist>
```

Load and unload it with the `launchctl bootstrap` and `launchctl bootout` commands appropriate to
your user domain. Unload the job when you intend the process to remain stopped; `KeepAlive` will
otherwise restart it.

## systemd (Linux)

Save this as `~/.config/systemd/user/ziggy-PROFILE.service` for a user service. Use one unit per
Profile.

```ini
[Unit]
Description=Ziggy resident owner for PROFILE
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/ABSOLUTE/PATH/TO/ziggy serve /ABSOLUTE/PATH/TO/PROFILE
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
```

After replacing placeholders, use `systemctl --user daemon-reload`, then manage the unit with
`systemctl --user enable --now ziggy-PROFILE.service`, `status`, `restart`, and `stop`. Ziggy itself
does not run these commands or write this unit.

## Three separate operational facts

Do not use one projection as a substitute for another:

1. **Resident process state** — `ziggy serve status /ABSOLUTE/PATH/TO/PROFILE` reads the owner file
   and checks its PID. It reports `running`, `stopped`, or `stale`, plus the owner path and the PID
   and acquisition time when a record exists. The command is read-only: it does not create
   `.runtime`, acquire ownership, remove a stale record, or contact a daemon. `stale` means the
   record is valid but its PID is dead; confirm the process is stopped before removing that lock.
2. **Scheduler health** — `ziggy automations status /ABSOLUTE/PATH/TO/PROFILE` projects the persisted
   heartbeat freshness, last tick, definitions, and next due occurrence. A recently stopped serve
   process can temporarily coexist with `scheduler: active` because the last heartbeat remains
   fresh. This is expected and is not process-liveness proof.
3. **Run history** — `ziggy automations runs /ABSOLUTE/PATH/TO/PROFILE [automation-id]` projects the
   persisted run ledger and delivery outcomes. It is the truth for what ran, failed, or was
   skipped; neither process status nor heartbeat freshness answers that question.

The service manager supervises the single `ziggy serve` process. Do not add a cron-triggered tick,
a second scheduler unit, or multiple resident jobs for the same Profile.
