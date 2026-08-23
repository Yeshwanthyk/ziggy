---
name: diffs
description: Create reviewable Profile-local diff artifacts from patches, before/after text, or GitHub pull requests.
---

# Diffs

Use `diffs` when the user needs a concrete diff artifact. Prefer one tool call
per artifact.

Accepted inputs:

```json
{"patch":"<unified diff>","title":"optional","mode":"file"}
{"before":"old","after":"new","path":"file.txt","mode":"file"}
{"source":{"kind":"pr","ref":"owner/repo#123"},"mode":"file"}
```

For pull request sources, the tool runs `gh pr diff <number> --repo
<owner/repo>`. If `gh` is unavailable or unauthenticated, obtain the patch
another way and call `diffs` with `patch`.

Artifacts are written to `.runtime/diffs/artifacts/<id>.diff` under the current
Profile. Return the `rawPath` as a standard Markdown file link when the user
wants to inspect or share the generated file. Use `mode:"text"` when only patch
text is needed and `mode:"both"` when both text and a file are useful.
