# Entry Examples

## Learning

```markdown
## [LRN-20260728-001] best_practice

**Logged**: 2026-07-28T12:00:00Z
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

Use the repository's declared package manager for deterministic test commands.

### Details

The repository pins its package manager and lockfile. Using another manager can
produce a different dependency graph.

### Suggested Action

Inspect package metadata and use the declared manager.
```

## Error

```markdown
## [ERR-20260728-001] command_failure

**Logged**: 2026-07-28T12:00:00Z
**Priority**: medium
**Status**: resolved

### Summary

A command failed because a required executable was absent from PATH.

### Suggested Fix

Check the documented prerequisite before invoking the command.
```

## Feature request

```markdown
## [FEAT-20260728-001] export_format

**Logged**: 2026-07-28T12:00:00Z
**Priority**: low
**Status**: pending

### Requested Capability

Export results in a machine-readable format.
```
