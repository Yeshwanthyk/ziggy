# Automation scheduler

## What shipped

`ziggy wake <profile> <automation-id>` reads one automation file, evaluates its gate, opens a fresh
Pi session only when admitted, prints the answer, and optionally sends it to Telegram.

- Gate exit 0 proceeds.
- Gate nonzero declines before Pi construction.
- Gate spawn failure or timeout warns and follows the existing fail-open policy.
- Every wake gets a fresh session under `sessions/automations/<id>/`.

## When to build the scheduler

Keep this deferred until automatic triggers are a concrete product requirement. Manual `wake` has
no competing dispatcher, and configured Telegram delivery already fails truthfully after printing
the local result.

Do not couple scheduling to the optional face-scoped channel lease. Choose a scheduler-specific
resident owner when this slice is accepted; that keeps Telegram, Discord, and Slack independently
runnable and avoids a Profile-wide gateway authority.

## Slice

1. Add one optional `cron:` frontmatter field and decode it with Effect `Cron`.
2. Add trigger provenance: `manual` or `schedule`, with scheduled trigger IDs equal to the firing
   instant in canonical ISO form.
3. Run one scheduler-specific resident for the Profile; do not hide scheduling inside an arbitrary
   channel gateway.
4. Store the last claimed firing instant per automation in
   `<profile>/.runtime/automation-schedule.json`.
5. Atomically persist the claim before `wake`; restart does not replay a claimed slot.
6. Prevent overlapping scheduled runs of the same automation in the resident process.

A scheduled automation without a gate is declined. Manual wake keeps its current behavior.

## Invariants

- Exactly one scheduler-specific resident process schedules a Profile.
- A due slot is claimed before model or delivery work.
- Restart never replays a claimed slot.
- A declined gate creates no Pi session.
- One slow automation does not block unrelated automation IDs.
- Existing automation files without `cron` keep working.

## Focused proof

Use a fake clock, fake agent, and temporary Profile:

1. Parse five- and six-field cron expressions; reject invalid expressions.
2. Claim one due slot, run it once, restart the scheduler, and prove no replay.
3. Decline a scheduled automation without a gate before Pi construction.
4. Prove the same automation cannot overlap while a different ID can run.
5. Prove a second scheduler owner is refused while channel residents remain independent.

Then run:

```sh
bun test
bun run check
```

## Not in this slice

- One-shot schedules.
- Run history or a job dashboard.
- Retries of model or delivery failures.
- A daemon, launch agent, or second executable.
