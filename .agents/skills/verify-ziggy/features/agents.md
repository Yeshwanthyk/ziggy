# Agents

The Profile delegates to an agent in `agents/<id>.md` and gets a bounded answer back.

## Behaviors

- AG-1: `agent_run` writes one child under `sessions/agents/<parent-id>/`; its header's
  `parentSession` is the parent's absolute path; the child is sent only its declared tools and
  the agent body.
- AG-2: the parent's tool result is bounded (3,000 code points) and names the child file holding the
  full answer; the parent transcript stores the answer once (tool content), not again in `details.result`.
- AG-3: `agent_run` on an agent declaring an unknown tool (`reed`) or `profile_extensions` returns
  "tool is unavailable to Profile agent …", creates no child file, and the child never reaches the
  model. The parent run carries on; one bad agent file does not break the Profile.
- AG-4: `agent_discuss` with 2 agents and 2 rounds runs the agents in sorted order, each with no
  tools, and writes 4 child files under the parent; round 2 prompts carry the round 1 answers.
  Duplicate agent ids are refused before any child runs.
- AG-5: an agent with no `provider`/`model` runs on the Profile default model and thinking.

## Entry points

The model calling `agent_run {agent, prompt}` or `agent_discuss {topic, agents, rounds}` from
`run`, the web UI or a channel; `ziggy agents run <id>` and an agent rail (`open` with `agent`).

## Drive

Write `agents/researcher.md` (`version: 1`, `description`, `tools: read`), script
`tools(agent_run)`, `text(child)`, `text(parent)`, then `run`.

## Proof

Three model requests; request 1 tools `["read"]`; child file and header; tool result text.

## Gotchas

- Child tools never include `memory_write` or `agent_*`, whatever the file declares.
