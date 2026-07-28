# Letta Code long-chat and context lifecycle

Source snapshot: `/tmp/letta-code-review.MbHk8d/letta-code` at
`abe20844ce15d79bfe72b7d8570269b6a9cbbdf0`. All `src/...` citations below are
repo-relative to that commit. This note describes the API-backed product path
first, then the experimental in-process local backend that lives in the same
client repository.

## Boundary and authority

In API mode, the Letta server is authoritative for conversations, messages,
runs, the active `in_context_message_ids`, compaction, and provider execution.
The client backend is intentionally a forwarding boundary: message list,
compact, create/stream, run retrieval, and run replay all call Letta SDK
resources (`src/backend/backend.ts:404-489`). The client persists only the last
selected `{agentId, conversationId}` in global and project settings so it can
find that server-owned state again (`src/settings-manager.ts:1449-1464`).

The `"default"` conversation is a compatibility identity for an agent's primary
history. It requires `agent_id`; named conversations use their own IDs
(`src/agent/message.ts:254-279`). On resume, the client explicitly treats
`conversation.in_context_message_ids` as the authority for the active tail and
pending approvals, while fetching recent message variants for display and
approval reconstruction (`src/agent/check-approval.ts:432-548`).

The experimental local backend moves that authority into this repository. A
conversation record holds active message IDs, while a version-3 append-only
`messages.jsonl` retains message and compaction entries. Reload projects the
active set from the full transcript using those IDs
(`src/backend/local/local-store.ts:740-890`). Compaction replaces the active
buffer with one synthetic summary message plus any retained recent messages,
updates `in_context_message_ids`, and appends a compaction record without
deleting earlier transcript rows (`src/backend/local/local-store.ts:1852-1910`,
`src/backend/local/local-store.ts:3250-3379`).

## Turn payload and provider context

The API client does not send the whole conversation to the model. It normalizes
only the new message/approval, snapshots client tools and skills, and submits:
`messages`, streaming/background flags, `client_tools`, `client_skills`,
`include_compaction_messages: true`, an optional model override, and `agent_id`
for `"default"` (`src/agent/message.ts:314-376`,
`src/agent/message.ts:467-485`). Actual history selection, system/memory prompt
assembly, provider payload construction, token accounting, tool-loop execution,
and automatic server compaction are therefore delegated to the Letta
server/cloud API; their algorithms are not present or provable from this client
checkout.

The local backend is inspectable. It appends the turn input, loads ordered
stored/UI history, resolves the conversation-specific agent and compiled system
prompt, then gives that state to its executor
(`src/backend/dev/fake-headless-backend.ts:448-525`). The Pi adapter constructs
the provider context as `systemPrompt + toPiMessages(active uiMessages) +
client tools`; model/provider options come from the local Pi models runtime
(`src/backend/dev/pi-stream-adapter.ts:567-610`). Thus local provider context is
derived from the active projection, while the append-only transcript remains
the recall/archive source.

## Compaction lifecycle

API-backed automatic compaction is observable but server-owned. Every turn asks
for compaction messages, and the stream/UI recognizes a `compaction` event
followed by a `summary_message` with optional before/after statistics
(`src/agent/message.ts:268-279`, `src/cli/helpers/accumulator.ts:1389-1492`).
The client cannot establish the cloud trigger threshold or archival transaction
from this repository.

Manual compaction is client-exposed as `/compact` with default, `all`,
`sliding_window`, `self_compact_all`, or
`self_compact_sliding_window`. PreCompact hooks run first; the client then calls
the backend compact endpoint and reports message counts and the summary.
Post-compaction reflection is best-effort and cannot fail the compaction
(`src/cli/app/use-submit-handler.ts:2159-2293`). `/compaction` edits the
configured mode instead (`src/cli/commands/registry.ts:143-149,583-585`).
Channel ingress deliberately does not support `/compact` yet
(`src/channels/registry-command-routing.test.ts:219-232`).

Local automatic compaction has three evidenced triggers:

- A preflight estimate above `contextWindow - min(16,384, 20% of window)`
  compacts before the provider call (`src/backend/dev/provider-turn-executor.ts:215-254`,
  `src/backend/dev/pi-stream-adapter.ts:528-555,765-783`).
- A provider-reported context overflow compacts and retries, with a bounded
  compaction count (`src/backend/dev/pi-stream-adapter.ts:786-814`).
- An oversized retryable transport payload first elides image bytes; if needed
  it compacts, while a summarizer failure falls back to the original transient
  retry path (`src/backend/dev/pi-stream-adapter.ts:816-866`).

Local mode defaults to `sliding_window`. It selects an assistant-message
boundary, summarizes the evicted prefix, and keeps a recent suffix; if it cannot
find a safe/effective boundary it falls back to `all`. Pending trailing tool
calls are retained rather than summarized
(`src/backend/local/compaction.ts:575-658`,
`src/backend/local/local-backend.ts:765-825`). Summary generation occurs before
the active buffer/store mutation; after success, the summary and stats are
persisted and the compiled system prompt is refreshed
(`src/backend/local/local-backend.ts:828-929`).

## Retention, recall, replay, and resume

Compaction is loss of *active context*, not deletion of history. The product
prompt promises that old messages remain searchable
(`src/agent/prompts/letta_no_memfs.md:27-45`). In API mode,
`letta messages search` delegates hybrid/vector/FTS search to the server and
`letta messages list` expands around a message cursor
(`src/agent/prompts/recall_subagent.md:1-81`,
`src/backend/message-search.ts:22-43`). The agent sees this mainly through the
built-in `recall` subagent; `conversation_search` is also an attached,
parallel-safe server tool (`src/agent/subagents/builtin/recall.md:1-11`,
`src/agent/approval-execution.ts:45-82`).

Local recall uses full-text search over the retained JSONL transcripts and can
fall back to read-only filesystem search under the local backend directory
(`src/agent/prompts/recall_subagent_local.md:1-94`,
`src/backend/message-search.ts:22-38`). Forked subagents can inherit a forked
conversation, and the fork remains retrievable by ID even when hidden
(`src/tools/impl/task.ts:674-703`).

Normal process resume reselects the persisted agent/conversation, fetches a
bounded recent tail, backfills the UI, and reconstructs pending approvals from
the authoritative active IDs (`src/index.ts:2467-2577`,
`src/agent/check-approval.ts:480-565`). Mid-stream recovery is separate: after
an unterminal stream error the client attempts one replay, preferring the input
OTID so the server can resolve the exact run, otherwise using a scoped
post-request run lookup. It resumes after the last seen `seq_id`; explicit user
abort and approval-pending conflicts suppress replay
(`src/cli/helpers/stream.ts:676-801,831-890`). If replay fails, incomplete tools
are cancelled in the UI and the original stream error is retained
(`src/cli/helpers/stream.ts:967-1024`). SDK retries on initial send are disabled
because blind retries could duplicate stateful turns
(`src/agent/message.ts:290-321`).

Local turn recovery also settles tool calls orphaned by a killed/interrupted
turn before accepting a new non-approval input, preventing invalid provider
history (`src/backend/dev/fake-headless-backend.ts:448-466`). Local persistence
is not a single atomic transaction: `conversation.json` is written before the
JSONL append, using `writeFileSync`/`appendFileSync`
(`src/backend/local/local-store.ts:3170-3205,3368-3379`). The repo has repair and
migration paths for malformed/legacy/orphaned transcript state, but this write
ordering leaves a crash window that the cited source does not prove fully
recoverable.

## Tests that pin the behavior

The most relevant contracts are:

- request-body delegation and skill/image normalization:
  `src/agent/send-message-stream-skill-sources.test.ts`,
  `src/agent/send-message-stream-image-normalization.test.ts`;
- active-ID resume, bounded tails, stale IDs, and approval variants:
  `src/agent/check-approval-resume-data.test.ts:160-705`;
- OTID/run fallback selection:
  `src/cli/stream-resume-fallback.test.ts:32-147`;
- local threshold-before-provider persistence:
  `src/backend/local-backend-context-pressure.test.ts:54-112`;
- compaction transcript/package parity and recursive summaries:
  `src/backend/local-compaction-parity.test.ts:59-198`;
- local reload after compaction, hooks, model carryover, append-only tool
  history, and repairs:
  `src/backend/local-backend.test.ts:792-1125,1593-2250`;
- sliding/all planning and summarizer model behavior:
  `src/backend/local/compaction.test.ts:27-118`.

I attempted those focused tests at the pinned checkout, but the checkout has no
installed `@letta-ai/letta-client` or `@earendil-works/pi-ai`; Bun stopped during
module resolution before executing any test (`0 pass, 5 fail`). The claims above
are therefore source- and test-contract-backed, not freshly runtime-verified.

## Narrow comparison to Ziggy/Pi main chat

Ziggy's own specification already assigns loop execution, provider payloads,
session JSONL, compaction, branching, and replayable session history to Pi, with
Ziggy owning Profile policy and composition
(`docs/research/minimal-ziggy-scout.md:9-25`). The pinned Pi surface confirms an
explicit session directory, append-only persisted sessions, runtime
`switchSession`/`newSession`/`fork`, and compaction/retry events
(`docs/research/pi-sdk-surface.md:102-122,181-236`).

The evidenced Letta lesson for Ziggy's main-chat need is therefore about
authority, not importing Letta's context engine: keep one durable transcript
authority, keep active context as a projection that compaction may replace with
a summary, retain originals for recall, and resume by stable session identity.
Letta Code implements that identity as `{agentId, conversationId}` plus
server-owned active IDs; Ziggy currently delegates transcript/compaction to Pi
and still lists stable main-session identity and resume UX as later work
(`docs/plans/primitive-status.md:20,78`). This evidence does not justify a
Ziggy-owned message store, provider-context builder, or compactor.
