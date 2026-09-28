# Compiled semantic workflows

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
