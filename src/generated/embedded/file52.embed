---
name: linear
description: Work with Linear issues, projects, teams, states, comments, and GraphQL.
---

# Linear

The `linear` tool expects `LINEAR_API_KEY` in the environment. Pass the helper
command and flags as the `args` array.

Prefer read commands first:

```json
{"args":["whoami"]}
{"args":["list-teams"]}
{"args":["list-projects"]}
{"args":["list-states","ENG"]}
{"args":["list-issues","--team","ENG","--limit","20"]}
{"args":["get-issue","ENG-123"]}
{"args":["search-issues","timeout","--limit","20"]}
```

Before a mutation, state the exact Linear team/issue target and intended effect.
Then use the normal `linear` tool:

```json
{"args":["create-issue","--team","ENG","--title","Fix timeout","--description","Details"]}
{"args":["update-status","ENG-123","--state","Done"]}
{"args":["add-comment","ENG-123","--body","Deployed in release 42."]}
```

Use `raw` only when the named commands are insufficient. State whether the
GraphQL operation reads or mutates and identify its target before calling it.
Return identifiers and URLs for created or updated resources.
