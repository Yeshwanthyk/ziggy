---
name: linear
description: Answer questions about Linear issues, projects and teams, such as what is assigned to me. Read only.
---

# Linear

The `linear` plugin exposes Linear's read-only MCP server as `mcp__linear__*` tools, reached
through `codemode`. Use them to look up issues, projects, cycles and teams.

- For "what's assigned to me", find the current user, then list their open issues, grouped by
  state and sorted by priority.
- Quote issue identifiers (for example `ENG-123`) and titles; link with the issue URL.
- This server is read only. Never claim to have created, edited or closed anything.
- If the tools are missing, the server was skipped: the user must store the key with
  `ziggy plugin secret set <profile> LINEAR_API_KEY`. Never ask for the key in chat.
