---
name: computer-workflows
description: Teach, review, publish, and replay semantic computer-use workflows without storing transient refs or secret values.
---

# Computer workflows

Use this skill only with the `workflow_*` tools and available computer-use tools.

## Teach

1. Call `workflow_record_start` with a concise name and goal.
2. Complete the task once with computer-use tools.
3. Call `workflow_record_stop` even when the demonstration had a recoverable mistake.
4. Read the draft with `workflow_draft_show`.

Recording is evidence, not a publishable workflow. Transient refs, state ids, coordinates, typed
text, URLs, exact values, browser code, images, and result bodies are deliberately absent.

## Review and publish

Convert the draft into semantic steps. Every replayable action must follow a durable `find_roots`
query and its target must have stable text, role, or capability evidence. Put app identity in
`find_roots`; an app-only action target is not replayable. Replace typed text and URLs with declared variables. Mark credentials,
tokens, OTPs, cookies, and other sensitive inputs as secret variables. Add checkpoints after actions
whose success matters.

Call `workflow_publish_prepare`, then show the returned workflow exactly and ask the user whether to
publish it. Preparation never publishes. Only after a newer user response explicitly approves that
workflow may you call `workflow_publish` with the approval ID. Do not prepare and publish in one
turn. This later-input boundary applies in every face and does not depend on a TUI dialog.

## Replay

Call `workflow_plan`. It returns compact `run_ui_segment` calls for compatible semantic actions but
does not invoke computer-use itself. Call each returned segment once; the driver resolves fresh UI
state before every target, requires a unique match, and stops on cancellation, stale or unknown
state, driver failure, or a failed checkpoint. Steps with text input, missing semantic targets, or no
postcondition remain manual. Ask the user to enter all text and secret variables directly in the
target app; never request a secret through workflow or segment tool arguments.

Keypress replay is limited to navigation/control keys and explicit modifier chords such as `CMD+A`
or `CTRL+L`. Bare letters, digits, punctuation, and character sequences are text input and remain
manual.

For logged-in browser acceptance, target the existing native browser window. Make the first
`wait`/assertion prove the expected logged-in UI before any action. `launch_browser` creates a
managed temporary browser profile that is isolated and logged out unless it was authenticated
separately; do not treat it as the user's existing browser session.

Always call `workflow_run_finish` with the returned run ID, including after an error or incomplete
manual step. The summary is derived from observed planned segment events; never invent or pass check
outcomes.
