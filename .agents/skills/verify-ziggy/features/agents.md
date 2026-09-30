# Agents

The Profile delegates to an agent in `agents/<id>.md` and gets a bounded answer back.

## Behaviors

- AG-1: `agent_run` writes one child under `sessions/agents/<parent-id>/`; its header's
  `parentSession` is the parent's absolute path; the child is sent only its declared tools and
  the agent body.
- AG-2: the parent's tool result is bounded (3,000 code points) and names the child file holding the
  full answer; the answer appears once in the parent's next request.
- AG-3: `agent_run` on an agent declaring an unknown tool (`reed`) or `profile_extensions` returns
  "tool is unavailable to Profile agent …", creates no child file, and the child never reaches the
  model. The parent run carries on; one bad agent file does not break the Profile.

## Entry points

The model calling `agent_run {agent, prompt}` from `run`, the web UI or a channel.

## Drive

Write `agents/researcher.md` (`version: 1`, `description`, `tools: read`), script
`tools(agent_run)`, `text(child)`, `text(parent)`, then `run`.

## Proof

Three model requests; request 1 tools `["read"]`; child file and header; tool result text.

## Gotchas

- Child tools never include `memory_write` or `agent_*`, whatever the file declares.
