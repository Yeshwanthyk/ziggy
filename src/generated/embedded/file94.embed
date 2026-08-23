---
name: curator
description: Review repeated completed Profile sessions and apply bounded memory or Curator-managed skill improvements.
---

# Curator

Run this workflow only from the `curator` automation or when the user asks for an immediate review.
The readiness marker is a cheap admission signal, not evidence by itself.

1. Call `self_improvement_status` and stop if the Curator is not ready.
2. Review the source Pi session JSONL for the distinct completed foreground sessions named by the
   logs. Do not treat automation, specialist, interrupted, empty, or one-off work as evidence.
3. Prefer a durable, concise memory fact over a long procedure. Call native `memory_write` for an
   approved memory add, and prefix every learned entry with `[learned]`.
4. Create a new skill only for a repeated class of work across distinct sessions. Call
   `self_improvement_extension_write` to create a real skill-only package under the Profile, then
   call the in-process `profile_extensions` tool with `action: "add"` and the new shelf ID. Never
   shell into `ziggy`, invoke a Ziggy CLI command, or edit `extensions.json` directly. The
   Profile admits it after restart only when that tool returns structured success.
5. Patch only a Profile package whose `package.json` visibly marks it `ziggy.curatorManaged: true`.
   Never change repository, catalogue, human-owned, external, or pinned packages.
6. Call `self_improvement_log` with an `applied`, `no-op`, or `staged` decision and compact evidence.
   Set `clearReady: true` only after the review and every approved write completed successfully.

Do not copy raw transcripts, secrets, credentials, temporary task state, or guesses into logs,
memory, or skills. A late or conflicting result must be logged as a no-op and must not overwrite
newer Profile state.
