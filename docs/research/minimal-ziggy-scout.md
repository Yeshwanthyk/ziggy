# Ziggy — minimal architecture

A folder that is an assistant. Drop the binary, `ziggy init`, shape `SOUL.md`, talk to it. Zero tokens while idle. Local first; channels and automations after local chat works.

Two standing principles: the Profile is plain visible files — open the folder and grok the whole assistant at a glance. And every face — TUI, CLI, gateway channels (Telegram first; Slack, GUI, anything after) — talks to the same client-neutral core; nothing is gated to one client.

One Bun/TypeScript package wrapping the published `@earendil-works/pi-coding-agent@0.82.0` (pinned exactly). Pi owns agent infrastructure; Ziggy owns Profile policy and product composition. Effect v4 throughout Ziggy application code; Pi's Promise API converted once inside a single adapter.

Start local and in-process: `init`, TUI, CLI. No daemon, attach client, socket protocol, replay layer, or compiled-executable gate. A resident gateway arrives only when the first channel needs an independent lifetime; from then on the gateway owns live sessions for its Profile and local faces attach.

## Ownership

**Pi owns:** loop execution, model/provider implementations, auth mechanics, session JSONL (append-only tree, compaction, branching), tool execution, skill parsing and progressive disclosure, event stream, interactive TUI, print mode, RPC mode.

**Ziggy owns:** Profile discovery/init policy; which Pi resources are admitted; `SOUL.md`, `MEMORY.md`, `USER.md`, Profile agent and automation files, later channel routing; Effect services and typed product errors; parent/child session relation policy; process ownership once a gateway exists; command naming and user-facing composition; and the repository-owned Pi packages under `extensions/`. A package may contain progressively loaded Agent Skills, executable Pi extensions, or both. One hidden internal Pi extension shapes the TUI.

Every production Profile agent execution uses a persistent Pi session manager. A successful direct agent or tagged automation run materializes one root JSONL; a successful `agent_run` or `agent_discuss` participant materializes one child whose Pi header points to the parent session file. The successful parent Pi tool result keeps only bounded output, nested usage, and a child session reference. The isolated child JSONL keeps the complete transcript. Pi v0.82.0 creates JSONL lazily on the first assistant message, so an earlier failure or cancellation can leave no file through the public API. Ziggy does not fabricate transcript entries, copy transcripts, or maintain a second session registry.

## Adapter recipe

The one Pi-importing adapter constructs a runtime per Profile:

1. Resolve `profilePath`; use it as both Pi `cwd` and `agentDir`.
2. `SessionManager.create(profilePath, join(profilePath, "sessions"))` — Pi supports a custom session directory; its JSONL is already append-only, tree-structured, versioned.
3. `createAgentSessionServices({ cwd: profilePath, agentDir: profilePath, resourceLoaderOptions })` → `createAgentSessionFromServices(...)` → `createAgentSessionRuntime(...)`.
4. Before constructing Pi, decode `<profile>/extensions.json` (missing means no optional packages), validate only the required and selected packages from their `package.json#pi` manifests, and close over the resolved paths. Full-shelf validation belongs to offline list/show and repository checks, so a broken unselected package cannot block a Profile. Keep Pi discovery disabled. Skills load Profile-local first, required `pi-packages` second, required `extension-authoring` third, then selected optional packages in ID order. Executable paths come only from required or selected package manifests. Selection changes apply only to a newly opened runtime or restarted resident process.
5. Use Pi's `ModelRuntime` and `SettingsManager` pointed at Profile-local `auth.json`, `models.json`, and settings. No Ziggy provider or session formats.

See `docs/research/pi-sdk-surface.md` for exact signatures.

## Shape

One package, source directories, no workspaces:

```text
faces/{init,tui,cli}   ->  application/ZiggyAgent (Effect service)
application            ->  domain schemas/errors/policies
application            ->  adapters/pi/PiAgent (only Pi SDK importer)
adapters               ->  filesystem/Bun + published Pi SDK
```

`ZiggyAgent` is client-neutral: open a Profile, submit/steer/abort a Session, observe events, close resources. The TUI face delegates to Pi `InteractiveMode`; the CLI face delegates to `runPrintMode`. The gateway later invokes the same application service in-process.

```text
face -> ZiggyAgent Effect -> PiAgent adapter -> Pi AgentSessionRuntime Promise API
                                             -> Profile-local files / model network
```

Only the adapter imports Pi. Only executable entrypoints run Effects.

## Surface

```text
ziggy init <name|path>       create a Profile (SOUL.md); names resolve under ~/.ziggy/profiles
ziggy <name|path>            open the Profile in the TUI
ziggy run [-c] <name|path> "…"   one-shot answer; -c continues the latest session
ziggy wake <name|path> <id>  manually wake an automation (gate can stop it before any model call)
ziggy sessions list <name|path>              list safe Pi session metadata
ziggy sessions show <name|path> <id|path>    inspect lineage, usage, changes, and state
ziggy serve <name|path>      run the resident Profile owner (scheduler + configured channels)
ziggy serve status <name|path>  inspect resident owner/PID state without mutation
ziggy gateway <name|path>    compatibility alias for serve
ziggy profiles               list known Profiles (registry: ~/.ziggy/profiles.list)
ziggy extensions list        inspect the offline package shelf
ziggy extensions show <id>   inspect one package without importing its code
ziggy extensions add <profile> <id>      select an optional package
ziggy extensions remove <profile> <id>   unselect an optional package
```

## Primitives, in build order

Each primitive ships with one walking-skeleton proof before the next begins.

1. **Profile** — path is identity; `init` is idempotent and never overwrites changed human content. Creates `SOUL.md` only; Pi-owned files appear when Pi needs them. *Proof:* `ziggy init` twice — first creates, second refuses to clobber.
2. **Provider** — Pi's provider/model/auth vocabulary unchanged; a Provider never owns a loop. *Proof:* one non-persistent, no-tools prompt via `SessionManager.inMemory()` returns streamed text or a typed config/provider error.
3. **Session** — Pi's Profile-local `SessionManager`; client-neutral prompt/steer/abort/events. Read-only list/show recursively project only path, IDs, lineage, timestamps, entry counts, model/thinking changes, usage, and terminal state; they reject symlinked roots/files and never expose transcript content. *Proof:* one TUI turn, exit, resume the same JSONL session via CLI print; filesystem snapshots prove list/show create and rewrite nothing.
4. **Memory** — retained facts separate from transcripts, all plain markdown in the Profile. `MEMORY.md` is assistant-wide; `memory/users/<id>.md` is per-person and loaded only in 1:1 contexts; `memory/groups/<id>.md` is shared per group and is the only extra memory loaded in group contexts — individual user memories never leak into groups. Capped, reject-on-overflow, never silent truncation. *Proof:* a Ziggy-owned Pi tool atomically replaces a bounded memory doc mid-chat; the next session sees the fact via prompt context; transcript untouched. A session-recall package may build a disposable projection of Pi JSONL, but it is never a second memory or compaction authority.
5. **Extension** — each `extensions/<id>/` folder is a shelf package containing skills, executable extension code, or both. `<profile>/extensions.json` is the sole optional-package selection authority; `pi-packages` and `extension-authoring` remain mandatory. Selection admits the package as one manifest-declared unit, with Profile-local skill precedence and no ambient resources. All faces share this resolver through one Profile runtime construction path. *Proof:* missing and invalid selections fail closed as specified, collisions favor Profile skills, selected package tools load from direct paths, list/show stay offline, and atomic add/remove changes only the selection file.
6. **Gateway** — first resident process; first channel is Telegram, with embedded `ZiggyAgent` in-process. Channel adapters are thin: receive message, resolve context (1:1 vs group) for memory admission, invoke the core, deliver the reply. *Proof:* one owner-authorized Telegram message in, one reply out; gateway exclusively owns live sessions.
7. **Automation** — file-authored triggers with a cheap wake-gate; a run gets a fresh session. *Proof:* gate false → zero model calls; gate true → fresh session + one result through the existing delivery face.
8. **Profile Agent** — `agents/<id>.md` is the sole role/model/reasoning/tool policy authority. Every face discovers and selects agents identically; a leading `@agent-id` is validated before a provider call and guides the parent model. Children cannot use `memory_write`, `agent_run`, or `agent_discuss`, and discussion children have no tools. *Proof:* a completed parent tool call has one linked child JSONL, and one completed direct run has one root JSONL with matching resolved policy.

Invariants carried throughout: no durable fact has two writable authorities; Session owns history, Memory owns facts; no LLM call without user input or a passed wake-gate; client disconnect is not cancellation.

## Baseline

Pinned exactly: `@earendil-works/pi-coding-agent@0.82.0`, `effect@4.0.0-beta.99`, `@effect/platform-bun@4.0.0-beta.99`, `@effect/tsgo@0.21.0`, `typescript@7.0.2`, Bun `1.3.13`, exact `oxfmt`/`oxlint`.

Effect usage: `Context.Service` for capabilities, Layers for construction, Schema decoding at filesystem/CLI boundaries, `Schema.TaggedErrorClass` for expected failures, scopes/acquire-release for runtime ownership. Each Pi Promise wrapped once with `Effect.tryPromise`; no native Promises escape Ziggy services. Small total functions stay plain expressions inside services.

Per slice: the walking-skeleton proof, tests only for a real invariant or regression, then `oxfmt` + stock `oxlint` + typecheck. Nothing else.

## Not building

Custom agent loop, provider abstraction, or session engine. Multi-package workspaces. Daemon/attach/reconnect before a channel needs residency. Custom lint rule suites. Stage manifests, evidence bundles, verifier agents, scenario registries, coverage-driven Pi mocks, or a custom network protocol.
