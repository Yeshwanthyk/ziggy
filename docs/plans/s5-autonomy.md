# S5 — Autonomy (Automation platform)

Stage owner: Automations. Depends on S2 for daemon residency and S4 for installed Skills,
Extensions, and the bundled `automation-creator` Extension. Feeds S6 the real Telegram Broadcast
target. No Merlin candidate is an S5 deliverable.

## Goal

Provide one reusable Automation platform for scheduled and webhook-triggered work with effectively
$0 idle token cost. Automation files remain the human-readable authority; the daemon strictly
validates, hot-reloads, schedules, runs, and explicitly edits them. Chat is the primary authoring
flow, but direct owner edits and lean CLI inspection remain available.

Every Run gets a fresh Session. S5 does not migrate `blogwatcher`, `gh-issues`, `lossless-claw`, or
any other candidate: `blogwatcher` is dropped, while `gh-issues` and `lossless-claw` are standalone
S4 Extensions.

## Deliverables

- A strict, versioned `<profile>/automations/<id>.md` schema and parser: YAML frontmatter plus a
  prompt or `no_agent` body. Unknown fields, invalid IDs, invalid triggers, and version mismatches
  fail loud.
- Daemon-owned validated atomic create, update, and delete operations. They are the only
  programmatic write authority and are exposed as Session Tools so the S4 `automation-creator`
  Extension can author through chat.
- Direct owner edits remain valid. The daemon watches `automations/*.md`, validates before
  replacing an active definition, and hot-reloads without restart. An invalid edit deactivates that
  Automation until a valid definition loads; the last valid parsed value may remain only for diagnostics.
- Trigger support for cron schedules and loopback webhooks. The daemon starts the HTTP listener
  only while at least one enabled webhook Automation requires it, binds only to `127.0.0.1`, and
  authenticates each hook independently.
- Wake-gate execution before Session or prompt construction. An explicit
  `{"wakeAgent": false}` result skips the Run with zero model calls.
- `no_agent` execution that performs the declared supervised work with zero model calls while
  still creating ordinary Run evidence in a fresh Session.
- One fresh Session per Run, with no carried Automation conversation. Cross-Run retained facts go
  through Memory; scheduler metadata never becomes a second Session or Memory authority.
- Broadcast rules for result/failure delivery to configured targets. S5 proves the abstraction
  against local/session targets; S6 supplies the Telegram endpoint.
- Lean CLI surfaces for `list`, `inspect`/`runs`, and `run <id> --now`. Chat-first creation and
  editing use `automation-creator`; no TUI Automation dashboard is required.

## Authoring and state authority

`automation-creator` is a default-enabled Skill-only Extension delivered in S4. It teaches the
current Automation schema and guides the agent to call daemon-owned create/update/delete Tools. It
does not parse files, run a scheduler, write Profile paths directly, or own Automation state.

The daemon validates a proposed complete document before an atomic publish. Update and delete
operations use an expected-current precondition so a chat edit cannot silently overwrite a newer
direct owner edit. The on-disk Automation file remains the sole durable definition. Scheduler
state, file-watch state, and next-fire calculations are runtime projections, not durable
authorities.

Direct filesystem edits and chat edits converge on the same parser and hot-reload path. The daemon
never maintains a shadow database or alternate Automation representation.

## Run semantics

1. A schedule, authenticated webhook, or explicit run-now request identifies one enabled
   Automation revision.
2. If configured, the wake-gate runs before Session or prompt construction. Only an explicit
   `{"wakeAgent": false}` skips agent work. True, absent or malformed output, failure, and timeout
   proceed under the ordinary Run semantics, with any gate failure recorded.
3. A proceeding trigger allocates a fresh Session and records the Automation ID, definition
   revision, trigger, and Run outcome in canonical Session evidence.
4. `no_agent` executes its supervised path without entering the model loop. Agent Automations
   construct the pinned provider/model/skills/prompt only after the wake-gate passes.
5. Broadcast routes the terminal result or failure. Partial delivery failure remains visible in
   the Run Session and does not create a second Run.

Duplicate firings for the same trigger/revision produce at most one Run. Restart and hot-reload
behavior must preserve this without adding a second durable queue authority.

## Verification growth

Extend `tests/testkit` with a virtual clock, file-watch controls, deterministic subprocess/model
counters, loopback HTTP peers, concurrent edit barriers, and fake Broadcast targets. Register:

- strict parse/version/unknown-field failures and atomic create/update/delete preconditions;
- direct-edit versus chat-edit races, invalid hot reload, and delete during an active Run;
- wake-gate skip/proceed/failure/timeout and `no_agent` zero-model-call behavior;
- duplicate schedule/webhook races, daemon restart, and one fresh Session per proceeding Run;
- loopback-only webhook startup/authentication and partial Broadcast failure.

Evidence includes file revisions and diffs, mutation outcomes, trigger/gate timelines, bind address,
model-call counts, canonical Session envelopes, and delivery receipts. A separate verifier reviews
hidden model calls, duplicate Runs, direct Extension writes, shadow authority, non-loopback ingress,
and lost updates.

## Acceptance criteria

- Schema-valid chat create/update/delete operations publish atomically through the daemon; invalid
  documents and stale expected-current revisions change no file.
- A valid direct owner edit hot-reloads without restart, while an invalid edit fails loud and
  deactivates that Automation until a valid definition loads.
- A negative wake-gate creates no Session and makes zero model calls. A proceeding trigger creates
  exactly one fresh Session distinct from prior Runs.
- A `no_agent` Run records trigger, supervised invocation, bounded output, and outcome in its fresh
  Session while making zero model calls.
- With no enabled webhook Automation, no listener exists. Enabling one binds only to
  `127.0.0.1`; only its authenticated path triggers a Run.
- Broadcast reaches every configured target or records each failed delivery in the Run Session.
- CLI list/inspection/run-now works without a separate durable index, and no TUI dashboard is
  required for S5 closure.
- The S5 manifest and scenario registry cover the platform contracts above; `verify:s5` and
  `verify:all` pass with schema-valid evidence and independent review.

## Implementation order

1. Land the strict schema/parser and red parser fixtures.
2. Add daemon-owned atomic create/update/delete with expected-current concurrency tests.
3. Add file watching and hot reload through the same parser.
4. Add scheduler, wake-gate, `no_agent`, and fresh-Session Run ownership.
5. Add conditional loopback webhook ingress, Broadcast, and the lean CLI.

## Non-goals

- Candidate migrations or bundled example Automations.
- A TUI Automation dashboard, general-purpose queue, or distributed scheduler.
- Continuing Sessions across Runs, cross-Automation DAGs, or a second durable Run store.
- Extension-owned polling, scheduling, webhook ingress, Broadcast, or direct Automation-file
  writes.
