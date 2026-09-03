---
name: executor
description: Discover and use connected-service tools through the installed Executor catalog.
---

# Executor

Executor owns connected sources, credentials, source policy, approvals, and paused
execution state. Never request raw service credentials in chat.

## Discovery

1. Call `executor_tools_sources` to inspect configured sources.
2. Call `executor_tools_search` with a natural-language query.
3. Call `executor_tools_describe` for the selected tool path.
4. Before `executor_call`, state the exact target service/resource and intended effect.
5. If execution pauses, surface the execution ID and requested action. Call
   `executor_resume` only after the user has explicitly supplied or approved that action.

All tools accept an `args` array. Each element is passed as one argument after the
tool's fixed Executor subcommand.

Examples:

```json
{"args":["send email","--limit","5"]}
```

```json
{"args":["gmail.send"]}
```

```json
{"args":["gmail","send","{\"to\":\"alice@example.com\",\"subject\":\"Hi\"}"]}
```

For a paused execution:

```json
{"args":["--execution-id","exec_123","--action","accept"]}
```
