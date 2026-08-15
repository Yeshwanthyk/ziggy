# Ziggy plugin-first core study

Date: 2026-08-13

Primary sources:

- Ziggy at `495ec5ffef9f371feb91718f8626dd6df28b6e5b`.
- DeepSeek Harness at `47f943859bef60e4160492346772ded9b24f765a`, staged under `/tmp/ziggy-deepseek-exploration/deepseek-harness`.
- Pi source under `/Users/yesh/Documents/personal/reference/pi-mono`.
- OpenAI Codex app-server snapshot under `/Users/yesh/.opensrc/repos/github.com/openai/codex/main`.
- The supplied plugin-first reference image at `/tmp/ziggy-deepseek-exploration/reference.png`.

## Question

How can Ziggy keep one clear core while built-in and third-party extensions can add or override behavior? How can TUI, GUI, web, and editor authors use the same complete runtime primitives?

This is not a study of swapping Pi for another harness. Pi remains Ziggy's agent runtime.

## Decision summary

Ziggy does not need a second plugin framework.

Pi already supplies a strong plugin API and a strong embedding API. Ziggy should expose these capabilities through a small Profile-aware core SDK. Ziggy should also compose its own model-facing behavior as ordered Pi extensions where policy permits replacement.

The target has three parts:

```text
Ziggy core
  Profile policy, runtime construction, session routing, automations, and typed failures

Pi extension path
  Skills, tools, commands, hooks, prompt changes, providers, and tool overrides

Client SDK path
  TUI, GUI, web, and editor clients drive a Profile runtime and observe its sessions
```

Do not add general `HealthCheckRegistry`, `ResidentContribution`, `UiContributionRegistry`, or similar concepts. Those names were speculative and made the design harder to understand.

## What Ziggy already has

### Clear product primitives

Ziggy already has useful application services for Profiles, agents, automations, sessions, models, auth, setup, and resident operation. It also has CLI commands to create, show, save, list, pause, resume, and validate automations (`src/application/automation-definitions.ts`; `src/faces/cli.ts`; `src/main.ts`). The earlier claim that a new automation command was missing was wrong.

### One approved extension path

`catalog.json` is the approved package catalogue. A Profile selects packages through `extensions.json`. A Profile-owned package with the same ID wins over a bundled package (`src/adapters/pi/resources.ts`). Selected packages can provide skills and executable Pi extensions.

### Built-ins already use Pi extensions

Ziggy implements memory refresh, ephemeral turn context, Pi docs, agent guidance, and TUI behavior as hidden inline Pi extensions inside `createProfileRuntime` (`src/adapters/pi/pi-agent.ts`). This is real plugin dogfooding.

### Pi tool replacement already works

Pi builds its tool registry in this order:

1. Pi built-in tools.
2. Extension tools.
3. SDK `customTools`.

Later layers replace earlier tools with the same name. Across extensions, the first registered tool with a given name wins. Inside one extension, the last registration wins (`pi-mono/packages/coding-agent/src/core/agent-session.ts:2465-2530`; `core/extensions/runner.ts:450-459`; `core/extensions/loader.ts:264`).

This means a Ziggy extension can replace Pi's built-in `edit` tool by registering another tool named `edit` and loading before other extension definitions of that name.

Ziggy's own `memory_write`, `agent_run`, and `agent_discuss` tools are different. Ziggy passes them as SDK `customTools`, so they always beat extension tools. They are currently protected and cannot be replaced.

## Pi already provides the client primitives

Pi's public SDK has the controls needed for a custom TUI or GUI:

| Need | Pi API |
| --- | --- |
| Submit a prompt | `AgentSession.prompt()` |
| Steer an active run | `AgentSession.steer()` |
| Queue a follow-up | `AgentSession.followUp()` |
| Stop work | `AgentSession.abort()` |
| Observe text, tools, turns, queues, retries, and compaction | `AgentSession.subscribe()` |
| Start a session | `AgentSessionRuntime.newSession()` |
| Resume a session | `AgentSessionRuntime.switchSession()` |
| Fork a session | `AgentSessionRuntime.fork()` |
| Navigate the session tree | `AgentSession.navigateTree()` |
| Compact | `AgentSession.compact()` |
| Change model or thinking | `setModel()` and `setThinkingLevel()` |
| Add tools and behavior | Pi extension factories and `ExtensionAPI` hooks |

Relevant source: `pi-mono/packages/coding-agent/src/core/agent-session.ts`, `agent-session-runtime.ts`, `resource-loader.ts`, and `extensions/types.ts`.

Pi also supplies more than 30 extension events. These include:

- `before_agent_start`;
- `tool_call` and `tool_result`;
- `input` and `context`;
- session switch, fork, compact, and tree events;
- provider request and header hooks;
- custom tools, commands, shortcuts, flags, providers, and messages.

The main sharp edge is session replacement. A client must rebind extension actions and event subscriptions after `newSession`, `switchSession`, or `fork`. Ziggy already handles this internally in `bindChatRuntime`, but it does not expose a complete reusable client handle.

## Codex app-server confirms the client shape

Codex app-server uses three clear client concepts:

- **Thread:** the durable conversation.
- **Turn:** one accepted unit of work.
- **Item:** a message, tool call, command, or other event inside a turn.

It supports thread start, resume, fork, archive, and unload. It supports turn start, steer, and interrupt. It sends ordered item events and asks the client for approvals or tool results when needed (`codex-rs/app-server/README.md`).

This is useful for an out-of-process Ziggy client. It does not mean Ziggy must copy Codex's protocol. It shows which controls a complete GUI needs.

For an in-process client, Pi already provides most of these controls. Ziggy mainly needs to package them cleanly around a Profile.

## The real gaps

### Gap 1: Ziggy does not yet pass through the session controls clients need

`ZiggyAgent.openChat()` returns a `ChatHandle` with only:

- `prompt()`;
- limited text and tool progress;
- `dispose`.

It does not expose full events, steer, follow-up, explicit abort, new session, explicit resume, fork, tree navigation, compaction, model changes, or state.

It is fine that these controls come from Pi. Ziggy does not need to hide that fact. Ziggy needs one Profile-aware wrapper that opens Pi with the correct Profile policy and passes these controls through.

**Smallest fix:** make the existing Profile runtime handle complete. Add steer, follow-up, abort, full events, new/resume/fork, tree navigation, compaction, active-session model control, and cleanup. Automatically rebind events and extensions when Pi replaces the active session.

### Gap 2: The core API exists only inside the CLI program

The CLI-first package is intentional. Ziggy does not need to become a public npm library merely to have a clean core. The gap is that runtime composition is private inside `src/main.ts`. The CLI, a future app server, and tests cannot call one complete core API without rebuilding that composition.

**Smallest fix:** extract an internal typed core API from `src/main.ts`. Keep the CLI as the main product. Let the CLI and a future app-server mode use the same core. Publish a library entry only if an in-process third-party client becomes a real need.

### Gap 3: Runtime assembly is hardcoded

`createProfileRuntime` hardcodes Ziggy's hidden extensions, protected custom tools, specialist setup, and selected package resources.

The result works, but there is no clear ordered list that shows:

- which built-ins are installed;
- which selected packages are installed;
- which names may be replaced;
- which Ziggy policy tools are protected;
- why one collision wins.

The exact live gap is small but important:

- the main runtime and specialist runtime build similar resource options in two places;
- selected package IDs use alphabetical order, so that order silently decides which duplicate tool wins;
- the skill order is load-bearing but is not named as policy;
- Profile-owned path extensions load before Ziggy's hidden inline extensions, so they can shadow an internal tool or command unless an SDK custom tool protects it;
- Pi reports collision diagnostics, but Ziggy does not show them.

**Smallest fix:** create one function that returns the complete ordered runtime plan. Use it for the main and specialist runtimes. Name every tier. Test the exact order. Surface collision diagnostics. Do not create a new plugin host.

The plan should include Profile-owned extension paths, selected bundled factories, replaceable Ziggy inline extensions, required and selected skills, protected Ziggy custom tools, and the result of each duplicate name.

### Gap 4: Override policy is implicit

Pi has precise collision behavior, but Ziggy does not publish a product-level override policy.

A useful policy could be:

1. Profile-owned extensions.
2. Selected bundled extensions.
3. Replaceable Ziggy internal extensions.
4. Pi built-ins.
5. Protected Ziggy policy tools as SDK `customTools`.

Because Pi extension conflicts are first-wins, Ziggy must load extension sources in the matching order. Protected tools remain last and cannot be replaced.

The exact protected set is a product decision. `memory_write` protects memory ownership and should probably remain protected. `agent_run` and `agent_discuss` may also remain protected because they enforce session lineage and child restrictions. Pi's ordinary `edit`, `read`, `bash`, and `write` tools can already be replaced.

### Gap 5: Product operations and agent extensions are mixed in discussion

A Pi extension changes the model-facing runtime. It can add tools, skills, commands, hooks, and prompt behavior.

Ziggy application services manage product state and operator workflows. Examples include creating an automation, listing sessions, configuring a channel, or running doctor.

These do not all need to become plugins. An outside UI only needs a stable SDK for these services. Add a Ziggy-level extension point only when a real package needs to add a new product operation that Pi extensions cannot express.

## Clean target primitives

Keep the primitive set small:

### 1. Profile

Owns the visible files and package selection.

### 2. Profile runtime

Builds the Pi runtime with Ziggy policy and selected extensions. Owns cleanup.

### 3. Session

Exposes prompt, steer, follow-up, abort, events, new/resume/fork/tree, compaction, model state, pins, and close.

### 4. Automation

Keeps the current create/show/save/list/pause/resume/validate/run behavior. UIs call the same application service as the CLI.

### 5. Extension

Uses Pi's existing package and `ExtensionAPI` contracts for model-facing behavior. Supports ordered replacement where allowed.

These are enough for the current goal. Do not invent more primitive names until a real feature cannot fit.

## Options

### Option A: Publish the existing narrow chat handle

Expose `openChat`, `prompt`, progress, and dispose.

This is small, but it is too weak for a serious TUI or GUI.

### Option B: Build one complete core API and app server

Expose Ziggy's Profile-aware runtime and the full Pi-backed session controls inside the program. Keep Pi extensions as the only model-facing plugin system. Make runtime contribution order and protected overrides explicit.

Use the same API from the CLI and from a resident app-server mode. A TypeScript client can wrap that protocol later. This gives custom clients and extensions the needed power without making npm embedding the primary design.

**Recommended.**

### Option C: Add a Ziggy product-plugin host

Let packages add application services, channels, CLI commands, and resident work at runtime.

This may be useful later, but current evidence does not justify the extra lifecycle and compatibility system. Add it only after a real extension cannot be built with the Profile runtime SDK, Pi extensions, and existing application services.

## Full client surface

A complete Ziggy client needs more than conversation controls. Most of this already exists as Effect application services. The app server should expose the same operations rather than reimplement them.

| Area | Existing core | Needed addition |
| --- | --- | --- |
| Profiles | initialize, list, skills, package selection | none for the first client |
| Conversations | open and prompt | steer, follow-up, abort, events, compact, new/resume/fork/tree, state |
| Sessions | list and show safe metadata | create/open by route, explicit resume, pin/unpin, join |
| Models | status, list, set | active-session model change if the client needs it |
| Auth | status and login | client-supplied OAuth or secret interaction |
| Automations | create, show, save, list, pause, resume, validate, run, status, history | progress subscription only if a UI needs live runs |
| Profile agents | create, list, show, validate, run | none for the first client |
| Extensions | list, show, add, remove | collision and effective-runtime diagnostics |
| Doctor and serve | doctor, install/start/stop/restart/status/logs | structured app-server responses |

### Session pins and joins

Pi JSONL remains the only transcript authority.

- **Main** means the stable `sessions/local/main/` route.
- **Fresh** creates a new Pi root session.
- **Resume** opens one exact Pi session ID or safe relative path.
- **Pin** gives a stable client-facing name to one session or stable route.
- **Channel conversation** maps a channel and thread identity to its existing `sessions/<channel>/<chat-key>/` route.
- **Join** means that another client opens the same resident-owned conversation handle. It does not copy the transcript or open a competing Pi runtime.

Pi already supports a session name in session information. That can hold a human label. A stable pin may still need a small Ziggy-owned mapping from pin name to Pi session ID or route. This mapping is routing metadata, not a second transcript. It must never contain messages or tool history.

### How a new channel joins the gateway

A channel is not a Pi extension. It is a transport client of the resident core.

It supplies:

1. a stable channel and conversation key;
2. admitted user input and attachments;
3. a request to open or join the matching resident session;
4. delivery of text, progress, tool state, and terminal results back to that transport;
5. explicit stop and disconnect behavior.

The resident owns the live session, queue, and generation. The channel owns network admission, transport IDs, and output delivery. Existing Telegram, Discord, and Slack code already follows much of this split, but it calls the core in-process. An outside channel can use the app-server protocol.

## SDK, ACP, or app server?

Use layers rather than choosing only one.

### Internal core API

This is the typed Effect API used by the CLI, resident, and tests. It is the source contract.

### Ziggy app-server protocol

This is the complete out-of-process API for a TUI, GUI, web app, editor, or channel. It needs conversations plus Ziggy management operations such as automations, models, extensions, doctor, serve status, and pins.

Codex app-server is the better shape reference. Its thread, turn, item, steer, interrupt, approvals, and bidirectional requests match a rich client control plane.

### ACP adapter

ACP is useful for standard agent-client interoperability. It already covers session creation and loading, prompt, cancel, and streamed updates.

ACP does not cover Ziggy-specific management such as compaction, pins, automations, extension selection, doctor, serve state, or joining a resident channel session. It also assumes stdio today.

Therefore ACP should be an adapter over the conversation part of the Ziggy app server. It should not be Ziggy's only protocol.

The clean stack is:

```text
CLI / resident / tests
  -> internal Effect core

Ziggy TUI / GUI / web / editor / outside channel
  -> Ziggy app-server protocol
  -> internal Effect core

ACP client
  -> ACP adapter
  -> conversation part of the same core
```

An npm SDK is optional. It can be a generated or handwritten client for the app-server protocol. The CLI binary remains the main product.

## Recommended slices
## Recommended slices

1. **Make runtime composition explicit.** Extract the ordered extension, skill, and protected-tool plan from `createProfileRuntime`. Document collision rules and show collision diagnostics.
2. **Complete the Profile runtime handle.** Pass through Pi's steer, follow-up, abort, events, new/resume/fork/tree, compaction, and active-session model controls. Rebind automatically after session replacement.
3. **Add session addressing.** Support main, fresh, explicit ID/path resume, a stable pin, and channel conversation routes while Pi JSONL remains the only transcript.
4. **Extract the typed core from the CLI.** Make `src/main.ts` a caller of that core rather than its only composition owner.
5. **Add a resident app-server mode.** Expose conversations and Ziggy management operations to out-of-process clients.
6. **Build one custom client.** It must prompt, stream, steer, stop, compact, create and pin a session, resume, fork, change model, inspect an automation, and close.
7. **Prove overrides.** Replace Pi's built-in `edit` with an extension. Prove that a protected Ziggy tool cannot be replaced.
8. **Add an ACP adapter only for interoperability.** Do not use ACP as Ziggy's complete management protocol.

## Final recommendation

Ziggy already has the right plugin engine: Pi extensions.

The main gap is not a missing general plugin registry. The main gaps are that Ziggy does not expose Pi's complete session controls through one Profile-aware core, and its runtime contribution and override rules remain hardcoded.

Make those two parts clear. Then let the CLI and resident app server call that core. Third-party clients can use the app server, and extensions can continue to use Pi's plugin API.