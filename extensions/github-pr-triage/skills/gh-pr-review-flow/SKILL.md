---
name: gh-pr-review-flow
description: Summarize and triage batches of GitHub pull request review requests, then handle explicit approval requests safely.
---

# GitHub PR Review Flow

Parse references such as `owner/repo#123`, or `repo#123` when the owner is clear
from the user's pasted context.

Collect read-only details with:

```json
{"args":["view","owner/repo","123"]}
```

Group related PRs by feature first and repository second:

```text
<feature>
- owner/repo#N — <files> files, +A/-D
  - <what changed>
  - <why it matters>
  - <review risk or follow-up>
```

Include review state, CI state, merge blockers, shared branches or commits, and a
suggested review order. Separate generated or noisy file areas from authored
changes.

`gh_prs` is read-only. Only approve when the user explicitly asks, using the
standard GitHub tooling available in the environment:

```sh
gh pr review <number> --repo <owner/repo> --approve
gh pr view <number> --repo <owner/repo> --json reviewDecision --jq .reviewDecision
```

Approve exactly the PRs the user named or just confirmed. Never merge. If a PR
changed after the last summary, summarize the delta before approval unless the
user explicitly says to approve anyway.
