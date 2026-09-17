---
name: computer-workflows
description: Save and run fixed read-only browser jobs or teach reviewed semantic computer-use workflows.
---

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

Call `browser_workflow_save` with the complete recipe, then use `browser_workflow_show` or
`browser_workflow_list` to verify the saved artifact. A direct user request to save the recipe is
authorization to save it; no separate publication prompt applies.

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

1. Call `workflow_record_start` with a concise name and goal.
2. Complete the task once with computer-use tools.
3. Call `workflow_record_stop`, including after a recoverable mistake, then inspect the redacted
   draft with `workflow_draft_show`.
4. Convert the draft to durable semantic targets and mandatory postconditions. Keep typed text,
   URLs, credentials, tokens, OTPs, and other sensitive values in declared variables rather than
   recorded steps.
5. Call `workflow_save_prepare` and show the returned workflow exactly. A newer explicit user turn
   must approve that prepared workflow before `workflow_save`.

For replay, call `workflow_plan`, execute each returned `run_ui_segment` once, then always call
`workflow_run_finish`. The driver resolves fresh semantic state and stops on ambiguity,
cancellation, unknown state, or a failed checkpoint. Text and secret variables remain manual.
