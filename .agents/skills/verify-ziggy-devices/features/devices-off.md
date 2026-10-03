# Devices off

With no `devices.json`, a Profile's resident exposes nothing to the network beyond loopback.

## Behaviors

- **D0.1** No `devices.json` → the resident's only TCP listener is the web UI on `127.0.0.1`.
- **D0.2** Doctor reports no device configuration and stays all `OK`.

## User entry points

- `ziggy serve <profile>` (foreground).
- The installed resident (`ziggy resident start`) runs the same `serve`; not driven here.

## Drive

1. Launch the sandbox (SKILL.md Launch step 1). Do **not** write `devices.json`.
2. Doctor: every line `OK`.
3. Start the resident (Launch step 3).
4. `lsof -nP -a -p "$RESIDENT" -iTCP -sTCP:LISTEN > "$EVIDENCE/listeners.txt"`.
   Expect exactly one `LISTEN` row, `127.0.0.1:<port>`, and that port equals `port` in
   `$PROFILE/.runtime/ui-server.json`.
5. Cleanup.

## Proof

`$EVIDENCE/doctor.out`, `$EVIDENCE/listeners.txt`, and the `ui-server.json` port (token
redacted). After cleanup: the lock is gone and no owned process remains.

Last green run: 2026-10-03 on branch `devices-plan`, before S2, following SKILL.md verbatim.
Evidence `/tmp/ziggy-devices-proof/20261003-130607/`: doctor 0 non-OK lines; one listener
`127.0.0.1:51670` equal to `ui-server.json`'s port; resident exit 0; lock gone; no process left.

## Gotchas

- Run `lsof` against the resident's pid, not a port number. The model server from the sandbox
  also listens on loopback and is not the resident's.
- After S2 lands, this feature must still pass: R0 is a regression guard, not a temporary state.
