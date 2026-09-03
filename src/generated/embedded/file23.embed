---
name: coding-agent
description: "Delegate substantial repository work to Codex, Claude Code, OpenCode, or Pi coding agents. Use for feature implementation, large refactors, isolated pull-request reviews, and parallel issue work when the user names or approves an external coding-agent CLI."
---

# Coding agents

Run the coding agent the user requested inside the intended repository. Use direct editing for
small changes unless delegation was explicitly requested.

## Choose the CLI

| Agent | Typical command |
| --- | --- |
| Codex | `codex exec "task"` |
| Claude Code | `claude --print "task"` |
| OpenCode | `opencode run "task"` |
| Pi | `pi -p "task"` |

Check each installed CLI's `--help` before relying on optional flags. Preserve the user's agent
choice; do not silently switch agents after a failure.

## Prepare the task

1. Resolve the exact working directory.
2. Read repository instructions before starting the agent.
3. Put acceptance criteria, ownership boundaries, and required checks in the prompt.
4. Tell the agent which external mutations are authorized: commit, push, comment, or open a
   pull request.
5. Keep unrelated user changes intact.

For scratch work, use a temporary git repository:

```bash
AGENT_WORK_DIR=$(mktemp -d)
git -C "$AGENT_WORK_DIR" init
cd "$AGENT_WORK_DIR"
codex exec "Create a minimal example and verify it."
```

## Run and monitor

Use the host's background-process capability for long tasks. Follow the host tool's actual
schema rather than assuming particular field names.

- Use a PTY only when the selected command is interactive.
- Capture output and exit status.
- Send input only when the agent asks a concrete question.
- Do not kill a healthy process merely because it is slow.
- Report milestones, questions, failures, and completion to the user from the current session.

Do not instruct a child process to call a product-specific notification command.

## Agent examples

### Codex

```bash
cd /path/to/repository
codex exec --full-auto "Implement the approved change. Run focused checks and summarize the diff."
```

Use `--yolo` only with explicit authorization for unsandboxed execution.

### Claude Code

```bash
cd /path/to/repository
claude --print "Review the current diff and report correctness issues."
```

Do not bypass permissions unless the user explicitly authorized that risk.

### OpenCode

```bash
cd /path/to/repository
opencode run "Refactor the parser without changing behavior. Run focused tests."
```

### Pi

```bash
cd /path/to/repository
pi -p "Summarize the architecture and identify the narrowest implementation path."
```

Install Pi from its upstream package when needed:

```bash
npm install --global @earendil-works/pi-coding-agent
```

## Isolated reviews

Use a temporary clone or git worktree:

```bash
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/owner/repository.git "$REVIEW_DIR"
cd "$REVIEW_DIR"
gh pr checkout 130
codex review --base origin/main
```

Do not post review findings unless the user requested it.

## Parallel issue fixes

Create one worktree and branch per issue:

```bash
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

(cd /tmp/issue-78 && codex exec "Fix issue #78 and run focused checks.") &
(cd /tmp/issue-99 && codex exec "Fix issue #99 and run focused checks.") &
wait
```

Review each result independently. Avoid overlapping file ownership between workers. Push,
commit, or create pull requests only within the user's authorization.

## Completion

Return:

- the agent and working directory used;
- the outcome and changed files;
- checks run and their results;
- any remaining question or failure.
