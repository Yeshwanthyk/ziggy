# Constitution

Eight invariants. Every one of these was paid for by a bug or a design failure somewhere else
first. Violating one is not a style nit — it's a regression against a lesson we already
learned the hard way. If a change requires breaking one, that's a signal to stop and reconsider
the change, not the invariant.

## 1. One process writer for machine-owned state

The daemon that owns a Profile is the sole process writer for machine-owned state: `sessions/`,
`memory/`, `.runtime/`, Extension state, and Gateway resume maps. A second daemon, Client, or
Gateway process never writes those files directly.

Human-owned moldable files — `SOUL.md`, `ziggy.jsonc`, and `automations/*.md` — are edited directly
by the owner on disk. The daemon reloads them and never writes them except when the owner invokes
an explicit command whose purpose is to do so.

Merlin's earlier iteration allowed enough ambiguity about who could touch profile state that
concurrent-write corruption was a live risk instead of a structurally impossible one. One
daemon per Profile, socket living inside the Profile's own `.runtime/`, closes that off by
construction rather than by convention.

## 2. Session owns transcripts and run evidence; Memory owns retained facts

Session is the sole authority for transcripts and Run evidence. Memory is the sole authority for
retained facts. Neither can shadow or substitute for the other.

Other durable Profile artifacts are allowed, but each has exactly one owning authority and none
is conversational state: `ziggy.jsonc` is owner-authored configuration; `SOUL.md` and Voice
templates are owner-authored instructions and starters; Extension files are installed capability
definitions and Extension state is daemon-owned private state; Automation files are owner-authored
trigger definitions; `credentials/` contains daemon-managed authentication material; and `.runtime/`
contains daemon-owned control files. No side tables or shadow logs may duplicate Session or Memory
authority.

This is the direct fix for "Memory ≠ transcript" confusion that caused ambiguity in earlier
designs about which store was authoritative for what. Explicit ownership keeps configuration,
capabilities, control state, transcripts, and retained facts from drifting into one another.

## 3. No state has two writable authorities

Indexes, caches, and search projections over Session or Memory data are rebuildable from the
source of truth at any time. They are never themselves written to as if they were the source
of truth, and losing one is never a data-loss event — only a rebuild cost.

Every system studied during ziggy's design (hermes-agent's memory dreaming step, openclaw's
context assembly) keeps a hard line between the authoritative store and anything derived from
it. The moment a derived structure becomes writable-and-trusted, it silently becomes a second
authority, and the two eventually disagree.

## 4. Providers never own the loop

A Provider is a wire adapter for one model call. It streams a response; it does not decide
what happens next, does not own retries-as-turns, does not run its own agentic loop. Ziggy's
Effect-native loop is the only loop, for every provider, including subscription-auth backends
like Codex.

This was nearly not true: Codex subscription auth looked at first like it needed its own
"delegated engine" with independent loop supervision, mirroring merlin's fail-closed legacy
Codex app-server integration that ran a competing loop. Source inspection of pi-ai showed
`openai-codex-responses` is implemented as an ordinary wire call with OAuth — so the exception
that would have justified a second loop doesn't actually exist. Keep it that way: if a future
provider seems to need loop-like behavior, the fix is in ziggy's loop, not a new subsystem.

## 5. Clients and Gateways mutate only through the daemon

CLI, TUI, GUI, and every Gateway attach to the daemon over the attach protocol and are
dependency-free leaves. They subscribe to state, send input, and steer running Turns. Every
mutation they request goes through an attach-protocol method; they never write Profile files or
hold a writable copy of Profile truth. Direct owner edits to human-owned moldable files remain
outside this rule and are reloaded by the daemon under invariant 1.

This is flue's zero-coupling pattern applied deliberately: a client that can mutate state
directly is a client that can drift from the daemon's view of that state, and drift is exactly
what turns "reconnect and everything's fine" into "reconnect and something's wrong but only
sometimes."

## 6. Every durable thing is a human-readable file whose path is its identity

Sessions are NDJSON files. Memory is markdown. A Profile is a directory. If you can't find a
piece of durable state by looking at the filesystem, something is wrong. No opaque binary
formats, no state that only makes sense through a database client.

This is what makes "local-first now, Cloudflare later" a storage-seam problem instead of an
architecture rewrite, and it's what makes the whole system debuggable with `cat` and `grep`
instead of a bespoke inspection tool.

## 7. No LLM call without a reason

A model gets invoked only for: a user message in an active Turn, an Automation Run whose
wake-gate has already passed, or a Step that genuinely needs a tool/model call to proceed.
There is no periodic self-wake, no "check in every N minutes just in case."

Hermes-agent's wake-gate pattern is the model here: gate cheaply (often for $0, no LLM call at
all) before ever paying for a real check. Token frugality isn't a tuning knob applied after the
fact — it's why the wake-gate exists in the architecture in the first place.

## 8. Disconnect never kills work

A Client dropping its connection to the daemon does not stop, cancel, or corrupt whatever
Session or Run it was attached to. Work started by a Turn or a Run continues under the
daemon's ownership; the Client can reattach and replay from where it left off.

Codex's app-server protocol treats disconnect and cancellation as two unrelated events, and
merlin's Telegram gateway paid for conflating "connection went away" with "stop the work" via a
documented context-loss bug. Resume handles are Gateway-owned; stream handles are
runtime-owned. Keeping those structurally distinct is what makes reattach-and-replay possible
instead of aspirational.
