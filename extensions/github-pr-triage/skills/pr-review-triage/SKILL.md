---
name: pr-review-triage
description: Triage GitHub pull requests needing review or authored by the current user.
---

# PR Review Triage

Use `gh_prs` for read-only GitHub pull request triage.

## Review requests

Call:

```json
{"args":["review-requested"]}
```

Group results by `repository.nameWithOwner`. Show each PR as `#<number>
<title> by <author.login> — updated <relative time>`. Mark a PR stale when
`updatedAt` is more than 48 hours ago.

## Authored pull requests

Call:

```json
{"args":["mine"]}
```

Group by repository. Prefix drafts with `[DRAFT]`, show `reviewDecision`, and
summarize passing, failing, and pending checks from `statusCheckRollup`.

## Deep dive

Call:

```json
{"args":["view","owner/repo","123"]}
```

Summarize:

```text
#<n> <title> [<state>] [DRAFT?]
Branch: <head> → <base>
Files: <changedFiles> (+<additions>/-<deletions>)
<changed paths>
Review: <decision or none> | CI: <pass/fail/pending or none>
```

Do not open URLs unless asked. Keep the output terse and action-oriented.
