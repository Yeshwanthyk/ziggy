---
name: codex
description: "Delegate feature work, refactoring, code review, and issue fixing to the OpenAI Codex CLI. Use when a user asks to run Codex against a repository or wants parallel Codex work in isolated worktrees."
---

# Codex CLI

Use the [OpenAI Codex CLI](https://github.com/openai/codex) for repository-scoped coding work.
Run commands in the target repository and preserve the user's requested scope.

## Prerequisites

```bash
codex --version
```

If Codex is missing, install it with the method documented by the upstream project. If
authentication is missing, run the Codex login flow or use the authentication method the user
already chose.

Codex expects a trusted working directory. For scratch work, create a temporary git repository:

```bash
SCRATCH_DIR=$(mktemp -d)
git -C "$SCRATCH_DIR" init
cd "$SCRATCH_DIR"
codex exec "Build a small command-line example."
```

## One-shot tasks

```bash
cd /path/to/repository
codex exec "Add a dark-mode toggle to settings and run the focused tests."
```

Use `codex exec` when the task should finish and return control. Use a PTY only when the current
Codex command is interactive.

## Autonomy

- Prefer the default approval and sandbox settings.
- Use `--full-auto` only when the user has authorized workspace edits and command execution.
- Use `--yolo` only when the user explicitly accepts unsandboxed, unapproved execution.
- Keep the working directory explicit and avoid running against unrelated repositories.

## Reviews

Review in an isolated clone or worktree so the target checkout remains untouched:

```bash
REVIEW_DIR=$(mktemp -d)
git clone https://github.com/owner/repository.git "$REVIEW_DIR"
cd "$REVIEW_DIR"
gh pr checkout 42
codex review --base origin/main
```

Do not post review comments or change pull requests unless the user asked for that external
mutation.

## Parallel issue work

Use one branch and worktree per issue:

```bash
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

(cd /tmp/issue-78 && codex exec "Fix issue #78. Run focused checks.") &
(cd /tmp/issue-99 && codex exec "Fix issue #99. Run focused checks.") &
wait
```

Inspect each diff and test result separately. Push branches or create pull requests only when
the user authorized those actions.

## Operating rules

1. Use the requested repository and agent.
2. State what Codex is running and where when work continues in the background.
3. Monitor without interrupting a healthy long-running task.
4. Surface questions and failures instead of silently changing the task.
5. Treat commits, pushes, pull requests, and review comments as separate requested actions.
