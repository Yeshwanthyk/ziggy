# Cloudflare platform constraints

Hard capabilities and limits of Cloudflare Durable Objects and the Workers/workerd runtime, as documented on developers.cloudflare.com as of late 2025 (with later-dated changelog entries noted where they change the picture). Every claim carries its source URL. Facts verified against official docs and changelog posts; where a widely-repeated figure (8760 h, 10 ms per DO wake) could not be verified against current docs, that is stated explicitly.

Sources marked **[limits]** resolve to `https://developers.cloudflare.com/<path>`.

---

## 1. Durable Objects: what they are, persistence, storage API, SQLite, transactions, hibernation

### What they are
- A Durable Object (DO) is a special kind of Worker that combines compute with durable, strongly-consistent storage. Each object has a **globally-unique name** addressable from anywhere; storage lives colocated with the object.
  Source: https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
- Each object is **single-threaded and cooperatively multi-tasked** (actor model); requests interleave but storage access is serialized via input/output gates.
  Source: https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/ · https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/
- Objects are implicitly created on first access, migrate among hosts, and hibernate when idle. "You can have millions of them" — no hard limit on number of objects per namespace.
  Source: https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/

### Persistence / Storage API
- Storage is private to each object instance, transactional, and strongly consistent. Accessed via `ctx.storage` (`DurableObjectStorage`).
  Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Two storage backends exist per DO class:
  - **SQLite-backed (new, recommended)**: full SQL API (`ctx.storage.sql.exec()`), synchronous KV API (`ctx.storage.kv`), point-in-time recovery (PITR), and Alarms.
  - **KV-backed (legacy)**: asynchronous KV API only (`get/put/delete/list`), no SQL.
  Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- **Transactions**: "Each method is implicitly wrapped inside a transaction, such that its results are atomic and isolated from all other storage operations." Multiple SQL statements can run in one `exec()`. Write durability is gated (outgoing network messages are delayed until writes flush to disk, unless `allowUnconfirmed: true`); `sync()` forces flush.
  Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- **PITR**: SQLite-backed objects can restore the entire database (SQL + KV data) to any point in the last **30 days** via bookmarks (`getCurrentBookmark`, `getBookmarkForTime`, `onNextSessionRestoreBookmark`). Not available in local dev.
  Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- SQLite extensions supported: FTS5 (full-text search), JSON1, math functions.
  Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- When a SQLite-backed object hits its storage cap (10 GB Paid / 1 GB Free), writes fail with `SQLITE_FULL`; reads and deletes continue to work.
  Source: https://developers.cloudflare.com/durable-objects/platform/limits/

### Hard storage numbers
| Item | Limit | Source |
|---|---|---|
| Storage per SQLite-backed DO | **10 GB** (Paid) / 1 GB (Free); unlimited storage per account on Paid | [durable-objects/platform/limits] |
| Storage per KV-backed DO | Unlimited; 50 GB per account (Paid, raiseable) | [durable-objects/platform/limits] |
| KV-backed value size | **128 KiB** (131,072 B); key **2 KiB** | [durable-objects/platform/limits] |
| SQLite-backed key+value combined | **2 MB** | [durable-objects/platform/limits] |
| SQL: columns/table | 100 | [durable-objects/platform/limits] |
| SQL: max string/BLOB/row | **2 MB** | [durable-objects/platform/limits] |
| SQL: statement length | 100 KB | [durable-objects/platform/limits] |
| SQL: bound params/query | 100 | [durable-objects/platform/limits] |
| SQL: args/SQL function | 32 | [durable-objects/platform/limits] |
| SQL: LIKE/GLOB pattern | 50 bytes | [durable-objects/platform/limits] |
| Max DO classes/account | 500 (Paid) / 100 (Free) | [durable-objects/platform/limits] |
| Soft throughput per object | ~1,000 requests/sec (single-threaded; queued then "overloaded" errors) | [durable-objects/platform/limits] |

### Hibernation API
- `ctx.acceptWebSocket(ws)` (hibernation variant of `server.accept()`), handlers `webSocketMessage(ws, msg)` / `webSocketClose(...)`, `getWebSockets()`, per-connection tags, `serializeAttachment()` / `deserializeAttachment()`.
  Source: https://developers.cloudflare.com/durable-objects/api/state/ · https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- While hibernated the object is removed from memory, clients stay connected, and **billable duration (GB-s) does not accrue**. On an event, the constructor re-runs.
  Source: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Attachment size cap: **16,384 bytes** (structured-clone serialized). Larger state must go to storage.
  Source: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Hibernation conditions: no `setTimeout`/`setInterval`, no in-flight `fetch()`, no standard WebSocket API in use, no outbound TCP/WebSocket. After **10 seconds** idle the runtime may hibernate; a **non-hibernateable** object is evicted after **70–140 seconds** of inactivity. No shutdown hooks exist.
  Source: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- `setWebSocketAutoResponse` answers matching frames **without waking** the object (request/response pair capped at 2,048 chars each). Ping frames are auto-answered without waking the object.
  Source: https://developers.cloudflare.com/durable-objects/api/state/ · https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- `setHibernatableWebSocketEventTimeout` max: **604,800,000 ms (7 days)** per WebSocket event.
  Source: https://developers.cloudflare.com/durable-objects/api/state/

---

## 2. CPU time limits (Workers + DOs)

### Workers
| Plan | CPU per HTTP request | Cron | Notes |
|---|---|---|---|
| Free | **10 ms** | 10 ms | also 100,000 requests/day |
| Paid | **5 min max** (default **30 s**), configurable via `limits.cpu_ms` (up to 300,000 ms) | 30 s (<1 h interval) / 15 min (≥1 h interval) | no daily request cap |

- CPU time is *active processing* only; time awaiting `fetch()`, KV, storage, DB I/O does not count.
- Exceeding → Error 1102 `Worker exceeded resource limits`, outcome `exceededCpu`.
- Source: https://developers.cloudflare.com/workers/platform/limits/
- The 5-minute ceiling was announced **2025-03-25** ("Run Workers for up to 5 minutes of CPU-time"); default stayed 30 s.
  Source: https://developers.cloudflare.com/changelog/post/2025-03-25-higher-cpu-limits/

### Durable Objects
- **CPU per request: 30 s default, configurable to 5 min** of active CPU via `limits.cpu_ms` in the Wrangler config (DOs share Workers limits).
- Crucially: **each incoming HTTP request or WebSocket message resets the CPU budget to 30 s** — a long-lived WebSocket session gets a fresh budget per message, not one shared pool. Between messages, consuming >30 s of compute raises eviction risk.
- Source: https://developers.cloudflare.com/durable-objects/platform/limits/ (footnotes 4 and 7)

### The "10 ms per DO wake" claim — NOT verified
- No current doc describes a per-wake 10 ms CPU limit for DOs. The 10 ms figure is the **Workers Free plan** per-request CPU limit. DO invocations (HTTP request, WebSocket message, or Alarm) default to 30 s CPU.
- Source: https://developers.cloudflare.com/durable-objects/platform/limits/ · https://developers.cloudflare.com/workers/platform/limits/

### Daily CPU / request limits
- Free: **100,000 requests/day** (resets midnight UTC; overage → Error 1027).
- Paid: **no daily request limit** documented.
- Source: https://developers.cloudflare.com/workers/platform/limits/

### Wall-clock (duration) limits
| Invocation | Wall time |
|---|---|
| HTTP request / DO (RPC/HTTP/WebSocket) | **Unlimited** while client stays connected |
| `waitUntil()` after response | extends up to **30 s** |
| Cron Trigger | **15 min** |
| Queue consumer | **15 min** |
| DO alarm handler | **15 min** |
| Workflow step | Unlimited (CPU-limited) |

- Source: https://developers.cloudflare.com/workers/platform/limits/ · https://developers.cloudflare.com/durable-objects/platform/limits/

### Other 2025–2026 limit changes relevant here
- **2025-10-31**: WebSocket message size limit raised **1 MiB → 32 MiB** (Workers, DOs, Browser Rendering).
  Source: https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/
- **2026-02-11**: subrequest cap raised from 1,000 to **10,000 default (Paid), configurable up to 10 million** via `limits.subrequests`; Free stays 50 external / 1,000 internal.
  Source: https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/
- **2026-06-19**: outbound `connect()` / outbound WebSocket connections now keep a DO alive — but only for a **maximum of 15 minutes**; after that the connection continues but stops preventing eviction (70–140 s inactivity window resumes).
  Source: https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/

---

## 3. Memory, script size, KV values, subrequests, external fetch limits

| Item | Limit | Source |
|---|---|---|
| **Memory per isolate** (Workers & DOs) | **128 MB** (JS heap + WASM); per-isolate, not per-request | [workers/platform/limits] |
| On exceed | in-flight requests finish, new isolate created; outcome `exceededMemory`, Error 1102 | [workers/platform/limits] |
| Worker size (compressed) | **3 MB (Free) / 10 MB (Paid)** | [workers/platform/limits] |
| Worker size (uncompressed) | 64 MB (both plans) | [workers/platform/limits] |
| Startup (global scope) | **1 second** (else error 10021) | [workers/platform/limits] |
| Environment variables | 128/Worker (Paid), 5 KB each | [workers/platform/limits] |
| KV value size | **25 MiB** | [kv/platform/limits] |
| KV key / metadata | 512 B / 1,024 B | [kv/platform/limits] |
| KV ops per invocation | 1,000 | [kv/platform/limits] |
| KV writes to same key | 1/sec | [kv/platform/limits] |
| KV namespaces/account | 1,000 | [kv/platform/limits] |
| Subrequests/invocation | **50 (Free) / 10,000 (Paid, up to 10M)**; internal services 1,000 (Free) / 10,000 default (Paid) | [workers/platform/limits] |
| Simultaneous outgoing connections | **6** per invocation (waiting-for-headers phase) | [workers/platform/limits] |
| Request body size | 100 MB (Free/Pro), 200 MB (Business), 500 MB (Enterprise) | [workers/platform/limits] |
| Response body size | no enforced limit | [workers/platform/limits] |
| URL / header size | 16 KB / 128 KB (total) | [workers/platform/limits] |
| Log data per request | 256 KB | [workers/platform/limits] |

- **"Container memory"**: Workers/DOs do not run in per-app containers; the hard memory bound is the 128 MB V8 isolate. A separate product, **Cloudflare Containers** (beta, launched 2025), runs real containers with up to **4 vCPU / 12 GiB** per container — a different execution model, not the workerd runtime.
  Source: https://developers.cloudflare.com/containers/platform-details/limits/

---

## 4. WebSocket support

- **Connections per DO: up to 32,768** via the hibernation API (`acceptWebSocket`); "CPU and memory usage of a given workload may further limit the practical number."
  Source: https://developers.cloudflare.com/durable-objects/api/state/
- **Message size**: 32 MiB (received messages) since 2025-10-31 (was 1 MiB).
  Source: https://developers.cloudflare.com/durable-objects/platform/limits/ · https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/
- **Connection duration — the "8760 hours" figure is NOT in current docs.** No current Cloudflare doc (DO limits, Workers WebSocket API, network WebSockets) states an 8,760 h / one-year cap. What the docs do say:
  - Hibernation keeps connections connected across object eviction; "the runtime decides if and when to transition the object to the inactive state."
  - Cloudflare network **restarts during code releases terminate WebSocket connections** ("When Cloudflare releases new code to its global network, we may restart servers, which terminates WebSockets connections").
  - The network **closes idle WebSocket connections** after a period with no traffic in either direction (idle timeout; Enterprise can configure a custom one) — heartbeats recommended.
  - Sources: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ · https://developers.cloudflare.com/network/websockets/ · https://developers.cloudflare.com/workers/runtime-apis/websockets/
- **Non-hibernating** WebSockets pin the DO in memory and accrue duration charges for as long as they stay connected.
  Source: https://developers.cloudflare.com/durable-objects/examples/websocket-server/
- **Outbound** WebSockets/TCP keep the DO alive at most **15 minutes** (changelog 2026-06-19), then the connection continues but no longer prevents eviction.
  Source: https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/
- Ping/pong is handled by the runtime without waking hibernated objects — heartbeats are free.
  Source: https://developers.cloudflare.com/durable-objects/best-practices/websockets/

### Viable long-lived session host?
Yes with caveats: hibernation makes idle connections cheap (no GB-s accrual), each incoming message resets the 30 s CPU budget, and 32,768 connections/DO is generous. The blocking caveats are eviction (10 s / 70–140 s inactivity), forced restarts on deployments and runtime updates, no shutdown hooks, and the 15-min outbound-connection limit for outbound streams (e.g., an LLM streaming over TCP).

---

## 5. CRITICAL: child processes, native binaries, node:child_process, node:fs, npm packages

### No child processes, no native binaries — ever
- workerd executes **V8 isolates**, many per process. "Cloudflare's guest programs are **not native binaries**"; the layer-2 sandbox uses namespaces + seccomp to **block all filesystem syscalls** and network; all I/O is mediated by out-of-process proxies over UNIX sockets. There is no API to spawn a process or touch a real filesystem.
- Source: https://developers.cloudflare.com/workers/reference/security-model/
- Workers accept **JavaScript and WebAssembly only**; uploaded native executables are not supported (packages requiring `.node` bindings or node-gyp compilation are incompatible).
- Source: https://developers.cloudflare.com/workers/reference/security-model/ · https://developers.cloudflare.com/workers/runtime-apis/nodejs/

### node:child_process
- `node:child_process` is a **non-functional stub**: it can be imported under `nodejs_compat` (auto-enabled at compatibility date ≥ 2026-03-17) but its APIs do not provide real process execution — polyfilled/stub calls either no-op or throw.
- Source: https://developers.cloudflare.com/workers/runtime-apis/nodejs/ (stub table) · https://developers.cloudflare.com/workers/configuration/compatibility-flags/

### node:fs
- `node:fs` is **supported, but backed by an in-memory virtual filesystem**: `/bundle` (read-only, files in the Worker bundle), `/tmp` (writable but **unique per request, not persistent**), and character devices (`/dev/null`, `/dev/random`, `/dev/full`, `/dev/zero`).
- All VFS contents **count toward the 128 MB memory limit**; exceeding it terminates the instance. Max file size 128 MB; path length 4,096 chars; 48 path segments; timestamps pinned to epoch; `fs.watch`/`fs.watchFile` unsupported.
- Source: https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/

### npm packages
- **Pure-JS/WASM npm packages run** (bundled by Wrangler/esbuild). Native addons (`.node` files, node-gyp) do not build or run. Anything depending on child processes, sockets beyond the TCP/HTTP APIs, or a real filesystem fails.
- **Bun-style binaries**: no — there is no binary execution at all; "binaries" must be replaced with pure-JS or WASM equivalents.
- Practical mitigation documented by Cloudflare: use a pure-JS/WASM version of the dependency, compile to WebAssembly, or move native/process-bound work to a separate service.
- Source: https://developers.cloudflare.com/workers/reference/security-model/ · https://developers.cloudflare.com/workers/runtime-apis/nodejs/

---

## 6. Cron Triggers and Durable Alarms

### Cron Triggers
- 5-field cron (Quartz-like extensions), **UTC**, minimum granularity **once per minute** (no sub-minute schedules).
- Source: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Limits: **5 per account (Free) / 250 per account (Paid)**; wall time **15 min**; CPU per trigger 10 ms (Free) / 30 s (<1 h interval) or 15 min (≥1 h interval) (Paid).
- Source: https://developers.cloudflare.com/workers/platform/limits/

### Durable Object Alarms
- `setAlarm(timestampMs)` — arbitrary future time in ms since epoch; **one alarm per DO at a time** (a new `setAlarm` overrides); recurring work is done by re-scheduling inside `alarm()`.
- **At-least-once** execution; automatic retries with exponential backoff starting at **2 s**, up to **6 retries**.
- Alarm handler wall time: **15 min**; CPU per invocation: 30 s default / 5 min max (same as DO request).
- `alarm()` never runs concurrently per object; on object restart it may re-run from the beginning.
- Source: https://developers.cloudflare.com/durable-objects/api/alarms/ · https://developers.cloudflare.com/durable-objects/platform/limits/

---

## 7. Companion products (one line + hard limit)

| Product | One-liner | Relevant hard limit | Source |
|---|---|---|---|
| **R2** | S3-compatible object storage (no egress fees) | 5 TiB/object (4.995 TiB), 1M buckets/account, 1 write/sec to same key | [r2/platform/limits] |
| **D1** | Serverless SQLite database built on DOs | 10 GB/database, 50,000 DBs/account (Paid), 1 TB/account, 30 s max query duration | [d1/platform/limits] |
| **KV** | Global eventually-consistent key-value cache | 25 MiB values, 512 B keys, 1,000 ops/invocation, 1 write/sec/key | [kv/platform/limits] |
| **Queues** | Durable message queue with Worker consumers | 128 KB messages, 14-day retention, 5,000 msg/s per queue, 25 GB backlog, 15-min consumer wall time | [queues/platform/limits] |
| **Workers AI** | Serverless GPU inference (models incl. Llama, Kimi) | Per-model RPM caps: ~720–3,000 default; some frontier models 20 RPM (50 RPM with prepaid AI Gateway credits) | [workers-ai/platform/limits] |
| **AI Gateway** | Proxy/observability layer for any AI API (caching, rate limiting, retries, fallback, analytics) | No hard platform limits published in docs; rate limiting is a user-configurable feature | https://developers.cloudflare.com/ai-gateway/ |
| **Hyperdrive** | Connection pooler + query cache in front of existing Postgres/MySQL/Redis | 25 configs/account (Paid), ~100 origin connections/config, 60 s max query, 50 MB max cached response | [hyperdrive/platform/limits] |

---

## Top 10 constraints that would block running a long-lived interactive agent loop

1. **No subprocesses, no native binaries, no real filesystem.** `node:child_process` is a non-functional stub; node-gyp/.node addons cannot build or run; `node:fs` is an in-memory VFS scoped per-request under `/tmp`. Any agent tooling that shells out, runs a CLI binary, or uses native packages simply does not work; everything must be pure JS/WASM. (security-model, nodejs compat, nodejs/fs)
2. **128 MB memory ceiling per isolate.** Agent state, conversation context, buffers, and any cached data all live in one 128 MB V8 heap; exceeding it kills the isolate (in-flight requests finish, then a fresh isolate with no in-memory state). (workers/platform/limits)
3. **30 s CPU per DO invocation (default; max 5 min).** Each wake (HTTP request or WebSocket message) gets a fresh 30 s budget, but a single turn of heavy compute (parsing, tokenization, tool-result processing) is capped; sustained compute between messages risks eviction. (durable-objects/platform/limits)
4. **Eviction is frequent and hookless.** Hibernateable objects are evicted after ~10 s idle; non-hibernateable after 70–140 s; there are **no shutdown hooks**, so all durable progress must be written incrementally to storage or it is lost on restart. (durable-objects/concepts/durable-object-lifecycle)
5. **Deployments and runtime updates force restarts.** Every code deploy and Cloudflare network restart terminates WebSocket connections and resets objects; in-flight requests get up to 30 s during runtime updates. A 24/7 agent session must tolerate disconnects and reconnect logic. (durable-objects/concepts/durable-object-lifecycle, network/websockets)
6. **Single-threaded serial execution per object.** One object is one event loop: ~1,000 req/s soft ceiling, queued-then-overloaded behavior; every interaction with "the agent" funnels through one serial execution point unless the design shards state across many objects. (durable-objects/platform/limits)
7. **10 GB storage per SQLite-backed DO, 2 MB per row/value.** Long-lived agent memory/history/transcripts must fit in 10 GB and be chunked under 2 MB records; the 2 MB combined key+value cap also applies to KV-style `put()`. (durable-objects/platform/limits)
8. **Outbound connections keep the object alive for only 15 minutes.** LLM token streams or tool calls over outbound WebSockets/TCP stop preventing eviction after 15 min — long agent turns streaming from a model can be cut by eviction mid-stream. (changelog 2026-06-19)
9. **Subrequest and connection caps bite on tool-heavy turns.** 10,000 subrequests/invocation (Paid default) and 6 simultaneous outbound connections bound multi-tool-call turns; the Free plan's 50 subrequests and 10 ms CPU make any real agent loop effectively Paid-only. (workers/platform/limits)
10. **No durable timers beyond one alarm per object and minute-granularity cron.** An agent loop needs scheduled self-wakes: Cron Triggers bottom out at once-per-minute, and a DO holds only one alarm at a time (self-rescheduling required) with 15-min alarm wall time. (workers/configuration/cron-triggers, durable-objects/api/alarms)

Secondary (non-blocking) limits: script size 10 MB compressed (Paid), 1 s startup, 32,768 WS connections/DO, 32 MiB WS messages, 128 env vars.
