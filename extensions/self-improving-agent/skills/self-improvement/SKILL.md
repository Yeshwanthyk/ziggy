---
name: self-improvement
description: Turn verified patterns from the current task into a proposed new or improved Agent Skill.
---

# Self-Improvement

Use this workflow when the user asks to turn evidence already available in the current task into a
new Agent Skill or an improvement proposal.

1. Identify the concrete correction, repeated pattern, or reusable workflow in the current
   conversation or user-provided material.
2. Verify that the pattern is durable and general enough to reuse. Do not promote guesses,
   one-off outcomes, secrets, credentials, raw transcripts, or temporary task state.
3. Draft a complete `SKILL.md` with valid Agent Skill frontmatter, focused trigger conditions, and
   concise instructions grounded in the evidence.
4. State the proposed skill name and whether it is a creation or replacement. Show the complete
   draft and cite the supporting evidence from the current task.
5. If the current runtime provides an approved Profile skill-writing capability, the agent may use
   it according to that capability's own contract. Otherwise, return the draft without writing.

This package owns no durable store, executable tool, or mutation path. Do not create learning
files, registries, aliases, hooks, backups, or package-to-package dependencies.
