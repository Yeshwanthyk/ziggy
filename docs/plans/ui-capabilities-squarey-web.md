# Complete UI capabilities and Squarey web client

## Status

Planning only. No gateway, client, skill, Profile, or web behavior has been implemented in this
worktree.

- Worktree: `/Users/yesh/code/personal/ziggy-ui`
- Branch: `kyendamuri/ui`
- Base: `6d7f71cff7d2984228856a2911870b771af55234`
- First Profile used for live proof: `/Users/yesh/.ziggy/profiles/squarey`
- Existing experimental worktrees are reference material only:
  - `/Users/yesh/code/personal/ziggy-ui-capabilities`
  - `/Users/yesh/code/personal/ziggy-ui-surface`

Do not merge or copy an experimental implementation wholesale. Re-establish each contract from
the current worktree and land clean end-to-end slices.

## Outcome

Expose Ziggy's complete browser-appropriate interaction surface through the existing serve-owned
UI gateway and `@ziggy/gateway-client`. Redesign the existing `clients/example-web` into a
Grok-style bot client that runs against Squarey. Extend the bundled `ziggy-operations` skill so an
agent can use the same capabilities to create a different UI.

The architecture remains:

```text
Profile and Pi authority
  -> existing Ziggy application services
    -> existing UI gateway
      -> existing gateway client
        -> any web UI
```

There is no separate UI backend, UI domain, transcript store, mailbox service, group service,
widget service, pin service, or standalone UI-builder skill.

## Product decisions already made

- Primary surface: product UI.
- Platform: responsive web now; Electron may wrap it later.
- First real Profile: Squarey.
- Primary interaction reference: the supplied Grok bot screenshot.
- Visual character: quiet, conversational, expressive, with small blob identities.
- Accessibility: best effort. Semantic controls, keyboard use, visible focus, readable contrast,
  and reduced motion still apply; formal WCAG AA auditing does not block the first example.
- Bloub SVG identities are the final slice, after identity dimensions are stable.
- The browser never reads or writes Profile files directly.
- Pi JSONL remains the only transcript authority.
- Profile Markdown remains Profile authority.

`PRODUCT.md` captures the durable product and design context for the worktree.

## Current implementation truth

### Existing UI gateway

`src/domain/ui-gateway.ts` currently registers eleven methods:

```text
ping
session.list
session.open
session.watch
prompt.submit
session.steer
session.abort
extension.list-for-profile
extension.add
extension.remove
extension.validate
```

`src/application/ui-gateway.ts` serves one Profile target, authenticates loopback WebSocket
clients, opens `ui/*` chats through `ChatRegistry`, and projects future `ChatEvent` values. It does
not provide capability negotiation, transcript content, event cursors, or replay.

### Existing gateway client

`clients/gateway-client/src/index.ts` is already the framework-neutral interaction client. It
provides typed requests, pushed events, request timeouts, reconnect, and watch restoration. It
manually mirrors the gateway protocol and currently has no capability handshake or replay cursor.

Do not introduce a second SDK package. Improve this client in place.

### Existing browser example

`clients/example-web` already exists and is included in root typechecking. It currently provides a
small signal desk with manual port/token entry, session listing, one UI chat, streaming replies,
and channel watching.

Redesign this client in place. Do not add `clients/web`, `examples/grok-web`, or another frontend
package.

### Existing operations skill

The bundled skill is:

```text
extensions/ziggy-operations/skills/ziggy-operations/
```

Add one routing line to its existing `SKILL.md` and add a focused `references/ui.md`. Do not add a
top-level `skills/ui-builder` directory.

## Capability boundary

"All capabilities" means all browser-appropriate, user-facing Ziggy operations required to
observe and operate a Profile. It does not mean exposing raw filesystem adapters, Pi objects,
Effect values, process handles, channel tokens, absolute paths, or internal run loops.

The gateway remains bound to one Profile. Therefore the first contract exposes
`profile.current`, not `profile.list`. A future multi-Profile broker can add discovery without
changing the one-Profile serve ownership model.

### Complete target method inventory

#### Protocol and identity

```text
ping
system.capabilities
profile.current
```

`system.capabilities` returns protocol version, server epoch, supported methods, event names,
limits, and the logical identity of the served Profile. Clients use it instead of probing methods.

#### Conversations and sessions

```text
session.list
session.show
session.history
session.open
session.watch
session.unwatch
session.close
prompt.submit
session.steer
session.follow-up
session.abort
```

- `session.list` returns logical references and safe metadata, never absolute paths.
- `session.show` returns one metadata projection.
- `session.history` returns a bounded, cursor-paged transcript projection.
- `session.open` accepts explicit conversation context and an optional specialist ID.
- `session.watch` accepts an event cursor.
- `session.unwatch` releases a socket subscription.
- `session.close` disposes only registry-owned UI handles; channel aliases remain watch-only.
- Commands accept client command IDs so retries are attributable and idempotent where needed.

#### Profile specialists

```text
agent.list
agent.show
agent.create
agent.validate
agent.run
```

`agent.run` remains a fresh one-shot specialist run. Long-lived specialist conversations use
`session.open` with `agentId`, backed by `openSpecialistChat`.

#### Models

```text
model.status
model.list
model.available
model.set
```

#### Automations

```text
automation.list
automation.show
automation.create
automation.save
automation.validate
automation.pause
automation.resume
automation.run
automation.status
automation.runs
```

Use `automation.run` as the public operation name. The application may translate it into the
existing manual-force trigger. Save carries the expected source/version so conflicts remain typed.

#### Memory

```text
memory.list
memory.show
```

There is no direct UI memory-write method because the current application service does not own
one. Memory writes continue through the agent's admitted memory tool and Profile rules.

#### Extensions

```text
extension.list-for-profile
extension.add
extension.remove
extension.validate
```

These already exist and retain their transactional Profile-extension authority.

### Operations deliberately outside the first contract

The following are user-facing CLI capabilities but are not required to build Profile UIs:

```text
auth.login
serve install/start/stop/restart/uninstall
self-update
```

They either require interactive host coordination, can terminate the server carrying the request,
or mutate the installed Ziggy executable. Keep them in CLI/operations surfaces until a separate,
explicit local-administration contract is shaped.

Read-only `auth.status`, `doctor.check`, `serve.status`, and bounded `serve.logs` may be added as a
later optional capability slice after the complete Profile interaction surface is green. They must
not delay the Squarey client.

## Public data rules

- Use Effect Schema for every request, result, event, and unknown boundary.
- Export framework-neutral TypeScript values from the gateway client. Do not export Pi, Effect,
  Bun, filesystem, or WebSocket implementation types.
- Use logical Profile, agent, automation, and session references.
- Never return absolute Profile paths. Existing stored-session `path` is replaced by a logical
  reference in the next protocol version.
- Bound list lengths, string lengths, transcript page sizes, event replay windows, and log details.
- Preserve structured typed failures. Do not turn failures into empty arrays or generic messages.
- Redact secrets, tool arguments, raw tool results, thinking content where policy forbids it, and
  channel configuration.
- Keep current loopback binding, token authentication, frame limits, request limits, and
  backpressure limits.

## Conversation reliability design

### Transcript history

`SessionsApi` currently exposes transcript-free metadata. Add a separate bounded UI transcript
projection at the Pi adapter boundary in `src/adapters/pi/`. The adapter reads Pi-owned JSONL and
returns only schema-owned UI entries. It must not create a second writer or transcript index.

The initial entry union should be only what the chat UI can render safely:

```text
user text
assistant text
tool lifecycle summary
specialist voice
terminal state
```

Do not return raw JSONL records or arbitrary tool payloads.

### Event sequence and replay

Each serve process publishes a random `serverEpoch`. Each live session has monotonically
increasing event sequence numbers and a bounded in-memory replay ring owned with the serve-scoped
chat registry.

```text
connect
  -> system.capabilities { serverEpoch }
  -> session.history for durable transcript state
  -> session.watch { afterSequence }
  -> replay buffered events
  -> continue live events
```

If the epoch changed because serve restarted, the client discards its live cursor, refreshes
history, and watches from the new epoch. The in-memory replay ring is not a second transcript
store.

### Correlation and idempotency

Every command may carry a bounded `commandId`. Events caused by that command carry the same
correlation value where available. Mutations that can be retried keep a bounded in-memory outcome
cache for the serve epoch or use the authoritative application's conflict mechanism.

Do not build a general job database.

## Squarey Grok-style example

### Runtime

The live proof uses:

```text
ziggy serve /Users/yesh/.ziggy/profiles/squarey
```

The browser uses the loopback port and token projected at:

```text
/Users/yesh/.ziggy/profiles/squarey/.runtime/ui-server.json
```

The token remains runtime-only in the browser tab. It is never committed, bundled, logged, or
written into Profile Markdown. The first slice may retain manual connection entry. A smoother
local launcher is a later interaction-surface improvement, not a second application backend.

### Layout

Use the supplied Grok bot screenshot as the interaction reference:

```text
left rail
  search
  Profile and specialist bot rows
  recent and pinned conversations
  connection/Profile status at the bottom

conversation pane
  selected bot identity
  transcript timeline
  streaming/tool state
  composer with send/steer/abort behavior

secondary surfaces
  lightweight routines panel
  memory/extension details
  optional group-room composition
```

Keep conversation primary. Operations panels stay secondary and may use drawers or inline
sections rather than turning the product into a dashboard.

### UI-owned composition

These features use generic capabilities and live only in `clients/example-web`:

```text
mailbox      = sessions + ordered events + UI-owned unread markers
pin          = stable session reference + browser storage
group room   = multiple session references + correlated sends
cron card    = automation definition + status + run history
widget       = a local view over capabilities and events
Bot Mode     = Profile identity + app-owned canonical conversation choice
```

Do not add `mailbox.*`, `pin.*`, `group.*`, `widget.*`, or `bot-mode.*` gateway methods.

### Visual system

- Product register, restrained color strategy.
- Dark neutral shell matching the Grok reference, with color reserved for bot identity and state.
- One familiar sans-serif family.
- Compact rail, generous transcript measure, standard controls, and predictable focus behavior.
- Motion communicates streaming, selection, and panel changes only; respect reduced motion.
- No glassmorphism, ornamental card grid, giant headings, decorative gradients, or excessive
  rounding.
- Use generated Bloub SVGs only in the final slice after avatar size, crop, labels, and roster
  density are stable.

## `ziggy-operations` skill addition

Update:

```text
extensions/ziggy-operations/skills/ziggy-operations/SKILL.md
```

Add a route such as:

```text
Build or customize a Ziggy web UI -> references/ui.md
```

Add:

```text
extensions/ziggy-operations/skills/ziggy-operations/references/ui.md
```

The reference explains:

- Start or locate `ziggy serve` for one Profile.
- Connect through `@ziggy/gateway-client`.
- Perform capability negotiation before rendering optional UI.
- Load history before watching from a cursor.
- Keep tokens runtime-only.
- Compose mailbox, pins, rooms, routines, and widgets in app code.
- Never read Profile files from a browser.
- Never create a second transcript or automation store.
- Use the existing example as a replaceable reference, not a required shell.

Do not vendor the gateway client into the skill or add framework-specific scaffolding in the first
version.

## Vertical slices and commits

Every slice must work from schema to application handler to gateway client to focused test and,
where relevant, visible example behavior. Update `LOG.md` and commit after each green slice.

### Slice 0 — planning baseline

Files:

- `PRODUCT.md`
- `docs/plans/ui-capabilities-squarey-web.md`
- `LOG.md`

Proof:

- No production behavior changed.
- Worktree, branch, base, ownership, capability inventory, and stop conditions are explicit.

### Slice 1 — protocol discovery and Squarey identity

Implement:

- Protocol version and capability schemas.
- `system.capabilities`.
- `profile.current` with logical identity and available identity fields.
- Gateway-client decoding and typed helpers.
- Example connection state and Squarey header sourced from real capability data.

Primary files:

- `src/domain/ui-gateway.ts`
- `src/application/ui-gateway.ts`
- `clients/gateway-client/src/index.ts`
- `clients/gateway-client/test/client.test.ts`
- `test/domain/ui-gateway.test.ts`
- `test/application/ui-gateway.test.ts`
- `clients/example-web/main.ts`

Exit proof:

- The example connects to Squarey and renders the served Profile identity without hardcoded bot
  metadata.
- Unknown or incompatible protocol versions fail clearly.

### Slice 2 — reliable conversations

Implement:

- Logical stored-session references without absolute paths.
- `session.show` metadata.
- Bounded `session.history` projection.
- Explicit local/user/group context.
- Optional specialist target on `session.open`.
- Event epoch, sequence, cursor, replay ring, and reconnect handling.
- `session.unwatch`, `session.close`, and `session.follow-up`.
- Command correlation.
- Grok-style session rail, transcript, composer, streaming, steer, follow-up, and abort states.

Primary files:

- `src/adapters/pi/sessions.ts`
- `src/domain/session.ts`
- `src/domain/ui-gateway.ts`
- `src/application/sessions.ts`
- `src/application/chat-registry.ts`
- `src/application/ui-gateway.ts`
- matching `test/` files
- `clients/gateway-client/**`
- `clients/example-web/**`

Exit proof:

- Send a Squarey prompt, disconnect while output is streaming, reconnect, replay, and render the
  final conversation without a missing or duplicated visible event.
- Restarting serve changes the epoch and causes a history refresh rather than invalid replay.
- Channel aliases remain watch-only.

### Slice 3 — specialists and models

Implement the complete agent and model inventories and commands. Add the bot/specialist rail,
create/validation affordance, specialist conversation target, one-shot run display, model status,
and model selection.

Primary application services:

- `ProfileAgents`
- `Models`
- `ZiggyAgent.openSpecialistChat`

Exit proof:

- Squarey's Profile and specialist rows come from `agent.list`.
- Opening a specialist continues its specialist session.
- Model selection reflects the authoritative Profile setting and reports typed invalid choices.

### Slice 4 — automations and run history

Implement the complete automation method group. Add routines list/detail, validation state,
pause/resume, run, edit conflict handling, scheduler status, and run history to the example.

Primary application services:

- `AutomationDefinitions`
- `Automations`
- `AutomationScheduler`

Exit proof:

- Squarey's real definitions and run history render.
- A manual run has one outcome when the client retries a correlated command.
- Stale edits return a typed conflict and do not overwrite human-owned files.

### Slice 5 — memory and extensions

Implement `memory.list/show` and complete the existing extension operations in the redesigned
client. Add secondary Profile details for admitted memory documents and Profile extensions.

Primary application services:

- `Memory`
- `ProfileExtensions`

Exit proof:

- Memory views preserve scope, state, caps, and bounded content.
- Extension add/remove/validate continues using the existing transactional authority.
- No browser code reads Profile files.

### Slice 6 — custom UI composition proof

Implement only in `clients/example-web`:

- Local pinned-session state.
- Derived unread/mailbox markers.
- A simple group room coordinating two ordinary conversations.
- Automation cards as the first widget type.
- A small local widget registry so another view can be added without gateway changes.

Exit proof:

- Search the protocol and gateway code for mailbox/group/widget/pin product nouns; none are added
  as methods or domain services.
- Clear browser storage and verify only UI preferences disappear; Ziggy state remains intact.

### Slice 7 — bundled UI-author guidance

Update the existing `ziggy-operations` skill and add `references/ui.md`. Use the skill in a clean
Profile-shaped smoke test to produce or modify a tiny client against the gateway-client contract.

Exit proof:

- The installed required package includes the new reference.
- The skill points to public interaction concepts and does not instruct agents to inspect `src/`
  or read Profile files from the browser.

### Slice 8 — visual QA and Bloub identities

Only now generate deterministic default SVG identities using Bloub. Add them as example defaults,
not Profile authority. Complete desktop/mobile layout, empty/loading/error states, keyboard use,
focus, reduced motion, and live browser review.

Exit proof:

- The Squarey client visually matches the intended Grok-style interaction hierarchy.
- SVGs remain replaceable UI assets.
- No credentials or private Profile content exist in built assets.

## Test strategy

### Domain and application

- Exact request decoding with excess-property rejection.
- Complete method registration parity.
- Bounded results and errors.
- Path redaction.
- Profile-target ownership.
- Channel watch-only invariants.
- Specialist targeting.
- Transcript projection from representative Pi JSONL fixtures.
- Event sequence, replay-window truncation, epoch change, and reconnect.
- Command correlation, duplicate retry, and automation edit conflict.

### Gateway client

- Capability negotiation.
- Every request/result decoder.
- Every event decoder.
- Out-of-order responses.
- Request timeout.
- Reconnect and restored watches with cursors.
- Epoch change and history refresh signal.
- Rejection of malformed or oversized frames.

### Example web client

- Root TypeScript check remains green.
- Build with Bun's browser target.
- Static inspection proves no Profile path or token is bundled.
- Browser smoke covers connection, identity, session history, live prompt, specialist selection,
  automation view, memory/extensions, and reconnect.
- Responsive inspection at desktop and narrow mobile widths.

### Required gates per commit

Run the smallest focused test first, then:

```text
bun run fmt
bun run lint
bun run typecheck
bun run check:gateway-client
git diff --check
```

Before the final implementation commit:

```text
bun run check
```

Report live Squarey/browser proof separately from fake-socket and fixture tests.

## Commit discipline

- One logical commit per slice.
- Do not modify `/Users/yesh/code/personal/ziggy` main.
- Preserve current main's untracked `PLAN.md` and
  `docs/research/ziggy-web-ui-agent-surfaces.md`.
- Do not modify `/Users/yesh/.ziggy/profiles/squarey` during implementation unless a later user
  request explicitly authorizes a Profile change.
- Do not merge, push, deploy, replace the installed Ziggy binary, or restart Squarey's resident
  service without explicit authorization.
- Keep `LOG.md` updated for every committed slice.
- Use Sol medium for implementation, Sol medium for independent verification, and Luna high for
  focused scouts, as requested.

## Fresh-session start checklist

1. Open `/Users/yesh/code/personal/ziggy-ui`.
2. Read `AGENTS.md`, `PRODUCT.md`, this plan, and the focused Effect skills.
3. Confirm branch `kyendamuri/ui`, base `6d7f71c`, exact HEAD, and dirty state.
4. Inspect current main/worktree drift before implementing; do not assume the experimental
   worktrees are correct.
5. Start with Slice 1 only.
6. Assign non-overlapping file ownership to subagents.
7. Commit only after focused proof and the required checks are green.

## Fresh-session prompt

```text
Implement docs/plans/ui-capabilities-squarey-web.md from the clean
/Users/yesh/code/personal/ziggy-ui worktree.

Read AGENTS.md, PRODUCT.md, the full plan, and the required Effect skills first. Confirm cwd,
branch, HEAD, base, and dirty state. Treat ziggy-ui-capabilities and ziggy-ui-surface as reference
only. Do not modify main or Squarey's Profile files.

Use Luna high scouts for bounded code questions, Sol medium for implementation, and a separate Sol
medium agent for verification. Implement one clean end-to-end vertical slice at a time, update
LOG.md, run focused checks plus the required gates, and commit each slice. Start with Slice 1 only.

The architectural rule is: improve the existing UI gateway and gateway client; redesign the
existing clients/example-web; load UI-building guidance through the existing ziggy-operations
skill. Do not create a separate SDK subsystem, UI backend, transcript store, or product-specific
mailbox/group/widget/pin methods.
```

## Completion definition

The work is complete when the full target method inventory is implemented and typed, the Squarey
Grok-style example works through the existing gateway client, reconnect/replay has live proof,
mailbox/groups/widgets/pins remain UI composition, the bundled operations skill can guide another
UI author, Bloub defaults are added last, all checks pass, and no core authority or Profile file is
duplicated.
