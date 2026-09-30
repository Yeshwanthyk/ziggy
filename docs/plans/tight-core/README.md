# Tight core: how we reshape it

The working plan for rebuilding Ziggy's core, spread across several sessions.
- Start at the first unchecked step in [Work order](#8-work-order).
- Add a line to the [Progress log](#10-progress-log) when you stop.

The per-area evidence (file:line citations, commits, measurements) is in [areas/](areas/). This page is the shape.

---

## 1. What we want

**A small core that just works.**
- It holds the basics: a Profile, a session you can talk to, loading extensions.
- It is structured so it rarely needs to change.

**Everything else builds on top of it.**
- Agents, memory, channels, automations and the web UI all build on the core's public surface.
- None of them reach into core internals.
- New capability arrives as an extension or a module on top, not as more core.

**The code layout mirrors that.**
- One folder per core concept, with one public entry file.
- A change to one concept touches one folder.

**Pi does the agent work.**
- Ziggy adds Profile policy on top.
- It does not re-parse, re-validate or re-guard what Pi already does.

**Effect is used plainly.**
- Services exist only where something is owned: state, a resource, or a real swap.
- Everything else is plain functions returning `Effect`.
- Each layer is defined next to its service.

**Tests.**
- The real CLI and the real resident run against a scripted model server.
- Unit tests stay only for real invariants.
- There is one shared fake.

**We build it piece by piece.**
- One concept at a time, each proven before moving on.
- Faces (web UI, `ui-sdk`, Slack, Discord, Telegram, ACP, CLI) keep working through every step and get reshaped later.

---

## 2. What is in `src/` today

There are about 47.8k lines in total, 1k of which are generated. Tests are 95 files and 32.6k lines.

| Folder | Files | Lines | What's in it |
|---|---:|---:|---|
| `domain/` | 32 | 4.9k | types, errors, pure rules; `profile.ts` is imported by 48 files |
| `application/` | 53 | 14.3k | services, plus the Slack, Discord and UI gateways |
| `adapters/pi/` | 31 | 9.2k | everything that touches Pi: sessions, agents, extensions, memory tool |
| `adapters/fs/` | 14 | 4.1k | file formats and stores |
| `adapters/bun/` | 17 | 5.2k | SQLite, locks, launchd, HTTP server |
| `adapters/slack, discord, telegram, terminal, github` | 12 | 3.5k | transports |
| `faces/` | 15 | 3.1k | CLI and ACP |
| `main.ts`, `composition.ts` | 2 | 1.1k | entry and layer wiring |

**The core problem is visible in the layout: every concept is spread across 5 to 7 folders.**

| Concept | Files today | Lines | Folders it lives in |
|---|---:|---:|---|
| Extensions | 18 | 6.7k | domain, application, application/ui-gateway, adapters/fs, adapters/pi, adapters/bun, adapters/github, adapters/terminal, faces |
| Sessions (open, run, list, lease) | 13 | 5.3k | domain, application, application/ui-gateway, adapters/pi, faces |
| Agents / specialists | 10 | 4.2k | domain, application, application/ui-gateway, adapters/pi, adapters/fs, faces |
| Memory | 7 | 1.6k | domain, application, application/ui-gateway, adapters/pi, adapters/fs, faces |
| Profile | 8 | 1.3k | domain, application, adapters/fs, adapters/bun, faces |

We organised the code by layer (domain / application / adapters), so every change crosses all of them. On top of that, the layer rule is not actually held:

- **34 of 53 `application/` files import `adapters/` directly.** For example, `application/sessions.ts` imports three Pi adapter modules. The "application depends only on ports" picture exists only on paper.
- `domain/` is clean: it imports nothing outside itself.
- Pi imports stay in `adapters/pi/`. That rule holds.

---

## 3. Core, and what builds on it

```
            ┌──────────────── faces & gateways (unchanged for now) ────────────────┐
            │  cli · acp · web ui-gateway · ui-sdk · slack · discord · telegram    │
            └───────────────────────────────┬──────────────────────────────────────┘
                                            │ import only index.ts
            ┌──────────── built on the core (modules that add capability) ─────────┐
            │  agents/   memory/   resident/ (live sessions, automations, service) │
            └───────────────────────────────┬──────────────────────────────────────┘
                                            │ import only index.ts
            ┌─────────────────────────────── core ─────────────────────────────────┐
            │  profile/   session/   extensions/                                   │
            └───────────────────────────────┬──────────────────────────────────────┘
                                            │
                                   platform/ (paths, file lock, atomic write)
```

**The core is three folders:**
- `profile/`: a Profile on disk, its model and its auth.
- `session/`: open a Profile session, talk to it, read it back.
- `extensions/`: which Pi packages a Profile loads.

**Agents and memory become modules on top.**
- They add Pi tools (`agent_run`, `agent_discuss`, `memory_write`) and a little policy.
- They use the core's `session/` and `extensions/` public surface, like any extension would.
- They register their tools through one core seam: the list of in-process tools the runtime installs.
- Today, `pi-agent.ts` and `specialist.ts` hard-wire them into session construction.

This is what keeps the core from growing: the next capability plugs into that seam instead of editing `session/`.

---

## 4. Target layout

The dependency rule applies *inside* each folder:
- `types.ts` holds pure types and errors;
- the service composes;
- `pi.ts` and `store.ts` touch the outside world.

Anything outside a folder imports only that folder's `index.ts`.

```
src/
  main.ts                 the only place Effects run (unchanged role)
  composition.ts          one small layer per command (shrinks; no CliLayer)

  platform/               shared low-level pieces, no Ziggy concepts
    file-lock.ts          the one SQLite BEGIN IMMEDIATE lock (today 6 copies in 4 files)
    atomic-write.ts       write-temp-then-rename (today repeated per store)
    paths.ts              ZiggyPaths

  ── core ──────────────────────────────────────────────────────────────────────

  profile/                a Profile on disk
    index.ts
    types.ts              ProfileTarget, ProfileRef, errors   (split out of domain/profile.ts)
    profiles.ts           init, list (read-only), resolve, registry
    models.ts             model selection + auth (today application/models, auth, adapters/pi/models, auth)

  session/                open a Profile session, talk to it, read it back
    index.ts              ZiggyAgent, ChatHandle, OpenSession, ChatEvent, SessionTool, errors
    types.ts
    runtime.ts            build Pi for a Profile: resources, prompt, extensions, installed tools   [Pi]
    handle.ts             the one ChatHandle: prompt/steer/abort/switch/new/fork/close           [Pi]
    lease.ts              one writer per transcript, held while a handle is open
    agent.ts              ZiggyAgent: open / runOnce                                             [Pi]
    events.ts             Pi events -> ChatEvent (today chat-event-projector)
    tools.ts              the seam: how a module contributes an in-process tool                  [Pi]
    store.ts              read-only: list, show, locate, history (streaming, no writes)

  extensions/             which Pi packages a Profile loads
    index.ts
    types.ts              extensions.json schema, ids, errors
    selection.ts          read/resolve/add/remove (behind the file lock)
    loader.ts             Pi loader options + "skip broken, warn loudly"                         [Pi]
    required.ts           bundled packages unpacked once per Ziggy version
    update.ts             stage, swap, recover
    tool.ts               the profile_extensions tool                                            [Pi]

  ── built on the core ─────────────────────────────────────────────────────────

  agents/
    index.ts
    types.ts              agents/<id>.md schema, placements (root | child | rail), errors
    policy.ts             one resolveAgentPolicy (model, thinking, tools)
    run.ts                runAgent: opens a child through session/                               [Pi]
    tools.ts              agent_run, agent_discuss, contributed via session/tools.ts             [Pi]

  memory/
    index.ts
    types.ts              scopes, caps, errors
    memory.ts             read, update (scope table, file lock, backups)
    tool.ts               memory_write, contributed via session/tools.ts                         [Pi]

  resident/               left in place for now (today application/ gateways + adapters/bun etc.);
                          only live-sessions is rebuilt, the rest changes imports only
  cli/                    today faces/; unchanged except imports; per-area command files continue
```

**Rules that replace the current ones:**

| Rule | Today | Target |
|---|---|---|
| Where Pi may be imported | `adapters/pi/**` | files marked `[Pi]` above. Never `profile/`, `platform/`, `resident/` or `cli/`. |
| Cross-folder imports | anything imports anything | only `<folder>/index.ts`, enforced by an oxlint `no-restricted-imports` rule |
| Direction | faces → application → domain (not held) | cli/resident → agents/memory → core → platform. Core never imports agents, memory or resident. |
| Where Effects run | `main.ts`, plus 16 `Effect.runPromise` calls in `adapters/pi` | `main.ts`, plus **one** documented bridge for Pi tool callbacks (§5) |

**How we get there without a big-bang move.**
- Each step in [§8](#8-work-order) rebuilds one concept straight into its new folder and leaves a one-line re-export at the old path.
- Faces keep compiling throughout.
- The re-exports are deleted in the last step.

---

## 5. Effect patterns

### 5.1 The service syntax, one shape everywhere

Today there are 34 `Context.Service` classes:
- The interface lives in one file and the `…Live` in another, often a `Layer.succeed` of an object of adapter functions.
- `composition.ts` wires them together by hand in 159 lines.
- `CliLayer` builds all 34 for every command.

Target: this is the only way a service is written. It uses `Context.Service`'s `make` option in effect beta.99; `faces/terminal-ui.ts` already uses the `static layer` half.

```ts
// session/store.ts
export class Sessions extends Context.Service<Sessions>()("ziggy/Sessions", {
  make: Effect.gen(function* () {
    const paths = yield* ZiggyPaths;

    const list = Effect.fn("Sessions.list")(function* (target: ProfileTarget) {
      // ...
    });

    return { list, show, locate, history } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(ZiggyPaths.layer));
}
```

- The shape is inferred from `make`, so there is no separate `SessionsApi` interface to keep in sync.
- A service's `layer` provides its own dependencies. `composition.ts` only merges the layers each command needs.
- Public methods use `Effect.fn("Service.method")`, so failures and traces say where they came from. `Effect.fn` is used 0 times today.
- Resources are acquired inside `make` with `Effect.acquireRelease`. The layer is then scoped, and Effect releases them when the program ends.

**Service or plain function.**
- Make it a service when it holds state, owns a resource, or needs its dependencies built once.
- Otherwise export plain functions returning `Effect`. Examples: parsing agent frontmatter, the memory scope table, the extension id resolver.

### 5.2 Every service today and where it goes

| Service today | Where | Target | Why |
|---|---|---|---|
| `ZiggyPaths` | application | **keep** → `platform/paths.ts` | configuration everyone reads |
| `Profiles` | application | **keep** → `profile/` | the only registry reader and writer |
| `ProfileStore` | application + fs | delete, folded into `Profiles` | one implementation, exists to be faked |
| `Models`, `Auth` | application | **keep** → `profile/models.ts` | wrap Pi's model registry and auth storage |
| `ZiggyAgent` | application | **keep** → `session/agent.ts` | owns building Pi runtimes and handles |
| `PiAgent` | adapters/pi | delete, merged into `ZiggyAgent` | `ZiggyAgentLive` only forwards to it |
| `Sessions` | application | **keep** → `session/store.ts` | read-only sessions, with its summary cache |
| `ProfileExtensions` | application | **keep** → `extensions/` as `Extensions` | selection, resolve, add/remove, update |
| `ExtensionUpdate` | application | folded into `Extensions` | same folder, same data |
| `ProfileExtensionPreflight` | domain (!) | delete | preflight is removed |
| `ProfileExtensionMutationLock` | domain (!) | delete → `platform/file-lock.ts` function | a lock is a function, not a service |
| `ExtensionArchiveClient` | adapters/github | delete | GitHub catalog is deleted |
| `ExtensionHealth` | application | delete → `extensions/loader.ts` function | one implementation |
| `ProfileAgents` | application | **keep** → `agents/` as `Agents` | agent definitions + run |
| `Memory` | application | **keep** → `memory/` | read/update |
| `MemoryFiles` | adapters/fs | delete, folded into `Memory` | one implementation |
| `ChatRegistry` | application | **keep**, rebuilt → `resident/live-sessions.ts` as `LiveSessions` | owns the open handles |
| `Doctor` | application | keep (CLI) | |
| `DoctorChecks` | application | delete, folded into `Doctor` | one implementation |
| `Setup`, `SelfUpdate`, `TerminalStyle` | application / faces | keep, untouched | not core |
| `ZiggyReleaseClient` | adapters/github | keep for now | not core |
| `ResidentService` + `ResidentServiceOperations` | application + bun | merge into one | ops has one implementation |
| `Gateway`, `SlackGateway`, `DiscordGateway`, `ResidentGateway`, `UiGateway` | application | untouched | faces; reshaped later |
| `Automations`, `AutomationScheduler`, `AutomationDefinitions` | application | untouched except delivery routing | resident, not core |

**Result.**
- The core has 7 services: `ZiggyPaths`, `Profiles`, `Models`, `Auth`, `ZiggyAgent`, `Sessions` and `Extensions`.
- The modules on top have 2: `Agents` and `Memory`.
- Resident and faces keep theirs for now.
- 10 services are deleted.

### 5.3 Running Effects inside Pi callbacks

Today there are 16 `Effect.runPromise` calls outside `main.ts`:
- **10 exist only to move the session lease during switch, new and fork.** They are in `chat-runtime-binding.ts`, `pi-agent.ts` and `specialist.ts`.
- **5 are Pi tool `execute` callbacks**, which Pi calls with a Promise.

Target:
- The lease gets a synchronous acquire/release, so those 10 disappear.
- Tool callbacks go through one helper in `session/tools.ts`. When the runtime is built, it captures the services with `Effect.context<R>()`. Each tool runs `Effect.runPromiseWith(context)(effect, { signal })`.
- This is the single written exception to "only `main.ts` runs Effects". It goes into `effect-runtime-boundaries/SKILL.md`.

### 5.4 Resources and concurrency

Today:
- Leases, runtime locks, extension locks and a `WeakMap` reset lock are hand-rolled with Promise bridges.
- There are 36 `Semaphore` mentions and only 7 `acquireRelease`.
- One web resume passes through 8 layers of serialization.

Target:
- Anything that must be released is `Effect.acquireRelease` in a `Scope`: a session lease, an open handle, the resident's sockets.
- One semaphore per `ChatHandle`, plus Pi's own "already prompting" check.
- The resident's registry takes a short permit to look up or insert a handle, never around handle I/O.

### 5.5 No test seams in production types

Today:
- `registry?` is optional in 10 places plus `automations.ts:64`.
- `currentSession?`, `appendAutomationResult?` and `Sessions.history?` are optional.
- `makeChatHandle` lives in `src` with 0 production callers.

Target: every member is required, and fakes live in `test/harness/`. An optional member means the feature is optional.

### 5.6 Errors and boundaries

Errors:
- There are 94 `Schema.TaggedErrorClass`: the right tool. The rule to hold: **one error class per distinct recovery path**.
- Merge candidates: the six `Specialist*` errors, and `UiGatewayError` leaking into Telegram.

Boundaries are already mostly right: one `JSON.parse` and no double casts. What's left is duplicate validation of things Pi already validated:
- a second `Value.Check` on agent frontmatter;
- a re-parse of the `pi` manifest.

---

## 6. Each area: what changes

Every area follows the same pattern: what it is for, what went wrong, and what we build instead.

### 6.1 `session/`: core ([evidence](areas/1-session-runtime.md))

**For:**
- A face opens a Profile session and prompts, steers, aborts, switches, starts new, forks or closes it, without knowing Pi exists.
- Only one writer ever touches a transcript.

**What went wrong:**
- `pi-agent.ts` is 1,590 lines. Its four entry points each repeat the lease and Pi setup.
- Every incident added a mechanism: six lease commits in one day brought reservations, a poison flag, pending releases, and a runtime lease on top of the session lease.
- `runtime.ts` and `ZiggyAgentLive` only forward.
- Agent tools are hard-wired into session construction.
- Adding one handle control means editing 7 places in 3 files.

**Build instead:**

| Today | Becomes |
|---|---|
| `application/agent.ts` (204), `adapters/pi/runtime.ts` (50), `pi-agent.ts` (1,590), `chat-runtime-binding.ts` (217) | `session/types.ts` + `agent.ts` + `runtime.ts` + `handle.ts` + `tools.ts` |
| `session-lease.ts` (322), `profile-runtime-lease.ts` (131), `bun/profile-runtime-lock.ts` (85) | `session/lease.ts`, about 100 lines |
| `chat-event-projector.ts`, `prompt-turn.ts`, `provider-failure.ts` | kept, moved into `session/` |
| `sessions.ts`, `session-history.ts`, `session-discovery.ts`, `transcript-lines.ts`, `session-name.ts`, `session-lineage.ts`, `application/sessions.ts` | `session/store.ts` (see 6.5) |

- **One request type.** `open(OpenSession)` replaces the four signatures. `OpenSession` is a record: Profile, session (new, continue or id), model, tools, placement.
- **The tool seam.** The runtime installs whatever tools the modules contributed. `agents/` and `memory/` contribute theirs; `session/` doesn't know what they are.
- **The lease, simply.**
  - An open handle holds one lease on the transcript it is writing to.
  - On switch, new or fork, it takes the lease on the new transcript first, lets Pi move, then releases the old one.
  - CLI `run -c` or `run --session` on a transcript that's open elsewhere is refused, and the message names the holding process.
  - Agent child sessions get no lease, because nobody else can know their id.
- **The handle tells watchers itself.** When it switches, starts a new session or forks, it emits `session-state`. The web face stops pushing a transcript reset under its own lock.
- **CLI one-shot runs keep Pi's print mode**, which returns an exit code. The `console.error` capture goes.

### 6.2 `extensions/`: core ([evidence](areas/3-extensions.md))

**For:**
- Read `extensions.json`.
- Resolve each id to the Profile's shelf or a bundled package.
- Refuse unknown ids.
- Always include required packages.
- Load exactly that set.
- Make broken packages visible.

**What went wrong:**
- 18 files and 6.7k lines of source, plus 3.9k of tests.
- A full Pi "preflight" runs on every open, so modules load up to 4 times.
- A 2-second lock is held during that preflight.
- A "generation fence" serves a feature that never shipped.
- There are two locks plus a runtime lease.
- About 700 lines of GitHub catalog code have zero entries.
- Required packages are copied into every Profile, with receipts.

**Build instead:**

| Today | Becomes |
|---|---|
| `application/profile-extensions.ts` (1,272), `adapters/fs/profile-extensions.ts` (711), `domain/profile-extension.ts` | `extensions/types.ts` + `selection.ts` |
| `profile-extension-preflight.ts`, `profile-extension-diagnostics.ts` | `extensions/loader.ts`: load once, admit Pi's diagnostics |
| `extension-installer.ts`, required-package copies and receipts | `extensions/required.ts`: unpacked once per Ziggy version into a cache folder |
| `extension-update.ts` ×2 | `extensions/update.ts` |
| `profile-extension-tool.ts` (798) | `extensions/tool.ts`, about 150 lines, still in-process |
| `bun/profile-extension-lock.ts` (318) | `platform/file-lock.ts`, around add and remove only |
| `github/extension-catalog.ts`, `domain/extension-catalog.ts`, the tar extractor | deleted |

- **Broken optional package:** skip it and warn loudly, with one rebuild.
- **Required packages from a shared cache.** `ziggy-operations/SKILL.md` links to `references/*.md` by relative path, and embedded files are flattened, so embedding would break those links.
- **`extensions update`:**
  1. Stage the new version into `<id>.new`.
  2. Move the current `<id>` to `<id>.old`.
  3. Rename `<id>.new` to `<id>`.

  At open, if `<id>` is missing and `<id>.old` exists, restore it. The update is refused while the resident is live, and `--restart` stays.
- **The add/remove lock stays**, because the tool, the web picker and the CLI all edit `extensions.json`.

### 6.3 `profile/` and reading sessions: core ([evidence](areas/5-profile-sessions-composition-tests.md))

**For:**
- `init` creates `SOUL.md` once and never overwrites it.
- Listing Profiles or sessions writes nothing.
- A session id resolves to exactly one file.
- `ziggy profiles` starts no resident and no Pi.

**What went wrong:**
- Listing Profiles prunes the registry: a read that writes.
- There are two readers of `profiles.list`.
- `domain/profile.ts` has 48 importers, most needing only `ProfileTarget`.
- There are three parsers for the same JSONL.
- The history cursor hashes the whole file, so any new message invalidates older cursors.
- It counts a `toolCall` entry type Pi never writes and ignores Pi's real `usage` entries.

**Build instead:**
- `profile/profiles.ts` is the only registry reader and writer, and `list` is read-only.
- `session/store.ts` is one streaming line reader (today's `transcript-lines.ts`) with a summary cache.
  - Reads are bounded. Squarey has 316 transcripts totalling 1.1 GB, and the largest is 376 MB.
  - It decodes lines with Pi's entry types, but does not use `parseSessionEntries` (it needs the whole file) or `SessionManager.open` (it writes).
- The session list skips bad files and reports them; `show` stays strict.
- The history cursor becomes "entry index + entry id".

### 6.4 `agents/` and `memory/`: built on the core ([evidence](areas/4-agents-memory.md))

**Agents are for:**
- `agents/<id>.md` is the single source for an agent.
- An agent runs as a root session, a child, or an ACP rail.
- Children never get `memory_write` or the agent tools.

**What went wrong with agents:**
- A throwaway full Pi runtime is built just to pick a model and check tool names.
- The policy is validated in three places that disagree. For example, `tools: profile_extensions` passes validation, then silently disappears in the child.
- Fresh child sessions get leases.
- Frontmatter is checked twice.
- The `agent_run` result is unbounded and appears twice.

**Build agents instead:**
- `agents/policy.ts`: one `resolveAgentPolicy` on Pi's `ModelRuntime.create`.
- `agents/run.ts`:
  - opens a child through `session/`'s public `open`, with forbidden tools excluded;
  - checks that the declared tools are what Pi activated before the first model call;
  - bounds the result.
- `agents/tools.ts` contributes `agent_run` and `agent_discuss` through the seam.
- An agent with no model uses the Profile default.

**Memory is for:** plain markdown files with a scope fence (user / group / Profile), a size cap, and atomic writes.

**What went wrong with memory:**
- The safe read is written three times.
- The lock went through four versions.
- Backups are about 215 lines of hardlinks.

**Build memory instead:**
- `memory/memory.ts` has one scope table, `read`, and `update` behind `platform/file-lock.ts`.
- Symlinks are refused with `O_NOFOLLOW`.
- Backups are the last 5 plain copies, because `memory_write` is reachable from group chats.
- `memory/tool.ts` (about 100 lines) contributes `memory_write` through the seam.

### 6.5 Resident live sessions: built on the core ([evidence](areas/2-resident-live-sessions.md))

**For:**
- One open handle per session, shared by every client.
- A disconnect does not cancel the turn.
- Replay for reconnecting clients.
- A capacity limit.
- Watch-only for channel sessions.
- Close exactly once.

**What went wrong:**
- `chat-registry.ts` (914 lines) became "whatever the resident knows":
  - UI verbs;
  - the destination book;
  - automation delivery;
  - a transcript reset;
  - an Opening/Live/Closing state machine with a delivery fence that holds a global lock across disk and Pi calls.
- The fence predates the session lease and was never removed.

**Build instead:**
- `resident/live-sessions.ts`, about 220 lines: `acquire`, `release`, `get`, `list`, `findBySessionId`, `watch`, `publish`.
- The destination book becomes its own small file.
- Automation delivery to a conversation becomes one function in `automations.ts`.
- UI verbs move to `ui-gateway/sessions.ts`.
- The fence goes, because the lease in 6.1 covers every transcript a handle writes.
- `chat-registry.ts` stays as a re-export until the faces are reshaped.

---

## 7. Verification loop

This is what makes rebuilding safe. Full design: [area 5 §11](areas/5-profile-sessions-composition-tests.md).

### Harness (`test/harness/`)

- **Scripted model server:**
  - a local SSE server speaking the OpenAI chat-completions stream;
  - plugged in through the tmp Profile's `models.json`;
  - scripts replies and tool calls, and can hold a turn open.

  One already exists at `test/adapters/pi/pi-agent.test.ts:628`; it gets extracted.
- `profile.ts`: tmp Profiles, plus a tree hash to prove "nothing changed".
- `cli.ts`: runs the real `bun src/main.ts`. A cold start takes about 0.27 s.
- `resident.ts`: an in-process resident on port 0, driven by the real `packages/ui-sdk` client.
- `fake-chat.ts`: the one `ChatHandle` fake for face tests.

Open, resume and close timings can't be made exact end to end, because no model call happens there. These three stay as handle-level tests with a blocking fake:
- `ui-gateway.test.ts:2046`
- `ui-gateway.test.ts:2131`
- `ui-gateway.test.ts:2189`

### Proofs (`test/e2e/`)

Each proof is a behaviour that must hold throughout, and each step lands its proofs before rebuilding.

| Proof | Lands |
|---|---|
| `init` twice leaves `SOUL.md` byte-identical; `profiles` changes nothing and starts nothing | start |
| `run "hi"` sends the configured model and SOUL; `models set` changes the next request | start |
| `sessions list` and `sessions show` change nothing; `run --session <id>` appends to that file | start |
| `run` exits 0; `--json` prints Pi's header; a model error exits 1 with one stderr line | start |
| With `serve` up: `run -c` and `run --session <open id>` are refused and name the pid; plain `run` works | start |
| …and web `/new` + a turn, then `run -c`, is refused | session step |
| Web: open, prompt, stream; drop the socket mid-turn; reconnect gets the tail; one user and one assistant message in the file | start |
| Two clients open the same session at once and get one handle and one file | start |
| Resume, `/new` and `/fork` all tell watchers before any later event | session step |
| Automation result into a conversation: idle, busy, stored, no resident; sending it twice gives one receipt | start (if kept) |
| Channel session: watch-only on the web; closed once on shutdown | resident step |
| Extensions: unknown id refused; `add` of a broken package leaves `extensions.json` unchanged; broken optional opens with a warning | extensions step |
| Extension tool works with an empty `PATH`; the model can read `ziggy-operations/references/*.md` | extensions step |
| `extensions update`: stopped, refused while live, crash between renames recovers | extensions step |
| `agent_run` makes one child file with a parent link, a bounded result and only the declared tools | start |
| An agent declaring `profile_extensions` or a misspelled tool fails before any model call | start (red until fixed) |
| `agent_discuss` with 2 agents × 2 rounds makes 4 child files | agents step |
| `memory_write` is visible next turn; group scope can't read `users/`; over-cap writes refused | start |
| ACP `set_model` changes the next request | start (red until fixed) |

**Gate for every step:**
- `bun run check`, all proofs, and the kept unit and handle tests must pass.
- Unit tests for removed machinery are deleted in the same commit.
- A proof only changes when intended behaviour changes, and that change gets its own LOG entry.

**Time budget:** e2e at 10 s or less, the whole suite at 15 s or less. After step 0, with `bun test --parallel`: e2e about 7 s, the whole suite about 13 s.

---

## 8. Work order

We build piece by piece: core first, then what sits on it. Every step runs end to end and leaves faces working.

- [x] **0. Harness and proofs** against today's code. Mark the two known bugs red.
- [ ] **1. Free fixes and deletions.** Each is its own commit:
  - [x] Profile `list` stops writing the registry.
  - [ ] ACP `set_model` actually applies.
  - [ ] `agent_run` output is bounded and no longer duplicated.
  - [ ] Children refuse `profile_extensions` (a guard until step 6).
  - [ ] A live delivery into a switched session retries or falls back to the stored append.
  - [ ] The scheduler survives a cron that never fires (`Cron.next` throws); the resident still starts.
  - [ ] Session stats count Pi's `usage` entries and drop the `toolCall` branch.
  - [ ] Delete dead code:
    - the GitHub catalog and tar extractor;
    - 4 unused registry members;
    - `runtime.ts`;
    - `ZiggyAgentLive`.
  - [ ] Make the optional test-seam members required; move `makeChatHandle` to `test/harness/`.
- [ ] **2. `platform/` and the rules.**
  - Add `paths.ts`, `file-lock.ts` and `atomic-write.ts`.
  - Adopt them in memory, gateway-owner and the extension lock.
  - Add the folder-import lint rule and the `[Pi]` import rule.
  - Update `CLAUDE.md` and the Effect skills with §4 and §5.
- [ ] **3. Core: `profile/`.**
  - Split `domain/profile.ts`.
  - Merge `ProfileStore` in and move models and auth.
  - Use the new service syntax.
- [ ] **4. Core: `session/`.**
  - Split into runtime, handle, lease, agent and tools.
  - Add `OpenSession` and the tool seam; agent and memory tools are plugged in through it unchanged.
  - The handle emits `session-state`.
  - Move the three resume-order tests to the handle.
  - Delete `chat-runtime-binding.ts`, the runtime leases and locks, and the print-mode capture.
- [ ] **5. Core: `session/store.ts`.** One streaming store; the history cursor becomes index + id.
- [ ] **6. Core: `extensions/`.**
  - Selection, loader, required cache, update with recovery, and the smaller tool.
  - Rebuild the extension half of `doctor-checks.ts`.
  - Update the extension skills and ops docs.
- [ ] **7. On the core.** In any order:
  - [ ] `agents/`: one policy function, no selection runtime, tools through the seam.
  - [ ] `memory/`: scope table, 5 plain backups, tool through the seam; update docs.
  - [ ] `resident/live-sessions.ts`:
    - split out the destination book;
    - move delivery into `automations.ts` and drop the fence;
    - delete the transcript reset;
    - move UI verbs out.
- [ ] **8. Composition.** Per-command layers only; delete `runCommand` and `CliLayer`.
- [ ] **9. Clean up.**
  - All face tests use `fake-chat.ts`.
  - Delete the re-exports at old paths.

---

## 9. Choices waiting on you

Only the first three need your answer before work starts. The rest have a default I'll follow unless you say otherwise.

**Need your answer:**

1. **Layout by concept, with a three-folder core (§3–§4).**
   - This changes `CLAUDE.md` from layer folders to concept folders.
   - Pi imports move from "only `adapters/pi/`" to "only the `[Pi]` files".
   - The alternative keeps layer folders and just cuts files, which keeps every change spread across 5–7 folders.
   - My pick: concept folders.
2. **Is "automation result posted into a conversation" something you use?**
   - This covers `conversation:` targets and delivery receipts.
   - If not, about 200 lines and one proof go away.
   - I'll check the Squarey and Buzz Profiles before step 0 either way.
3. **A prompt that arrives while a session is resuming: wait or reject?**
   - Today it waits.
   - My pick: keep waiting.

**Defaults I'll follow:**

- Agents and memory sit on top of the core and plug their tools in through one seam; they're not part of the core.
- A broken optional extension is skipped with a loud warning.
- Required bundled packages come from a shared cache per Ziggy version.
- `extensions update --restart` stays, with a manual check.
- The GitHub extension catalog is deleted.
- An agent with no model uses the Profile default.
- ACP `--agent` starts a fresh session each time.
- Memory keeps the last 5 plain backups.
- The session list skips bad files with a warning; `show` is strict.
- Listing Profiles never edits the registry.
- The shared web UI may open other Profiles' live sessions; this gets documented.

---

## 10. Progress log

Add one dated line per session: what landed, which proofs went green, and what was decided.

- 2026-09-29:
  - Fable reviewed the audit, and I ran five area reviews and two challenge reviews (in `areas/`).
  - The challenge round put back protection the first draft had dropped:
    - the lease across `/new` and `/fork`;
    - the pid in refusals;
    - the extension add/remove lock;
    - update crash recovery;
    - the required-package cache;
    - the streaming session reader.
- 2026-09-30: Rewrote this page bottom-up. It now covers:
  - what is in `src/` today;
  - a three-folder core with agents, memory and resident on top;
  - the service syntax and where every service goes;
  - Effect patterns before and after;
  - each area in plain language;
  - three open questions.
