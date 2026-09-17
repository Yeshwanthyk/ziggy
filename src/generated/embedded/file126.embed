---
name: computer-workflows
description: Record a computer task and make a reusable workflow, save a completed task, or run and improve a saved workflow using the full computer-use agent.
---

# Computer workflows

Use the general task tools for recording, saving, and replay. Execute tasks with the existing
computer-use tools and the normal agent loop. Page structure and the availability of a compiled
shortcut do not determine whether a task is supported.

## Record and make a workflow

“Record this and make a workflow” authorizes the complete recording-to-save sequence. Begin
recording before acting, perform the task, improve the procedure, verify the candidate, and save
it in the same request. Continue through these stages without asking for separate stop, optimize,
or save instructions. Ask only for information or authorization that the actual task requires.

1. Start `workflow_task_record_begin` with the user's goal and a concise name. Use full computer-use
   capabilities to complete the task. Keep the chosen browser profile and starting context stable.
2. Finish recording with `workflow_task_record_finish`. Treat failed or unresolved actions as
   recovery information; do not turn them into instructions to repeat blindly.
3. Build a general task definition from the successful work: goal, reusable nonsecret inputs,
   starting app/page and browser profile, nonsecret input defaults for repeat runs, flexible procedure,
   output definition, and explicit
   completion criteria. Preserve the user's filters and requested coverage. Remove exploratory and
   redundant operations; retain required navigation, pagination, extraction, and recovery checks.
4. Prepare the improved candidate with `workflow_task_prepare`. Start its verification run with
   `workflow_task_run_start`. Follow the returned task context using any appropriate computer-use
   tool. Verify in a reversible context; do not repeat a purchase, submission, deletion, or message
   merely to test a saved procedure. If proof is unresolved, retain the draft and explain why.
5. Use `workflow_task_run_status` to obtain the observed evidence references. Finish with
   `workflow_task_run_finish`, supplying an outcome for every completion criterion. Reference
   actual successful observations and the current output artifacts. Label semantic conclusions as
   agent assessments; successful tool calls or an existing file alone do not establish completeness.
6. Save the exact verified candidate with `workflow_task_save`. Report the saved identifier,
   inputs, completion result, and output location. Save locally; export as a skill/extension only
   when requested.

Typed values, credentials, cookies, tokens, and transient UI references do not belong in reusable
instructions. Use existing authenticated profiles and runtime inputs; let the user handle missing
credentials. Recording observes agent tool activity, not the user's unobserved mouse/keyboard.

For “save that” after a completed task, use `workflow_draft_recent` and inspect its draft, then
continue from candidate preparation. Do not require a new demonstration merely because explicit
recording was not armed.

## Run or resume

Discover the saved task with `workflow_task_list` and `workflow_task_show`, start its run with the requested inputs, and follow its procedure using
the full computer-use toolset. Opening the saved browser profile and starting page is part of
execution. Resolve fresh UI state rather than reusing recorded references. If a shortcut fails,
inspect what actually happened and continue with the agent; do not duplicate a completed action.

Use `workflow_task_run_status` for progress and unresolved calls. Resume an interrupted run through
`workflow_task_run_resume`; first inspect uncertain actions against the current UI and submit
reconciliations through `workflow_task_run_status` with fresh observation evidence. Cancel with
`workflow_task_run_cancel` when the task is cancelled. Finish every run with criterion evidence,
and report incomplete coverage explicitly. Keep large extraction results in structured artifacts
and return a concise summary with their paths.

A successful adaptation can inform an improved candidate. Verify that candidate before replacing
the current saved revision; failed improvements leave the working revision intact.

## Existing compiled workflows

For a previously saved compiled semantic workflow, consult
[accelerators.md](references/accelerators.md). New adaptable tasks use the general task lifecycle
above.
