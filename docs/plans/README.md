# Remaining plans

Completed and superseded plans are removed; use Git history to read them.

- [UI capabilities](ui-capabilities-squarey-web.md): reconcile the original scope with the current web client, add UI authoring guidance, and define a full acceptance sweep. Its original worktree/status section is historical, not current status.
- [Proactive curator](proactive-curator.md): pending/reviewed state, foreground eligibility, adoption, scheduling, and empty-reply handling remain unfinished.
- [Profile extension lifecycle](profile-extension-lifecycle.md): retain for safe runtime rollover; much of the transactional lifecycle has shipped.
- [Channel delivery](channel-delivery-idempotency.md): retain for outstanding live verification, not a new delivery subsystem.
- [Standalone executable](standalone-executable-and-source-lookup.md): reconcile its compile-all claims with current Profile-local loading and repeat clean-room release proof.

## Verification carried forward

These are missing recorded live proofs, not established implementation defects:

- Disposable Telegram owner DM and restart/backlog behavior.
- Slack/Discord real crash and redelivery replay; no exactly-once execution or delivery claim.
- Linux systemd install/start/stop/uninstall.
- ACP interoperability with Zed/Buzz.
- Standalone clean-room build and launch after package moves, including doctor, serve, resource parity, and Profile-local overrides.

Current shipped behavior belongs in `docs/operations/` and source/tests, not in completed implementation queues.
