# UI group conversation ownership

Status: accepted for the current Ziggy WebSocket protocol.

## Decision

A durable group conversation is owned by exactly one Profile resident. Its machine-owned metadata
contains only:

- `conversationId`
- `hostProfileId`
- `memberAgentIds`
- `defaultRecipient`
- `revision`

The host Profile's one `ChatHandle` is the only writer to the group's canonical Pi JSONL
transcript. The browser never reads or writes the record or transcript directly.

Addressed turns carry a typed member agent ID. The gateway validates that ID against the current
record before admitting the turn. An unaddressed turn uses the record's explicit default
recipient. Multi-agent discussion runs bounded specialist child sessions, publishes labeled voice
events, and asks the host to synthesize the result into the canonical conversation. Child sessions
remain separate Pi-owned JSONL transcripts; they never write the host transcript.

Membership mutations require both an expected revision and an idempotent command ID. A repeated
command with the same intent returns its recorded outcome; reuse with different intent fails. A
stale expected revision fails without changing metadata.

## Invariants

1. One group has one host Profile resident and one canonical transcript writer.
2. Every member belongs to the host Profile; member IDs are server-validated domain values.
3. No browser state, replay buffer, pin record, or group record becomes transcript authority.
4. Event replay is a bounded transport projection. Pi JSONL remains durable history authority.
5. Cross-Profile groups, external fanout, and mailbox delivery are rejected until Ziggy has a
   durable delivery contract with explicit admission, receipts, replay, and recovery.

## Recovery

After a gateway restart, the Profile resident reloads group metadata, opens the host conversation
through the normal chat registry, and reconciles visible history from Pi JSONL. The server epoch
changes, so clients discard old replay cursors and request history before restoring the watch.
