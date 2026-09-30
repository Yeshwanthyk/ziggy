# Agents

The Profile delegates to an agent in `agents/<id>.md` and gets a bounded answer back.

## Behaviors

- AG-1: `agent_run` writes one child under `sessions/agents/<parent-id>/`; its header's
  `parentSession` is the parent's absolute path; the child is sent only its declared tools and
  the agent body.
- AG-2 (red): the parent's tool result is bounded. Today it is the full answer, twice.
- AG-3 (red): an agent declaring an unknown tool (`reed`) or `profile_extensions` fails before
  any model call. Today it is noticed only when `agent_run` is called.

## Entry points

The model calling `agent_run {agent, prompt}` from `run`, the web UI or a channel.

## Drive

Write `agents/researcher.md` (`version: 1`, `description`, `tools: read`), script
`tools(agent_run)`, `text(child)`, `text(parent)`, then `run`.

## Proof

Three model requests; request 1 tools `["read"]`; child file and header; tool result text.

## Gotchas

- Child tools never include `memory_write` or `agent_*`, whatever the file declares.
