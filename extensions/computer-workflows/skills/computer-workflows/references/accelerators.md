# Computer workflows

Use the `browser_workflow_*` path for a recurring read-only browser monitor. Use the
`workflow_record_*` path when the user teaches a semantic desktop or browser interaction.

## Saved browser jobs

Use a v1 recipe to retain the original two explicit HTTP(S) pages. Use a v2 recipe for one to fifty
explicit result sources and optional bounded pagination. Every source declares signed-in, ready,
and empty checkpoints plus CSS selectors for stable ID, title, link, and optional company. For
pagination, declare one next-control selector, a page budget, and an optional change timeout. The
runner clicks only a unique enabled match, requires changed non-empty stable IDs or the explicit
empty checkpoint, and reports a partial run when the control is ambiguous, progress stalls, or
another page exists at the budget.

A v2 recipe may visit every discovered result link within a detail-item budget. Declare exact
allowed origins, a detail-ready checkpoint, and named CSS fields. Mark fields such as description
required when their absence makes the result incomplete; leave legitimately optional fields such
as requirements optional. Each output value includes its page URL, selector, and text/list mode.
Missing optional values remain `null`; the runner does not infer fields from titles or result cards.
Set a report byte budget large enough for the expected detail corpus. Recipes accept selectors and
declarative bounds, not JavaScript or arbitrary actions.

Call `browser_workflow_save` with the complete recipe. It verifies the exact candidate through the
real browser bridge with an isolated baseline store, then promotes it only after a full pass. A
failed candidate preserves the current saved recipe and baseline. Use `browser_workflow_show` or
`browser_workflow_list` to inspect the saved artifact. A direct user request to save the recipe is
authorization to run this proof and save it.

Call `browser_workflow_run` to execute the saved recipe without model-directed steps. The run owns
one computer-use browser lease for its whole lifetime and releases only that lease. A busy managed
browser, failed checkpoint, unverified empty page, cancellation, timeout, conflicting stable ID,
incomplete pagination or detail extraction, or exhausted budget produces a failed or partial report
and preserves the prior baseline. The persisted report contains the complete extracted item set;
the tool response contains a compact summary and the report path. The first full success establishes
the baseline; later full successes identify unseen jobs and atomically extend the union of seen IDs.
A source URL, profile, checkpoint, pagination rule, or extraction change starts a new baseline after
its first full success.

Obtain real service URLs, browser profile names, and schedules from the user or demonstrated target
before saving a monitor.

## Taught semantic workflows

When the user says “save that” after a successful task, call `workflow_draft_recent` with a concise
name and goal. The extension already holds a bounded, session-local redacted capture, so recording
does not need to be armed in advance. Use `workflow_record_start` and `workflow_record_stop` when
the user asks to scope a future demonstration explicitly. Inspect the resulting draft with
`workflow_draft_show`.

Convert the draft to durable semantic targets and mandatory postconditions. Use `{{variable-id}}`
in target and checkpoint text for values that should change between runs, declare each variable as
nonsecret, and pass concrete `bindings` during verification and replay. Typed text, URLs,
credentials, tokens, OTPs, and secret variables remain manual; templates cannot contain secrets.

Call `workflow_save_prepare` with the draft, reviewed workflow, verification bindings, and a replay
mode. Use `read-only` for assertion and observation flows. Use `reversible-test` for actions only
after establishing that the verification context is isolated or safely reversible. UI labels do
not prove an action is harmless. If that boundary cannot be established, leave the candidate
staged and report that verification is unresolved rather than repeating a consequential action.

The prepare tool removes only provably redundant adjacent observations and root lookups, batches
driver segments to their supported limit, hashes the exact templated candidate, and returns the
resolved verification segments. Execute those segments exactly once through `run_ui_segment`, then
call `workflow_save` with the candidate ID. The save request itself authorizes promotion; no newer
user-turn ceremony applies. Failed, stale, mismatched, manual, or incomplete evidence preserves the
last good revision.

For replay, call `workflow_plan` with bindings for every template, execute each returned
`run_ui_segment` once, then always call `workflow_run_finish`. The driver resolves fresh semantic
state and stops on ambiguity, cancellation, unknown state, or a failed checkpoint. Text, URLs, and
secret variables remain manual.
