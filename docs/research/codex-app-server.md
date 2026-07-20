# codex app-server protocol

The JSON-RPC control-plane protocol OpenAI's `codex` CLI exposes so a host application can drive Codex threads/turns without shelling out to a TUI — the closest existing analogue to ziggy's own attach protocol.

Date: 2026-07-19
Source repo: https://github.com/openai/codex (local clone: `/Users/yesh/.opensrc/repos/github.com/openai/codex/main`)
Primary sources: `codex-rs/app-server/README.md`, `codex-rs/app-server/src/{transport,thread_state,dynamic_tools,auth_mode,outgoing_message,message_processor}.rs`

## What it is

`codex app-server` is a long-lived process that speaks JSON-RPC 2.0 (the `"jsonrpc":"2.0"` header is omitted on the wire, so it is JSON-RPC-_shaped_ rather than spec-compliant) over a transport, exposing three primitives:

- **Thread** — a conversation between a user and the Codex agent; contains multiple Turns.
- **Turn** — one round from user input to agent completion; contains multiple Items.
- **Item** — a persisted unit of user input or agent output used as context for future turns: user message, agent reasoning, agent message, shell command, file edit, MCP tool call, web search, etc.

This Thread → Turn → Item nesting is structurally identical to what ziggy needs for Session → Operation → Step, and the read APIs (`thread/read`, `thread/turns/list`, `thread/items/list`) show a durable-history model designed to be paged without resuming/loading the conversation.

## Transports

Declared in `codex-rs/app-server/README.md` "Protocol" section:

- **stdio** (default, `--stdio` or `--listen stdio://`): newline-delimited JSON (JSONL). This is what a CLI-embedded host process uses.
- **unix socket** (`--listen unix://` or `--listen unix://PATH`, default path `$CODEX_HOME/app-server-control/app-server-control.sock`): a _websocket_ connection carried over the unix socket using the standard HTTP Upgrade handshake — not raw JSONL. `codex app-server proxy` opens exactly one raw stream connection to that socket (or `--sock PATH`) and proxies bytes between it and stdin/stdout, so a stdio-only client can still reach the control-plane socket transparently.
- **websocket** (`--listen ws://IP:PORT`, **experimental/unsupported**): one JSON-RPC message per text frame. The same listener also serves plain HTTP health probes — `GET /readyz` (200 once accepting connections) and `GET /healthz` (200 only when no `Origin` header is present; any `Origin`-bearing request is rejected 403, presumably to block browser-JS access).
- **off** (`--listen off`): no local transport exposed at all (used when app-server is driven purely via `command/exec`-style embedding or another mechanism).

There's a daemon/backend split: `app-server-daemon` (crate confirmed at `codex-rs/app-server-daemon`, modules `backend`, `client`, `managed_install`, `remote_control_client`, `settings`, `update_loop`) manages a supervised background app-server process — PID file (`app-server.pid`), a separate updater PID file, a `daemon.lock` operation lock (75s timeout), and start-polling (50ms interval, 10s timeout) — while `app-server-client`/`app-server-transport` provide the client-side socket-path resolution (`app_server_control_socket_path`) and framing used by the `proxy` subcommand. This is a real precedent for "resident daemon with CLI attach" that ziggy's own daemon design should look at directly rather than re-deriving from scratch.

**Backpressure**: ingress/processing/outbound are bounded queues; when ingress is saturated, new requests are rejected with JSON-RPC error `-32001`, message `"Server overloaded; retry later."` — clients are expected to retry with exponential backoff + jitter. `RUST_LOG` controls tracing; `LOG_FORMAT=json` emits structured JSON logs to stderr.

## Message schema and versioning

`codex app-server generate-ts --out DIR` / `generate-json-schema --out DIR` dump a TypeScript or JSON-Schema snapshot of the _exact_ protocol version of the binary that produced it — there is no separate spec document; the schema is generated, not hand-maintained. Schema generation defaults to the **stable** surface only; pass `--experimental` to include gated fields/methods. This generate-from-source-of-truth pattern (rather than hand-written docs that drift) is worth copying for ziggy's own protocol.

## Lifecycle and handshake

1. **Initialize once per connection.** Immediately after opening a transport connection, send `initialize` with `clientInfo` (`name`, `title`, `version`) and optional `capabilities`, then emit an `initialized` notification. _Any other request sent before this handshake completes is rejected._ Re-initializing on the same connection is rejected with `"Already initialized"` — the capability negotiation (notably `experimentalApi`) is fixed for the connection's lifetime.
2. **Start/resume/fork a thread.** `thread/start` opens a fresh conversation and returns the thread object plus a `thread/started` notification (which includes current `thread.status`); the caller is auto-subscribed to turn/item events for that thread as a side effect. `thread/resume` reopens an existing thread by id so later `turn/start` calls append to it. `thread/fork` branches an existing thread into a new thread id by copying stored history, optionally bounded by `lastTurnId` (inclusive cutoff, rejects an in-progress boundary) or the experimental `beforeTurnId` (strict-before cutoff, allowed even mid-turn). Both `thread/start` and `thread/fork` accept `ephemeral: true` for an in-memory-only thread (`thread.path` is `null` when ephemeral).
3. **Begin a turn.** `turn/start` with `threadId` + user `input` returns the new turn object immediately; the server emits `turn/started` when it actually begins running. Overridable per-turn: model, cwd, sandbox/`permissions` profile, approval policy, reviewer, `runtimeWorkspaceRoots`, `environments`, etc.
4. **Stream events.** Keep reading notifications: `item/started` → item-specific deltas → `item/completed`, plus turn-level `turn/diff/updated`, `turn/plan/updated`, token-usage updates, and terminal `turn/completed`.
5. **Finish/interrupt.** `turn/completed` carries final `turn.status` (`completed` | `interrupted` | `failed`, with `{error: {message, codexErrorInfo?, additionalDetails?}}` on failure) and final token usage. `turn/interrupt` (by `(threadId, turnId)`) requests cancellation; the turn ends with `status: "interrupted"`.

## Capability gating (`experimentalApi`)

Some methods/fields have "no backwards-compatible guarantees" and are hidden unless the client opts in during `initialize`:

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": { "name": "my_client", "title": "My Client", "version": "0.1.0" },
    "capabilities": { "experimentalApi": true }
  }
}
```

- If `capabilities` is omitted, `experimentalApi` defaults to `false`.
- Using a gated method/field without opting in gets a JSON-RPC error `"<descriptor> requires experimentalApi capability"`, where descriptor is method-level (`mock/experimentalMethod`), field-level (`thread/start.mockExperimentalField`), or enum-variant-level (`askForApproval.granular`).
- Implementation-side, this is a Rust derive: fields are annotated `#[experimental("thread/start.myField")]` and the containing params type derives `ExperimentalApi`; nested experimental types propagate via `#[experimental(nested)]`. Two `just write-app-server-schema[--experimental]` invocations regenerate stable vs. experimental protocol fixtures.

There's a second, orthogonal opt-out axis: `initialize.params.capabilities.optOutNotificationMethods` lets a client suppress specific notification methods **by exact name only** (`item/agentMessage/delta` suppresses only that method; unknown names are silently ignored) — useful for a client that wants turn/item lifecycle events but not per-token streaming deltas. This does not apply to requests/responses/errors, only to server-initiated notifications.

## Method surface

### thread/*

`thread/start`, `thread/resume`, `thread/fork`, `thread/list` (cursor pagination + `modelProviders`/`sourceKinds`/`archived`/`cwd`/`searchTerm` filters, plus experimental `parentThreadId`/`ancestorThreadId` spawn-tree filters — mutually exclusive), `thread/loaded/list`, `thread/read` (optional `includeTurns`), `thread/turns/list` (experimental, cursor-paginated), `thread/items/list` (experimental, optional `turnId` scope), `thread/searchOccurrences`, `thread/metadata/update`, `thread/settings/update` (experimental — queues next-turn settings without starting a turn), `thread/memoryMode/set`, `thread/unsubscribe` (server keeps the thread loaded 30 minutes past the last subscriber before unloading — see Concurrency below), `thread/name/set`, `thread/unarchive`, `thread/compact/start`, `thread/shellCommand` (runs a user `!` command **unsandboxed with full access**, bypassing the thread's sandbox policy), `thread/backgroundTerminals/{clean,list}`, `thread/inject_items` (appends raw Responses-API items to model-visible history without starting a turn), `thread/realtime/*` (experimental voice/audio session layered on a thread).

### turn/*

`turn/start`, `turn/steer` (adds input to an _already in-flight_ turn without starting a new one — rejected for review/manual-compaction turns via `ActiveTurnNotSteerable`), `turn/interrupt`.

### Other domains

`review/start` (automated reviewer, emits `enteredReviewMode`/`exitedReviewMode` items), `command/exec` + `command/exec/write` (sandbox-scoped one-off command execution, no thread needed), `environment/{add,info,status}` (remote execution environments), `skills/{list,extraRoots/set,config/write}` + `skills/changed` notification, `hooks/list` + `config/batchWrite` for hook enable/disable, `app/{installed,list}` + `app/list/updated`, and the full **Auth endpoints** and **Approvals** surfaces detailed below.

## Events (notification taxonomy)

Every turn: `turn/started` → item lifecycle → `turn/completed`. Per-item lifecycle is always `item/started` → zero-or-more item-specific deltas → `item/completed`. Notable turn-scoped notifications beyond the item stream: `turn/diff/updated` (aggregated unified diff snapshot after every FileChange item), `turn/plan/updated` (`{step, status}` plan entries), `thread/tokenUsage/updated` (token usage streams separately from `turn/completed`), `rawResponse/completed` (internal-only, opt-in via `thread/start.experimentalRawEvents`, one per upstream Responses API completion — explicitly _not_ accumulated/persisted/replayed, unlike `thread/tokenUsage/updated`), `model/safetyBuffering/updated`, `model/rerouted`, `model/verification`.

`ThreadItem` is a tagged union; confirmed variants: `userMessage`, `agentMessage`, `plan`, `reasoning` (`summary` for streamed summaries + `content` for raw reasoning blocks on models that expose it), `commandExecution`, `fileChange`, `mcpToolCall` (includes `appContext` for calls routed through a trusted MCP "app"/connector), `collabToolCall` (`spawn_agent`/`send_input`/`resume_agent`/`wait`/`close_agent` — i.e. Codex has a native sub-agent spawning primitive baked into the item model), `webSearch`, `imageView`, `sleep`, `enteredReviewMode`/`exitedReviewMode`, `contextCompaction` (superseding a deprecated `compacted` notification).

Per-item-type delta notifications: `item/agentMessage/delta` (concatenate for full text), `item/plan/delta`, `item/reasoning/{summaryTextDelta,summaryPartAdded,textDelta}`, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated` (structured pre-execution patch snapshots, feature-gated).

Errors: a top-level `error` event carries `{error: {message, codexErrorInfo?, additionalDetails?}}` mid-turn (same shape as a failed `turn.status`). `codexErrorInfo` is a closed enum: `ContextWindowExceeded`, `SessionBudgetExceeded`, `UsageLimitExceeded`, `HttpConnectionFailed{httpStatusCode?}`, `ResponseStreamConnectionFailed{httpStatusCode?}`, `ResponseStreamDisconnected{httpStatusCode?}`, `ResponseTooManyFailedAttempts{httpStatusCode?}`, `ActiveTurnNotSteerable{turnKind}`, `BadRequest`, `Unauthorized`, `SandboxError`, `InternalServerError`, `Other`.

## Approvals (server-initiated requests)

When a turn needs permission (shell command, file write, MCP elicitation, dynamic tool call, permission grant), the server sends a **server-initiated JSON-RPC request** (has an `id`, expects a response) rather than a fire-and-forget notification. Every approval flow follows the same shape:

1. `item/started` — the pending item (`commandExecution`, `fileChange`, …) is rendered immediately, `status: "inProgress"`.
2. A domain-specific `*/requestApproval` request — e.g. `item/commandExecution/requestApproval` (carries `itemId`/`threadId`/`turnId`, nullable `environmentId`, optional `approvalId` for subcommand callbacks, `reason`, `command`/`cwd`/`commandActions`, and experimental `additionalPermissions`) or `item/fileChange/requestApproval`.
3. Client responds `{"decision": ...}` — command approvals support `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`, `decline`, `cancel`; file-change approvals support `accept`/`acceptForSession`/`decline`/`cancel`.
4. `serverRequest/resolved` — `{threadId, requestId}` — confirms the pending request was resolved _or cleared_ (also fired on turn-start/turn-complete/turn-interrupt cleanup of stale pending requests).
5. `item/completed` with `status: completed|failed|declined` is the authoritative result — separate from step 4's bookkeeping notification.

Other approval-shaped server requests follow the identical 5-step pattern: `item/tool/requestUserInput`, `attestation/generate` (desktop hosts that opted into `capabilities.requestAttestation`, invoked just-in-time before requests carrying `x-oai-attestation`), `currentTime/read` (experimental external clock source — a failed/timed-out/malformed response **stops the turn** before the model request goes out), `mcpServer/elicitation/request` (form / `openai/form` / URL modes, for MCP servers that need structured mid-turn input), and `item/permissions/requestApproval` (the `request_permissions` tool's approval flow — response can scope the grant to `"session"` so later shell-like calls in the same turn/session auto-reuse it; anything omitted from `result.permissions` is treated as denied).

**Dynamic tool calls** (experimental, requires `capabilities.experimentalApi`) are the general "let the client implement a tool" mechanism: `thread/start.dynamicTools` registers top-level functions or namespaces of functions (name pattern `^[a-zA-Z0-9_-]+$`, namespace names reserved-word-checked against built-in Responses namespaces like `functions`/`file_search`/`python`/`tool_search`). A function can set `deferLoading: true` to stay registered/callable (e.g. via `code_mode` or `tool_search`) without appearing in the model-facing tool list on ordinary turns. Invocation is `item/tool/call` → client responds with `contentItems` (`inputText`/`inputImage`/`inputAudio`, all as inline `data:` URLs — remote HTTP(S) image URLs and non-data audio URLs are rejected) + `success`. `codex-rs/app-server/src/dynamic_tools.rs` shows the server-side plumbing: it awaits the client's oneshot response, decodes+validates it (rejecting remote image URLs and non-`data:` audio URLs before they reach the model), and on any failure path — client error, transport failure, or turn-transition race — synthesizes a `fallback_response` (`success: false`, a text content item explaining what went wrong) so the model always gets a well-formed tool result rather than a hung call. This is the clean "host-mediation point" pattern: the server treats an unfulfilled dynamic tool call as a first-class recoverable error, not a protocol violation.

## Concurrency model (`thread_state.rs`)

This is the part most directly relevant to ziggy's multi-connection attach story. Read from `codex-rs/app-server/src/thread_state.rs` (583 lines):

- **`ThreadStateManagerInner`** holds three maps: `live_connections: HashMap<ConnectionId, ConnectionCapabilities>`, `threads: HashMap<ThreadId, ThreadEntry>`, and `thread_ids_by_connection: HashMap<ConnectionId, HashSet<ThreadId>>` — i.e. a bidirectional connection↔thread index, not just one direction.
- **`ThreadEntry`** = `{ state: Arc<Mutex<ThreadState>>, connection_ids: HashSet<ConnectionId>, has_connections_watcher: watch::Sender<bool> }`. Each thread's runtime state is a single `Arc<Mutex<...>>` shared across every subscribed connection — there is one authoritative in-memory thread state, and connections are just a _subscriber set_ layered on top of it, not independent copies.
- **`has_connections_watcher`** is a `tokio::sync::watch<bool>` that flips whenever `connection_ids` goes empty↔non-empty (`update_has_connections`, using `send_if_modified` so it only fires on actual transitions). `wait_for_thread_subscriber()` blocks on this until at least one connection is subscribed — used by things like the `currentTime/read` request path (`current_time.rs`), which needs _some_ live connection to ask before a turn can proceed.
- **Subscription is separate from connection add**: `try_ensure_connection_subscribed` (used for the "attach and also enable experimental raw events" path) vs. `try_add_connection_to_thread` (plain subscribe) both insert into both maps and call `update_has_connections()`; the split exists because raw-events-enablement needs an extra mutex-guarded write into `ThreadState` after the subscription bookkeeping.
- **Disconnect strips subscription without killing the thread.** `remove_connection(connection_id)` removes the connection from `live_connections`, walks that connection's `thread_ids_by_connection` entry, removes it from each `ThreadEntry.connection_ids`, and **returns only the thread ids that are now subscriber-empty** — it does not tear down thread state itself. `unsubscribe_connection_from_thread` is the explicit single-thread version of the same thing, returning `bool` for whether it actually removed anything.
- **`remove_thread_state`** is the actual teardown: it removes the `ThreadEntry`, prunes the reverse index, unregisters the listener-command channel, and — critically — calls `ThreadState::clear_listener()`, which fires the stored `cancel_tx` oneshot (cancelling the per-thread listener task), clears the listener's command sender, resets the accumulated `current_turn_history`, and drops the weak `Weak<CodexThread>` handle. This is invoked from the 30-minute-idle unload path described in the README (`thread/unsubscribe`: "the server keeps the thread loaded and unloads it only after it has had no subscribers and no thread activity for 30 minutes, runs `SessionEnd` hooks, then emits `thread/closed`") — confirming the linger window is a real, separately-timed grace period, not an immediate unload-on-zero-subscribers.
- **Per-thread listener generation counter.** `ThreadState.listener_generation: u64` increments (`wrapping_add(1)`) every time `set_listener()` installs a new listener task for that thread — e.g. on resume after an unload, or on any re-attach. `listener_matches()` compares by `Arc::ptr_eq` against a `Weak<CodexThread>` to check whether a given conversation handle is still the live one, which is how the server disambiguates "stale event from a superseded listener" from "current listener" without needing a separate epoch/version field on every event.
- **`ThreadListenerCommand`** is an ordering-enforcement queue (`mpsc::UnboundedSender/Receiver`) local to one thread's listener task: `SendThreadResumeResponse`, `EmitThreadGoalUpdated`, `EmitThreadGoalCleared`, `EmitThreadGoalSnapshot`, `ResolveServerRequest{request_id, completion_tx}`. The doc-comments are explicit about _why_ this exists: e.g. `ResolveServerRequest` "is executed in the thread listener's context to ensure that the resolved notification is ordered with regard to the request itself" — i.e. the design accepts an extra hop through a command queue specifically to guarantee notification ordering relative to the events the listener task itself emits, rather than relying on which async task happens to run first.
- **Resume replays atomically.** `PendingThreadResumeRequest` bundles `history_items`, `config_snapshot`, `instruction_sources`, `thread_summary`, pagination state, and a `resume_cursor_store` into one struct that gets pushed onto the _same_ `ThreadListenerCommand` queue as live events — so a resuming connection's history replay is serialized against concurrently-arriving live events for that thread rather than racing them; the resume response and the first live event a resuming client sees are guaranteed correctly ordered relative to each other.

## Approval fan-out: single-callback, first-response-wins

`OutgoingMessageSender::send_request_to_connections(connection_ids: Option<&[ConnectionId]>, request, thread_id)` in `outgoing_message.rs` is the mechanism behind every server-initiated request (approvals, elicitations, dynamic tool calls). Key structural fact: **one `RequestId` maps to exactly one `oneshot::Sender<ClientRequestResult>`**, stored in `request_id_to_callback: HashMap<RequestId, PendingCallbackEntry>`, regardless of whether the request was sent to one connection or broadcast to several (`connection_ids: None` broadcasts to all; `Some(ids)` sends the identical request id+payload to each listed connection individually). `notify_client_response(id, result)` calls `take_request_callback(&id)`, which **removes** the entry from the map before fulfilling the oneshot. Because the map entry is consumed on first use, only the first response for a given request id can resolve the oneshot — any later response for the same id finds nothing in the map (no entry to remove, so it's a no-op/logged-as-unknown rather than a second resolution). This is the concrete mechanism behind the "first-response-wins, `serverRequest/resolved` broadcasts the resolution" behavior described in the README's approval flows: it isn't a special-cased race-resolution algorithm, it's a natural consequence of a single consumable oneshot channel keyed by request id shared across every connection the request was fanned out to.

## Auth

Five modes, surfaced via `account/updated`'s `authMode` field and `codex_protocol::auth::AuthMode` (`ApiKey`, `Chatgpt`, `ChatgptAuthTokens`, `Headers`, `AgentIdentity`, `PersonalAccessToken`, `BedrockApiKey` — confirmed in `codex-rs/app-server/src/auth_mode.rs`, which exists solely as an orphan-rule-mandated conversion function between the domain `AuthMode` and the wire `ApiAuthMode`, kept as separate types on purpose "so app-server protocol ownership does not leak into domain crates"):

- **API key** (`apiKey`) — `account/login/start {type:"apiKey", apiKey}`, stored and used directly.
- **ChatGPT managed** (`chatgpt`, recommended) — Codex owns the OAuth flow and refresh; browser flow (`type:"chatgpt"`, returns `{loginId, authUrl}`, app-server hosts the local OAuth callback, with an optional `useHostedLoginSuccessPage`/`appBrand` redirect-page selection) or device-code flow (`type:"chatgptDeviceCode"`, returns `{loginId, verificationUrl, userCode}` for out-of-band display). Both resolve via `account/login/completed` + `account/updated` notifications.
- **Amazon Bedrock** (`amazonBedrock`, experimental, requires `experimentalApi`) — API key + region, Codex-managed; writes `model_provider = "amazon-bedrock"` to `config.toml`. Note: "Existing loaded sessions keep their current provider selection, so clients should restart the app-server before sending more model requests" — an explicit known limitation, not silently handled.
- **Personal access token** (`personalAccessToken`) — provisioned entirely outside the login RPCs (`codex login --with-access-token` or `CODEX_ACCESS_TOKEN` env var), i.e. the app-server auth endpoints don't cover every auth path; some are CLI/env-only.
- **`ChatgptAuthTokens`** exists as a distinct `AuthMode` variant from `Chatgpt` in the domain type but isn't documented in the README's auth-mode table — internal/legacy, consistent with the earlier session's characterization of it as an "internal" mode.

`account/read {refreshToken}` checks current state (`requiresOpenaiAuth` tells the caller whether the active provider needs OpenAI credentials at all — false for e.g. Bedrock). `account/rateLimits/read` / `account/rateLimits/updated` expose ChatGPT quota-window usage, an optional effective monthly credit limit, `spendControlReached` (tri-state: `true`/`false`/`null`-meaning-unavailable, and a `null` in a sparse update must **not** clear a previously observed non-null value — an explicit sparse-merge contract), and "earned rate-limit reset credits" that can be redeemed via `account/rateLimitResetCredit/consume` with a caller-supplied idempotency key (outcomes: `reset`, `alreadyRedeemed`, `nothingToReset`, `noCredit`).

## MCP relationship

Codex is simultaneously an MCP-_adjacent_ protocol (app-server's own transport/handshake is explicitly modeled "similar to MCP") and an MCP **client** — it connects out to configured MCP servers on behalf of the agent. Confirmed crates: `codex-mcp`, `rmcp-client` (the actual MCP client implementation, presumably atop the `rmcp` Rust MCP SDK), `mcp-server` (Codex itself can apparently also be _exposed as_ an MCP server — a separate embedding mode from app-server). App-server-level MCP surface: `mcpServer/oauth/login` (OAuth for a configured MCP server, resolves via thread's selected plugins/executor, returns `authorization_url` then `mcpServer/oauthLogin/completed`), `config/mcpServer/reload` (hot-reload MCP config without restarting app-server; applied on each thread's next active turn, not immediately), `mcpServerStatus/list` (enumerate configured servers + tools + auth status + resources, paginated), `mcpServer/resource/read`, `mcpServer/tool/call` (direct, thread-scoped, out-of-band MCP tool invocation independent of the agent loop), and `mcpServer/startupStatus/updated` notifications (`starting`/`ready`/`failed`/`cancelled`, with `failureReason: "reauthenticationRequired"` specifically flagging expired-and-unrefreshable OAuth so a client can prompt reconnection). At the item level, `mcpToolCall` items distinguish raw MCP tool calls from calls routed through a trusted "MCP app"/connector (`appContext` with `connectorId`/`linkId`/`resourceUri`/`appName`/`actionName`) — i.e. there's a whole separate "Apps" layer (`app/installed`, `app/list`, `plugin/read`) built on top of raw MCP for a curated/hosted-connector experience, distinct from bring-your-own MCP server config.

## No raw completion path

Nothing in the method surface lets a client send a single one-off completion request and get a raw model response back outside the Thread/Turn/Item model — `command/exec` is the closest thing to a "just run something" primitive, and it's sandbox-scoped shell execution, not a model call. Every model interaction is mediated through `turn/start`/`turn/steer` against a thread, which persists Items and streams through the full notification taxonomy. This is a deliberate design constraint worth naming explicitly for ziggy: there is no "stateless completion" escape hatch in this protocol — everything is thread-durable by construction.

## Recommendation: minimal subset for ziggy

Ziggy's attach protocol doesn't need to (and shouldn't, at first) implement the full surface above. A minimal viable subset that captures the load-bearing design decisions:

**Adopt:**

- The three-primitive Thread/Turn/Item nesting mapped onto ziggy's Session/Operation/Step, with the same `item/started → deltas → item/completed` per-item lifecycle and terminal `turn/completed` carrying final status + usage.
- The mandatory `initialize`/`initialized` handshake gate before any other request, plus per-connection `optOutNotificationMethods` (exact-match) so a thin client can opt out of high-frequency deltas without the server needing per-client filtering logic beyond a name-set lookup.
- A single shared `Arc<Mutex<ThreadState>>`-per-conversation model with a connection-subscriber set layered on top, rather than per-connection copies of state — this is what makes multi-attach (two terminals watching the same session) cheap and consistent.
- Disconnect-strips-subscription-without-killing-state, plus a linger/idle-unload window (30 minutes is Codex's number; ziggy should pick its own but the _shape_ — grace period before teardown, not instant unload on zero-subscribers — is right) so a flaky client reconnecting seconds later doesn't lose in-flight state.
- Single-oneshot-per-request-id for any server-initiated approval/request fan-out — it gives first-response-wins semantics for free without a special race-resolution algorithm, and a `*/resolved` notification broadcast so other subscribed connections know a pending prompt is no longer live (avoids duplicate/stale approval UI across multiple attached clients).
- Bounded-queue backpressure with a specific retryable error code + message, rather than either unbounded buffering or hard connection drop.
- Schema-generation-from-source-of-truth (`generate-ts`/`generate-json-schema` off the actual server binary) over hand-maintained protocol docs, given ziggy is also going to iterate its wire protocol quickly pre-1.0.

**Skip (for now):**

- The realtime/voice layer (`thread/realtime/*`) — a large, separately-versioned (`v1`/`v2`/`v3` handoff modes) subsystem orthogonal to ziggy's current scope.
- The Apps/connector layer (`app/*`, `plugin/*`, MCP-app `appContext`) — this is OpenAI's hosted-connector marketplace integration, not a core protocol concern.
- `collabToolCall`/multi-agent spawn primitives (`spawn_agent`/`send_input`/`resume_agent`/`wait`/`close_agent`) baked into the item model — worth revisiting once ziggy has its own subagent story, but not needed for a first attach protocol.
- Dynamic tool calls as a generic host-mediation mechanism — useful long-term (it's a genuinely good pattern, see above) but adds real protocol surface (namespacing rules, reserved-word checks, content-item validation) that isn't needed until ziggy has a concrete use case for client-implemented tools.
- The five-way auth-mode matrix and its ChatGPT-specific rate-limit/credit-redemption endpoints — entirely OpenAI-account-specific; ziggy's provider auth is a pi-ai concern (see `docs/research/pi-ai-provider-layer.md`), not an attach-protocol concern.
- Experimental-capability field/method gating machinery (`#[experimental(...)]` derive, dual schema generation) — adopt the _concept_ (a boolean capability flag negotiated once at `initialize`) but the Rust-derive-macro implementation is overkill until ziggy's protocol has enough stable-vs-experimental surface to need it.
- websocket transport (still explicitly "experimental/unsupported" even in Codex itself) — stdio + unix-socket-with-HTTP-Upgrade is the proven pair; don't add a third transport speculatively.
