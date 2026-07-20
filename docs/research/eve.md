# eve — architecture reference

One-line summary: eve (Vercel) is a filesystem-first framework for durable AI agents — path-derived identity (no name/id fields), sessions built as durable Workflow-SDK executions that survive process restarts, a two-context sandbox security model, and an NDJSON event stream with absolute-index replay.

Date: 2026-07-19
Source: `github.com/vercel/eve` (main) — local cache `/Users/yesh/.opensrc/repos/github.com/vercel/eve/main`

## What eve is

"eve is a filesystem-first framework for durable AI agents. Core agent capabilities live in conventional locations, so projects are easier to inspect, extend, and operate." A typical project:

```text
my-agent/
└── agent/
    ├── agent.ts            # Optional: model and runtime config
    ├── instructions.md     # Required: the always-on system prompt
    ├── tools/               # Optional: typed functions the model can call
    ├── skills/              # Optional: procedures loaded on demand
    ├── channels/            # Optional: message channels (HTTP, Slack, Discord)
    └── schedules/           # Optional: recurring cron jobs
```

## Filesystem-as-config: path is identity

The single most load-bearing convention: **you never write a `name` or `id` field on a `define*` call.** Identity comes entirely from the file path eve discovers it at:

| Path                                  | Resolves to           |
| ------------------------------------- | --------------------- |
| `agent/tools/get_weather.ts`          | tool `get_weather`    |
| `agent/connections/linear.ts`         | connection `linear`   |
| `agent/skills/summarize.md`           | skill `summarize`     |
| `agent/subagents/researcher/agent.ts` | subagent `researcher` |

The root agent's own name comes from the enclosing `package.json` `name` (falling back to the app-root directory name). A subagent takes its name from its directory. This is the direct precedent for ziggy's "every durable thing is a human-readable file whose path is its identity" invariant — eve applies it uniformly across every primitive, not just memory/session files.

## The full primitive set (slot table)

Every directory under `agent/` is an authored _slot_; the slot a file lands in determines how eve loads it. Slots (from `docs/reference/project-layout.md`):

- `agent.ts` — runtime config (model, modelOptions, compaction, build, experimental). Subagents: yes.
- `instructions.md` / `instructions.ts` / `instructions/` — base system prompt. Static sources compose at build time; dynamic sources (`defineDynamic` + `defineInstructions`) resolve at runtime. Required on root, optional on subagents.
- `instrumentation.ts` — telemetry config (OTel exporter, AI SDK span settings). Root-only.
- `channels/` — HTTP/messaging entrypoints. Root-only.
- `connections/` — external service connections (MCP, OpenAPI); one per file, name derived from filename. Subagents: yes.
- `hooks/` — lifecycle/stream-event subscribers, module-backed only, recursive dirs supported. Subagents: yes.
- `skills/` — on-demand procedures: flat markdown, module-backed, or packaged skills (with `references/`/`assets/`/`scripts/` siblings under the skill dir). Subagents: yes.
- `lib/` — shared authored helper code, import-only, never mounted into the sandbox workspace. Subagents: yes.
- `sandbox.ts` (definition-only override) or `sandbox/sandbox.ts` + `sandbox/workspace/**` (also seeds files, mirrored into `/workspace/...` at session bootstrap). Framework default applies if neither authored. Subagents: yes (each gets its own sandbox).
- `tools/` — typed executable integrations, module-backed only. Subagents: yes.
- `schedules/` — recurring jobs; each is `<name>.ts` (default-exported `defineSchedule`) or `<name>.md` (frontmatter `cron:` + prompt body). Recursive nesting supported. Root-only.
- `subagents/<id>/` — specialist child agents; each is its own local package reusing the same `agent.ts` shape as root, but a declared subagent inherits _nothing_ from the root and discovers its own slots independently. `agent.ts` there is required and must declare a `description` (the parent reads it to decide when to delegate). `channels/` and `schedules/` are not supported inside local subagents. Nested subagents are supported.
- `extensions/` (`docs/extensions.md`) — mount points for reusable npm/local packages that bundle tools/connections/skills/instructions/hooks. See Extensions below.

A **flat layout** (app root == agent root, no `agent/` subdirectory) is supported but the nested layout is preferred to keep the app root separate from the authored surface. `eve info` prints discovery diagnostics when a file isn't picked up as expected — this "explain why a file wasn't discovered" tooling is worth ziggy replicating for its own filesystem-first discovery of extensions/automations.

## Session → turn → step durability nesting

Work nests in three levels, and every turn runs as a **durable workflow** on the open-source Workflow SDK (Vercel Workflow when deployed on Vercel):

- **session** — the whole durable conversation/task; long-lived, can span days/weeks across many requests without losing context.
- **turn** — one user message and all the work it triggers (model calls, tool calls, reasoning) until the agent produces its response.
- **step** — a durable checkpoint inside a turn: one model call plus the tool calls it makes.

eve checkpoints progress and serializes durable state at each step boundary; user tool code runs inside a managed step so tools/sandbox/subagents feel synchronous even though the session underneath is durable. Crash the process, hit a timeout, or redeploy mid-turn: the run picks up from the last completed step, not a full turn replay — completed steps never re-run (recorded results replay instead); a step interrupted mid-execution _does_ re-run, so non-idempotent side effects (charges, emails) need idempotency or an approval gate. "There's nothing to configure. eve owns the workflow lifecycle, and sessions are durable by default." This full durable-step-replay model is heavier machinery than ziggy needs/wants (ziggy explicitly does not depend on a Workflow-SDK-style durable-step engine), but the session/turn/step _vocabulary_ and the "checkpoint boundary = step" mental model directly informed ziggy's own Turn/Step nouns.

**Parked work**: a turn parks durably when waiting on a human approval, an interactive OAuth sign-in, or a long-running subagent — the workflow suspends and holds no compute until the awaited input arrives, then resumes exactly where it left off, even much later.

## The world seam: `@workflow/world-local` vs `@workflow/world-vercel`

The Workflow SDK is not inherently tied to Vercel. In local dev and in a self-deployed `eve start` process, eve uses the SDK's **local world** by default — it persists workflow runs on disk under `.eve/.workflow-data` and dispatches through the same Nitro-hosted workflow routes used in production. On Vercel, the same workflow code runs against **Vercel Workflow** instead, which adds platform features (latest-production-deployment routing, dashboard run metadata). For self-hosted deployments, `agent.ts` can select an installed Workflow world package via `experimental.workflow.world` (e.g. `@workflow/world-postgres`); custom worlds must implement the runtime protocol eve's vendored `@workflow/*` packages expect (pinned to a specific `5.0.0-beta` line — incompatible protocol versions are rejected at initialization). Nitro hosts the HTTP routes/workflow entrypoints only; it does not supply the workflow state store or the sandbox runtime — those are separate pluggable adapters (Workflow uses the active _world_; Sandbox uses the backend from `agent/sandbox` or `defaultBackend()`). **This local/Vercel world split, with one runtime-protocol contract multiple backends implement, is the direct precedent for ziggy's own local-filesystem-now / Cloudflare-later storage seam** — same shape: one interface, swappable backend, version-gated compatibility check at init.

## Discover → compile → serve pipeline

Corresponding source dirs: `packages/eve/src/discover/` (filesystem walk, manifest, grammar, extension-specifier resolution, skills/schedules/subagent discovery), `packages/eve/src/compiler/` (`compile-agent.ts`, per-slot `normalize-*.ts` files, `model-catalog.ts`, `module-map.ts`, `extension-compatibility.ts`, `artifacts.ts`), `packages/eve/src/runtime/` (resolves the compiled graph into live tools/connections/hooks/skills at request time via `resolve-agent-graph.ts`, `resolve-*.ts` per slot), `packages/eve/src/execution/` (the actual Workflow-SDK-backed turn engine — `turn-workflow.ts`, `session.ts`, `durable-session-store.ts`, `compaction.ts`, `subagent-*.ts`), `packages/eve/src/harness/` (the default agent loop — `tool-loop.ts`, `compaction.ts`, `prompt-cache.ts`, `messages.ts`, `emission.ts`). Discovery produces normalized manifests (`.eve/` artifacts) that the compiler turns into a static module map; the runtime resolves that map per-session. This discover→compile→serve split (static discovery and validation happen once at build, not per-request) is a pattern worth ziggy considering for its own extension-manifest discovery, though ziggy's simpler v1 scope (no build step, no Workflow SDK) doesn't need the full pipeline.

## Two-context security model

Every eve agent runs across two contexts with a hard trust boundary and every secret kept on the trusted side:

|                         | App runtime  | Sandbox               |
| ----------------------- | ------------ | --------------------- |
| `process.env` / secrets | Yes          | No                    |
| Your Node.js code       | Yes          | No                    |
| Network                 | Unrestricted | Controlled by policy  |
| Filesystem              | App's own    | Isolated `/workspace` |

The app runtime is trusted: tool implementations, model calls, connections, state, durable execution — full `process.env` and Node.js. The sandbox is isolated: the model runs shell commands there through built-in `bash`/`read_file`/`write_file`/`glob`/`grep`, gets its own `/workspace`, but no env vars, no secrets, no path back into the app runtime (on Vercel: a Vercel Sandbox microVM with hardware isolation). Critically, **even the built-in file tools live in the app runtime and proxy into the sandbox** — the model only ever sees tool definitions and results, never credentials. Concrete trace: a `charge_card` tool's `execute` runs in the app runtime, reads `process.env.STRIPE_KEY`, calls Stripe, returns `{ ok: true }` — the model sees only the boolean.

Credential brokering lets sandboxed shell commands get _authenticated_ network access (e.g. `git clone` of a private repo) without a dedicated tool: auth headers are injected at the sandbox's network firewall for matching domains, so the secret never enters the sandboxed process. Channel verification rules (constant-time HMAC compare, never trust body-supplied identity) and "authored markdown is data" (skill/schedule frontmatter is parsed as inert YAML; code-capable frontmatter fences are explicitly disabled to prevent `eval()`-on-parse) round out the model. This two-context split is a stronger security model than ziggy needs for local-first v1 (ziggy's extensions run as supervised subprocesses, not a general sandbox), but the "app runtime holds secrets, tool-call boundary is the only channel the model has" principle is directly reusable.

## NDJSON event stream, replay, and the two-handle split

`GET /eve/v1/session/<sessionId>/stream` returns newline-delimited JSON, one event per line. Rich event taxonomy (`session.started`, `turn.started`, `message.received`, `step.started`, `actions.requested`, `action.result`, `input.requested`, `subagent.called`/`completed`, `reasoning.appended`/`completed`, `message.appended`/`completed`, `result.completed`, `compaction.requested`/`completed`, `authorization.required`/`completed`, `step.completed`/`failed`, `turn.completed`/`failed`/`cancelled`, `session.waiting`/`failed`/`completed`). Append-style events (`reasoning.appended`, `message.appended`) carry both the new delta and the cumulative text so far, coalesced under backpressure but never reordered relative to each other (any other event is an ordering barrier).

**Reconnect and rewind**: the stream is durable — every event is recorded before its step completes, so the whole stream is replayable. A nonnegative `startIndex` is an absolute event count (`0` rewinds to the start); a negative `startIndex` reads relative to the tail (`-1` = latest event, typically `session.waiting` for a resumable session) but a tail-relative read does **not** auto-advance the stored cursor. This absolute-index replay contract is the direct model for ziggy's own `seq`-numbered envelope replay requirement on Session event logs (the M9 review finding — envelopes need a persisted `seq` to make this contract honorable).

**The two handles — the single most important transferable lesson**, called out explicitly in eve's own docs as "the most common mistake" to conflate:

- **`continuationToken`** — the _resume handle_. Used to send a follow-up message to the same conversation. **Owned by the channel.** A session has one active continuation at a time; a stale token is rejected; only one active session can own a given continuation token (a tokenless session claims its token after its first turn establishes one; a token-bearing session commits the park hook before processing its first turn and fails a competing session that already owns that token).
- **`sessionId` / `runId`** — the _stream-and-inspect handle_. Used to attach to the event stream and watch a run. **Owned by the runtime.**

This is exactly the distinction ziggy locked in to avoid merlin's Telegram context-loss bug: the channel-owned resume handle and the runtime-owned stream handle must never be merged into one identifier, because a channel (Telegram chat, Slack thread) needs a way to address "continue this conversation" that's independent of whatever internal run/stream identifier the runtime is currently using — conflating them is what broke merlin.

**Message delivery is explicitly not a FIFO queue**: eve does not maintain a durable ordered queue of user messages for a session — `continuationToken` is a resume handle for the current workflow hook, not a message-queue address. When a turn is already active, the hook may accept additional deliveries but the runtime only drains them at specific workflow boundaries, and folding multiple ready deliveries into the next turn is best-effort/timing-dependent. eve's own guidance: send one user turn at a time and wait for `session.waiting` before sending the next; if a channel can receive bursts mid-turn, keep a per-session queue at the channel/app layer and drain it only after the session reparks. This directly informed ziggy's own per-Session mailbox/steer design — the "queue in the channel, not the runtime" split.

## Two-tier schedules and dynamic scheduling

`schedules/<name>.ts` (`defineSchedule`) or `schedules/<name>.md` (YAML frontmatter `cron:` + prompt body) — both root-only, recursive nesting supported. `docs/patterns/dynamic-scheduling.md` covers runtime-created/modified schedules beyond the static build-time set (relevant to ziggy's own "automations are markdown files with frontmatter" design, though ziggy deliberately keeps automations simpler — no dynamic runtime schedule mutation at v1).

## Extension namespacing and override model

An extension packages tools/connections/skills/instructions/hooks as a reusable npm or local package, authored as an agent-shaped directory (no `agent.ts`, no `sandbox` — those stay with the consuming agent). A consuming agent mounts it under `agent/extensions/<name>.ts` (or a directory, for overrides); contributions compose under a **namespace prefix**: `<namespace>__<name>` (e.g. `crm__search`, `crm__api`) — this is exactly how eve prevents a mounted extension's tool names from colliding with the host agent's own tools or another extension's, without requiring the extension author to guess a globally-unique prefix themselves.

Overrides: authoring the mount as a directory instead of a single file lets the consumer add override slots alongside the extension declaration — a same-named file in an override slot composes under the mount namespace and wins on collision (matched by name _and_ kind: a static file replaces a static tool, a dynamic resolver replaces a dynamic one, and a static file does **not** shadow a same-named dynamic tool because dynamic wins over static at runtime regardless of declaration order). `disableTool()` as a file's default export removes a contribution entirely — same disable-by-filename-match convention used for built-in harness tools (see below), and if the filename matches no known tool, resolution fails at build time rather than silently no-op'ing.

Extension config is declared via `defineExtension({ config: <StandardSchema> })`, bound once at mount time (session-constant; per-request values belong in connection auth, not extension config) and read off the imported declaration handle inside the extension's own tool/hook files. `defineState` inside an extension is automatically scoped to the extension's own package, so identically-named state keys never collide with the host agent or a sibling extension.

Publishing splits authoring root (`extension/`) from a build output root (`dist/extension/`) via `eve.extension.{source,dist}` in `package.json`; `eve extension build` transforms every module into an agent-shaped dist tree, copies skill packages/assets, emits type declarations, and writes a `_manifest.json` containing **only** format/build-version/which-capability-versions-are-used — explicitly not compiled tools, schemas, names, or executable definitions (the consuming eve still discovers and normalizes the full dist tree itself; the manifest is a compatibility fingerprint, not an index). `eve` itself is a required wildcard **peer** dependency (one eve instance lives in the consuming app; the extension's `eve/*` imports resolve to it) — but peer semver doesn't gate compatibility; eve validates generated per-capability requirements itself. An extension cannot declare a sandbox, agent-level config, schedules, or limits, and cannot mount other extensions — those stay exclusively the consuming agent's to own.

## Built-in tool override/disable convention

The default harness ships built-in tools (`bash`, `read_file`, `write_file`, `glob`, `grep`, `web_fetch`, `web_search`, `todo`, `ask_question`, `agent` [root-only subagent delegation], `load_skill`, `connection_search`) — each gated on agent/session capability (`agent` only in the root session; `load_skill`/`connection_search` only when skills/connections are declared; `ask_question` only in a session that can request input; `web_search` only for a supporting model provider). **Override** by authoring a file at the same slug — `agent/tools/write_file.ts` replaces the built-in by existing; spreading the default (`{...writeFile, execute: wrapped}`) preserves the framework's own state wiring (e.g. `todo`'s durable state key), while skipping the spread means the replacement owns fresh context and loses that wiring. **Disable** by exporting a `disableTool()` sentinel from a file named after the tool's slug — the filename, not the export, selects which built-in to remove; an unrecognized filename fails the build rather than silently no-op'ing (catches typos at build time instead of accidentally leaving a dangerous tool live).

## Build/dev snapshot hygiene

`.eve/` holds inspectable build artifacts (discovery diagnostics, manifests, compiled module map) and, for local development, `.eve/.workflow-data` (the local Workflow world's on-disk run store). `eve info` surfaces the discovered surface and explains why a given file wasn't picked up as an authored slot — useful debugging affordance for filesystem-first discovery that ziggy's own extension/automation discovery should replicate (a `ziggy doctor`-style "why wasn't this picked up" diagnostic).

## Transferable ideas for ziggy

- **Path-as-identity, no name/id fields on define calls** — directly adopted for ziggy's own "every durable thing is a human-readable file whose path is its identity" invariant.
- **Session → Turn → Step vocabulary and checkpoint-boundary mental model** — informs ziggy's Session/Turn/Step nouns, without adopting eve's full durable-workflow replay machinery (out of scope for ziggy's simpler v1).
- **Local-world vs. platform-world seam with a versioned runtime-protocol contract** — direct precedent for ziggy's local-filesystem-now / Cloudflare-later storage seam.
- **`continuationToken` (channel-owned resume handle) vs. `sessionId`/`runId` (runtime-owned stream handle), never conflated** — the single most directly-borrowed lesson; explicitly the fix for merlin's Telegram context-loss bug.
- **No durable message FIFO in the runtime; bursty channels queue at the channel/app layer and drain only after the session reparks** — informs ziggy's per-Session mailbox/steer design.
- **NDJSON event stream with absolute (and tail-relative) `startIndex` replay** — the model for ziggy's own `seq`-numbered envelope replay contract.
- **Namespaced extension mounting (`<namespace>__<name>`) with a closed set of override primitives (spread-and-wrap, disable-by-filename, directory-mount overrides)** — a concrete naming/collision scheme ziggy's tiered extension system can reuse if/when it needs multi-extension composition beyond v1's simpler manifest+skill tier.
- **Manifest-as-compatibility-fingerprint, not an index** (eve's extension `_manifest.json` carries only format/version info, never compiled definitions) — matches ziggy's own extension manifest design intent.
- **Build-time "why wasn't this discovered" diagnostics (`eve info`)** — a concrete UX pattern for `ziggy doctor`.
