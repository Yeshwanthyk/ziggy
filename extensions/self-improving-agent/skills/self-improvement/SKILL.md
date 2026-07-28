---
name: self-improvement
description: Capture durable learnings, errors, corrections, and feature requests in cwd-local .learnings files.
---

# Self-Improvement

Capture only durable, reusable discoveries in the current Profile's
`.learnings/` directory. Do not log secrets, tokens, environment values, raw
transcripts, or full source/config files. Prefer concise, redacted summaries.

## Initialize

Create `.learnings/` and only missing files. Never overwrite existing entries.
Use the starter files in this skill's `assets/` directory as templates.

| Situation                                              | File                             |
| ------------------------------------------------------ | -------------------------------- |
| Unexpected command, API, or tool failure               | `.learnings/ERRORS.md`           |
| Correction, outdated assumption, or reusable discovery | `.learnings/LEARNINGS.md`        |
| Requested missing capability                           | `.learnings/FEATURE_REQUESTS.md` |

Search `.learnings/` before adding a potentially duplicate entry. Use IDs
`LRN-YYYYMMDD-XXX`, `ERR-YYYYMMDD-XXX`, or `FEAT-YYYYMMDD-XXX`.
Formatting examples are in `references/examples.md`.

## Promotion

Promote a learning only when its pattern is verified and reusable. Update the
source entry with the promoted status and target path.

`sia_extract_skill` is a normal mutating Pi tool. Before calling it, explicitly
state:

- the source learning;
- the exact Profile-relative output target;
- that it will create a new skill scaffold.

Pass the skill name and options as `args`:

```json
{ "args": ["docker-m1-fixes", "--dry-run"] }
```

```json
{ "args": ["docker-m1-fixes", "--output-dir", "skills/custom"] }
```
