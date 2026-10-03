# Remaining plans

Completed and superseded plans are removed; use Git history to read them.

- [Tight core](tight-core/README.md): target layout (§4) and Effect patterns (§5); work-order steps 1–9 are done, and the remaining old `application/`, `domain/` and `faces/` code moves one concept at a time.
- [Effect composition](effect-composition.md): thin `main.ts`, composition root, per-area CLI handlers, and the lint/skill guardrails from the 2026-09-29 main.ts review.
- [Core review](core-review.md): section-by-section tightening pass from the 2026-09-28 core review; the status line per section tracks progress.
- [UI capabilities](ui-capabilities-squarey-web.md): reconcile the original scope with the current web client, add UI authoring guidance, and define a full acceptance sweep. Its original worktree/status section is historical, not current status.
- [Proactive curator](proactive-curator.md): pending/reviewed state, foreground eligibility, adoption, scheduling, and empty-reply handling remain unfinished.
- [Profile extension lifecycle](profile-extension-lifecycle.md): retain for safe runtime rollover; much of the transactional lifecycle has shipped.
- [Channel delivery](channel-delivery-idempotency.md): retain for outstanding live verification, not a new delivery subsystem.
- [Devices](devices/README.md): Ziggy Devices — ZDP/1, the device hub, `@ziggy/device`, an ESP32 port borrowed from muse-gadget-sdk, voice; slices S0–S12 with a DAG and gates in `verify-ziggy-devices`.
- [Standalone executable](standalone-executable-and-source-lookup.md): reconcile its compile-all claims with current Profile-local loading and repeat clean-room release proof.

## Plugins later

Shipped behaviour is in [docs/operations/plugins.md](../operations/plugins.md). Not done yet:

- Host-drawn confirm and form dialogs. These would be Ziggy-only unless the MCP Apps spec adds them.
- Declarative JSON views, only if they compile to HTML.
- Per-Profile secret scoping. Secrets are shared by all Profiles for now, and that is documented.
- OAuth sign-in for MCP servers with no TUI.
- A gallery preview of a plugin that is not enabled.
- A run of a template view in the `ext-apps` reference host.

## Verification carried forward

These are missing recorded live proofs, not established implementation defects:

- Disposable Telegram owner DM and restart/backlog behavior.
- Slack/Discord real crash and redelivery replay; no exactly-once execution or delivery claim.
- Linux systemd install/start/stop/uninstall.
- ACP interoperability with Zed/Buzz.
- Standalone clean-room build and launch after package moves, including doctor, serve, resource parity, and Profile-local overrides.

Current shipped behavior belongs in `docs/operations/` and source/tests, not in completed implementation queues.
