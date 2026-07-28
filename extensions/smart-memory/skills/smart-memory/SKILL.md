---
name: smart-memory
description: Review freshly injected scoped memory against current evidence, then apply explicit native memory operations.
---

# Smart Memory

Use this workflow when the user asks to remember something, correct or forget durable memory, or
review memory for stale or missing facts. The current turn already contains freshly injected
memory under `## Memory (shared)` and either `## Memory (this person)` or
`## Memory (this group)`.

1. Read the injected memory in the current context. Do not read memory files directly. If the
   prompt says Profile memory is unavailable, stop and tell the user; do not write memory.
2. Compare the current conversation and user-provided evidence with the freshly injected entries.
   If the evidence is incomplete or conflicting, ask the user or leave memory unchanged.
3. Propose only durable, user-relevant changes:
   - `add` for a stable fact absent from the admitted scope;
   - `replace` for one existing entry that is stale or less precise;
   - `remove` for one existing entry that is false, obsolete, or explicitly unwanted.
4. State the exact scope and operation(s), with the supporting current evidence. Apply them only
   when the user directly requested that memory change or explicitly approves the proposal.
5. Call `memory_write` once with the explicit all-or-nothing operation batch. For `replace` and
   `remove`, copy `oldText` from exactly one freshly injected entry. Report the tool result.

Use `shared` only for assistant-wide facts, `person` only in a local or 1:1 conversation, and
`group` only in a group conversation. Keep entries concise and curated. Never store secrets,
credentials, raw conversation dumps, temporary task progress, guesses, or facts supported only by
an old session when newer evidence conflicts.

`memory_write` is the sole memory authority. Do not write, edit, index, cache, or schedule work
against memory files by any other route.
