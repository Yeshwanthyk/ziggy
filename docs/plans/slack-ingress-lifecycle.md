# Slack ingress lifecycle

This is the smallest state model for durable Slack adoption. It keeps Pi as the conversation and
session authority. The journal only decides whether one delivered Slack message still needs a turn;
it does not claim exactly-once model execution or exactly-once Slack delivery.

Quint is not installed in the repository environment, so this packet is a structured machine spec.

## State and ownership

- One row is authoritative for one logical Slack message, keyed by workspace-local `channel` plus
  source message timestamp. A unique Socket Mode `event_id` is an additional deduplication key.
- `state` is `received`, `running`, `completed`, `failed`, `cancelled`, or `unknown`.
- `owner_id` is null in `received` and terminal states. A `running` row is owned by exactly one
  resident-start UUID, never only by a PID.
- A non-terminal row retains only the bounded inbound fields required to replay the accepted
  request. Its prompt text is cleared on every terminal transition. Pi JSONL remains the transcript
  and session authority.
- An acknowledgement capability belongs to one live Socket Mode connection and is never persisted.

Initial state is an empty schema-versioned journal and one new resident owner UUID.

## Transition table

| From | Trigger / actor | Guard | Durable write | Publication | Recovery |
| --- | --- | --- | --- | --- | --- |
| absent | accepted Slack envelope / gateway | owner policy accepts and payload decodes | insert `received` under both unique keys | ACK only after commit | unacknowledged transaction failure is eligible for Slack redelivery |
| existing | duplicate envelope / gateway | event ID or logical key already exists | none | ACK duplicate; do not prompt | existing row remains authoritative |
| `received` | worker adoption / current resident | row is unowned | CAS to `running` with current `owner_id` | start one in-memory turn | a crash leaves a recoverable old owner |
| `running` | successful final delivery / owning worker | row owner equals current resident | CAS to `completed`, clear owner and prompt text | finish feedback | terminal; never replay |
| `running` | known failed turn or delivery / owning worker | row owner equals current resident | CAS to `failed`, clear owner and prompt text | finish failure feedback | terminal; never replay |
| `running` | ambiguous outbound result / owning worker | row owner equals current resident | CAS to `unknown`, clear owner and prompt text | do not retry the post | terminal pending future reconciliation |
| `running` | explicit cancellation / owning worker | row owner equals current resident | CAS to `cancelled`, clear owner and prompt text | publish cancellation feedback | terminal; never replay |
| `running` | resident startup recovery | stored owner differs from current owner | CAS to `received`, clear owner | enqueue once | current resident may adopt |
| terminal | retention / gateway | older than bound and not active | delete bounded terminal rows | none | no effect on active work |

Ignored, malformed, unsupported, and unauthorized envelopes are acknowledged without journal rows.
Their policy decision is deterministic from the event and does not represent accepted work.

## Invariants

1. An accepted envelope is acknowledged only if its durable row committed or an authoritative
   duplicate row already exists.
2. One logical key has at most one row and at most one current-owner `running` turn.
3. `completed`, `failed`, `cancelled`, and `unknown` rows are never replayed.
4. Only the resident named by `owner_id` can publish a terminal transition.
5. A stale connection cannot acknowledge an envelope after reconnect.
6. New-message posts are never retried after an ambiguous network or server outcome.
7. Journal/schema failure fails Slack adoption visibly; it never silently falls back to volatile
   acceptance.

SQLite uniqueness, `BEGIN IMMEDIATE`, state-and-owner CAS predicates, and connection-local ACK
capabilities enforce these invariants. The Profile's existing resident gateway lease prevents two
healthy residents from intentionally sharing the journal; the database guards crash and stale-owner
boundaries.

## Representative traces

- Success: envelope -> insert `received` -> ACK -> claim `running` -> Pi -> final edit ->
  `completed`.
- Duplicate route: `message` inserts and ACKs -> `app_mention` hits logical-key uniqueness -> ACKs
  without a second Pi turn.
- Crash before commit: no row and no ACK -> Slack redelivers -> normal success trace.
- Crash after ACK: `received` or old-owner `running` survives -> next resident recovers and adopts.
- Ambiguous final post: request becomes `unknown`; the post is not replayed and the row is not
  automatically retried.
- Concurrent duplicate: one transaction inserts; the other observes the unique row; only the
  winner can claim `running`.

## Boundary proof matrix

- SQLite: strict initialization, duplicate event/logical keys, transaction rollback, owner-fenced
  transitions, startup recovery, terminal non-replay, terminal-only retention.
- Socket: valid events expose deferred ACK; caller ACK uses the exact envelope and live connection;
  ignored frames still ACK; reconnect invalidates stale ACK.
- Gateway: commit precedes ACK, duplicate produces no second prompt, recovered row runs once,
  terminal transitions require current owner, journal failure leaves accepted work unacknowledged.
- Existing delivery: ambiguous posts remain single-attempt; idempotent updates retain bounded
  retries.
