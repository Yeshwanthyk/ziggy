---
name: gh-issues
description: "Investigate GitHub issues, implement approved fixes in isolated branches or worktrees, open pull requests, and address actionable review feedback using the gh CLI and GitHub REST API. Use for issue-to-PR workflows, parallel issue fixing, and review follow-up."
---

# GitHub issue-to-PR workflow

Use the authenticated `gh` CLI for issue discovery and GitHub REST operations. Keep local work
isolated per issue and obtain approval before implementing, pushing, opening pull requests, or
changing issues.

## Authenticate and resolve the repository

```bash
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef
```

If authentication is missing, ask the user to run `gh auth login` or configure a standard
GitHub CLI authentication method. Do not search application state files for credentials or
print tokens.

Use `--repo OWNER/REPO` when the current directory does not unambiguously identify the target.
For raw REST endpoints, use `gh api`, which reuses GitHub CLI authentication:

```bash
gh api repos/OWNER/REPO/issues/42
```

## Discover issues

```bash
gh issue list \
  --repo OWNER/REPO \
  --state open \
  --limit 30 \
  --json number,title,body,labels,assignees,url

gh issue view 42 \
  --repo OWNER/REPO \
  --json number,title,body,labels,assignees,comments,url
```

Optional filters:

```bash
gh issue list --repo OWNER/REPO --label bug --state open
gh issue list --repo OWNER/REPO --assignee @me --state open
gh issue list --repo OWNER/REPO --search "is:open no:assignee"
```

Exclude pull requests when using the REST `/issues` endpoint because that endpoint returns both
issues and pull requests:

```bash
gh api --paginate repos/OWNER/REPO/issues \
  -f state=open \
  --jq '.[] | select(has("pull_request") | not) | {number, title, labels}'
```

## Present and confirm

Before editing code, summarize each candidate issue:

- issue number and title;
- requested behavior and acceptance criteria;
- likely code area and uncertainty;
- labels, assignment, and existing related pull requests;
- proposed branch name and checks.

Ask the user to approve the issue set when they did not already specify exact issue numbers and
authorize implementation.

## Preflight

1. Verify the repository and default branch.
2. Fetch the latest remote refs.
3. Check for existing branches or pull requests for each issue.
4. Confirm that each issue is actionable from available information.
5. Assign disjoint worktrees when running fixes in parallel.

```bash
DEFAULT_BRANCH=$(gh repo view OWNER/REPO --json defaultBranchRef --jq '.defaultBranchRef.name')
git fetch origin "$DEFAULT_BRANCH"
gh pr list --repo OWNER/REPO --state open --search "42 in:title,body"
```

Do not claim an issue, assign users, or post comments unless the user requested that mutation.
Do not maintain a hidden local claims database.

## Implement in an isolated worktree

```bash
ISSUE=42
BRANCH="fix/issue-$ISSUE"
WORKTREE=$(mktemp -d)

git worktree add -b "$BRANCH" "$WORKTREE" "origin/$DEFAULT_BRANCH"
cd "$WORKTREE"
```

Read repository instructions, inspect the relevant code path, implement only the approved
scope, and run focused checks. Keep unrelated changes out of the branch.

For parallel work, create one worktree per issue and avoid overlapping file ownership. Use the
current host's task or process facilities if available; do not assume a particular sub-agent
runtime.

## Commit, push, and open a pull request

Only perform these steps when authorized:

```bash
git status --short
git diff --check
git add path/to/owned-file
git commit -m "fix: address issue #42"
git push -u origin "$BRANCH"

gh pr create \
  --repo OWNER/REPO \
  --base "$DEFAULT_BRANCH" \
  --head "$BRANCH" \
  --title "fix: concise issue summary" \
  --body "Closes #42

## Summary
- describe the change

## Checks
- list commands and results"
```

Do not embed credentials in remote URLs or disable credential helpers globally.

## Inspect reviews

Find pull requests associated with the issue or branch:

```bash
gh pr list \
  --repo OWNER/REPO \
  --state open \
  --json number,title,headRefName,url,reviewDecision
```

Fetch review summaries, inline review comments, and conversation comments:

```bash
gh pr view 123 \
  --repo OWNER/REPO \
  --json reviews,comments,reviewDecision,statusCheckRollup

gh api --paginate repos/OWNER/REPO/pulls/123/comments
gh api --paginate repos/OWNER/REPO/issues/123/comments
```

Classify feedback before changing code:

- actionable: requests a concrete code, test, documentation, or behavior change;
- already resolved: the current branch contains the requested change;
- informational: no change requested;
- ambiguous: ask for clarification;
- conflicting: explain the conflict and request a decision.

Present actionable items and obtain approval if the user did not already authorize review
follow-up.

## Address review feedback

Work on the existing pull-request branch in an isolated checkout:

```bash
FIX_DIR=$(mktemp -d)
gh repo clone OWNER/REPO "$FIX_DIR"
cd "$FIX_DIR"
gh pr checkout 123
```

Implement the approved comments, run focused checks, inspect the diff, commit, and push. Reply
to review threads only when requested and include the commit or explanation that resolves the
comment.

Useful REST calls:

```bash
# Reply to an inline review comment
gh api repos/OWNER/REPO/pulls/123/comments/COMMENT_ID/replies \
  -f body='Addressed in COMMIT_SHA.'

# Add a pull-request conversation comment
gh pr comment 123 --repo OWNER/REPO --body "Addressed the approved review feedback."
```

## Cleanup and reporting

After the worktree is no longer needed:

```bash
git worktree remove "$WORKTREE"
```

Report:

- issue and pull-request links;
- branches or worktrees created;
- changed files and checks;
- review items addressed or still open;
- failures that need user action.
