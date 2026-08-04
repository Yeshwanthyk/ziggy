# eve, Flue, and Ziggy comparison

Source-grounded comparison of:

- Ziggy at `98988c29b7676b9fd0de1cc6c452598134b13fd0`
- [`vercel/eve`](https://github.com/vercel/eve) at
  `6c5f4fe25f659bb21e9e267cfee3c9f9bbfc9474` (`eve@0.30.0`)
- [`withastro/flue`](https://github.com/withastro/flue) at
  `a171cc1bc8a552775a820ae3d343ccd09597cc8c` (`@flue/*@2.0.2`)

The external repositories were cloned read-only under
`/tmp/ziggy-agent-framework-comparison/{eve,flue}`. Paths and line numbers below refer to
those exact snapshots unless a link points into this repository.

## Executive finding

**They overlap in capability vocabulary, not in product boundary.** All three provide an
agent loop, models, tools, skills, conversation state, channels, and local execution. They are
not interchangeable implementations of the same thing:

- **Ziggy is a local-first assistant product.** A live Profile folder is the assistant's
  identity and visible durable world, including human-owned policy files and Pi-owned session
  files. Ziggy composes the published Pi coding-agent runtime rather than building an agent
  framework.
- **Flue is a deployable TypeScript application framework.** An agent is a re-rendered
  function, an instance ID identifies a conversation, Flue owns admission/recovery semantics,
  and Pi's lower-level packages own the model/tool loop and provider protocol. Cross-restart
  durability requires a durable Node database or the Cloudflare target; the Node production
  default is in-memory.
- **eve is a deployable filesystem-authored backend-agent framework.** The agent folder is
  compiler input; eve owns a durable outer loop around Vercel AI SDK `ToolLoopAgent` and the
  Workflow SDK.

**Flue is Ziggy's closest technical relative because both use Pi.** It is nevertheless closer
to eve in product shape: Flue and eve compile agent applications, expose HTTP conversation
protocols plus durability machinery, support remote clients, and target hosted runtimes. Ziggy
is a private executable with in-process faces and Profile-local files.

**There is no direct runtime tie between Ziggy and eve.** There is a shared Pi lineage between
Ziggy and Flue, but not a shared session format, tool API, extension loader, or durability
engine. The clean common portable unit today is a spec-compliant **Agent Skill**. A separately
hosted eve or Flue agent can also be called from Ziggy over its public HTTP protocol, but it
must remain a separate state authority. Flue's SDK is fetch-portable; the official `eve`
package requires Node 24, so a Ziggy/eve client package integration needs compatibility testing
or a small Ziggy-owned HTTP adapter.

## Where they do not differ

1. **Agentic capability model.** Each combines instructions, model selection, callable tools,
   progressive skills, multi-turn context, and multiple ingress surfaces.
2. **TypeScript host.** All three are TypeScript systems with explicit typed boundaries around
   model and tool execution.
3. **Progressive skills.** All advertise compact skill metadata and load full skill instructions
   on demand. All accept spec-compliant Agent Skills packages; each also has host-specific
   authoring options or looser accepted Markdown shapes.
4. **One core, multiple faces.** Ziggy's TUI/CLI/gateways share `ZiggyAgent`; eve's terminal,
   clients, and frontend hooks share its HTTP channel; Flue's CLI, dispatch API, channels, and
   HTTP routes share its conversation runtime.
5. **External side effects still need idempotency.** None can make a payment, email, or foreign
   database mutation exactly once merely by recording an agent/tool result.

Those similarities are real, but they sit above substantially different ownership models.

## Where they differ

| Dimension | Ziggy | Flue | eve |
| --- | --- | --- | --- |
| Product | Opinionated personal assistant | Agent application/harness framework | Durable backend-agent framework |
| Authoring unit | Live Profile folder, led by `SOUL.md` | Capitalized exported function plus `use*` hooks | Conventional `agent/` source tree plus `define*` files |
| Durable identity | Profile path; sessions below it | Agent function identity + caller-chosen instance ID | Compiled agent + session/continuation identity |
| Filesystem meaning | **Live Profile state and agent cwd**, including human-owned policy files | Application source; optional runtime sandbox is separate | **Compiler input**; the mandatory per-session runtime sandbox is separate |
| Inner loop | Pi coding-agent owns the whole session runtime | Pi `pi-agent-core.Agent` | Vercel AI SDK `ToolLoopAgent` |
| Durable orchestration | Pi JSONL transcript only; Ziggy has no accepted-work recovery layer | Flue conversation records, submission queue, attempts, and recovery; cross-restart durability needs a durable Node store or Cloudflare DO | Workflow SDK journal, steps, hooks, streams, and park/resume |
| Provider layer | Pi coding-agent `ModelRuntime`, Profile-local auth/model files | Pi AI provider objects and built-in provider catalog | AI SDK provider objects or Vercel AI Gateway IDs |
| Long-term memory | Explicit shared/person/group Markdown, separate from transcript | Conversation-scoped persisted hook state; cross-conversation memory is application-owned | Session-scoped `defineState`; cross-session memory is external |
| Conversation ordering | One live handle and semaphore per gateway chat; Pi JSONL persists history | Durable per-conversation admission queue | No durable FIFO for concurrent deliveries; channel/app queues bursts |
| Sandbox | No product sandbox boundary; Pi tools run in the Profile world | Optional `useSandbox`; no filesystem/shell without one | Every agent gets one per-session sandbox and file/shell tools; the backend is defaulted or overridden, separate from Workflow durability |
| Extensibility | Pi extensions and Agent Skills admitted by Ziggy policy | Hooks, Valibot tools, skills, MCP, subagents, persistence/sandbox adapters | Filesystem definitions for tools, skills, hooks, channels, connections, schedules, extensions, subagents |
| Channels | Resident owner-only Telegram, Discord, and Slack processes | Verified inbound Hono channel packages; app owns IDs and outbound behavior | Built-in/custom HTTP/WebSocket channels own continuation and delivery |
| Ingress trust | Static configured owner-ID checks; no public client endpoint | Mounted agents have no built-in auth; application middleware must authenticate and authorize each conversation ID | Channel-level auth helpers; default eve channel rejects production traffic until real auth is configured |
| Client/UI | Pi TUI and CLI; no external client protocol | `@flue/sdk`, `@flue/react`, CLI, private demo UI | `eve/client`, React/Vue/Svelte hooks, Next/Nuxt/SvelteKit integrations, terminal UI |
| Deployment | Bun checkout/process | Node app/server or Cloudflare Worker/DO; scripts via `start()` | Nitro Node self-host or Vercel; pluggable Workflow world and sandbox |
| Reuse contract | Private bin-only package; internal `ZiggyAgentShape` | Published runtime, Vite, SDK, React, adapter, channel, and database packages | Published package with authoring, client, frontend, framework, tool, channel, sandbox, and eval exports |

The sandbox and trust rows are intentionally asymmetric. eve gives every agent a default
sandbox
([`docs/sandbox.mdx:6-10`](https://github.com/vercel/eve/blob/6c5f4fe25f659bb21e9e267cfee3c9f9bbfc9474/docs/sandbox.mdx#L6-L10),
[`127-132`](https://github.com/vercel/eve/blob/6c5f4fe25f659bb21e9e267cfee3c9f9bbfc9474/docs/sandbox.mdx#L127-L132));
Flue has no implicit sandbox. Flue agent mounts require application authentication **and**
conversation authorization
([`guide/routing.md:133-142`](https://github.com/withastro/flue/blob/a171cc1bc8a552775a820ae3d343ccd09597cc8c/apps/docs/src/content/docs/guide/routing.md#L133-L142)),
while eve's default channel falls back to a production-rejecting auth chain
([`docs/channels/eve.mdx:107-116`](https://github.com/vercel/eve/blob/6c5f4fe25f659bb21e9e267cfee3c9f9bbfc9474/docs/channels/eve.mdx#L107-L116)).

### The most important filesystem distinction

The phrase “filesystem-first” can hide three different contracts:

```text
Ziggy: Profile files = the running assistant's identity and live durable state
       (human-owned policy, curated memory, and Pi-owned sessions)
Flue:  TypeScript files = app authoring; database records = conversation truth
        sandbox files = a separately selected workspace lifetime
eve:   agent/ files = compiler input; Workflow state = conversation truth
        sandbox files = a separately selected workspace lifetime
```

Moving Ziggy onto either framework would therefore be a state-model migration, not a runtime
swap. `SOUL.md`, Pi JSONL trees, scoped Markdown memory, Profile auth, and repository-owned Pi
extensions do not map one-for-one to either framework's deployed conversation records.

## Runtime lineage and execution paths

### Ziggy: full Pi composition

```text
CLI / TUI / gateway
  -> ZiggyAgent Effect service
  -> PiAgent adapter
  -> createAgentSessionRuntime
  -> Pi AgentSession / runPrintMode / InteractiveMode
  -> Profile-local Pi JSONL + provider
```

Ziggy depends on `@earendil-works/pi-coding-agent@0.82.0` and delegates runtime creation,
streaming, tools, provider behavior, JSONL sessions, and terminal UI to it
([`package.json:17`](../../package.json),
[`src/adapters/pi/pi-agent.ts:503-542`](../../src/adapters/pi/pi-agent.ts)). The conversational `ZiggyAgent` seam is only `runOnce`, `openTui`, and `openChat`
([`src/application/agent.ts:9-26`](../../src/application/agent.ts)).

### Flue: lower-level Pi wrapped in Flue durability

```text
HTTP / dispatch / CLI admission
  -> durable submission + per-conversation queue
  -> Flue coordinator claims an attempt
  -> render agent function and hooks
  -> Flue Session
  -> Pi pi-agent-core.Agent
  -> Pi AI provider stream
  -> Flue canonical conversation records + settlement
```

Flue imports `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` `^0.83.0`
([`packages/runtime/package.json:87-88`](https://github.com/withastro/flue/blob/a171cc1bc8a552775a820ae3d343ccd09597cc8c/packages/runtime/package.json#L87-L88)).
It constructs Pi's `Agent`, configuring parallel tools and Flue's per-turn rerender callback
([`packages/runtime/src/session.ts:2211-2235`](https://github.com/withastro/flue/blob/a171cc1bc8a552775a820ae3d343ccd09597cc8c/packages/runtime/src/session.ts#L2211-L2235)).
Flue then projects Pi events into its own canonical stream; Pi JSONL and Pi coding-agent
extensions are not involved.

With durable storage configured, Flue's stronger accepted-work contract is explicit: one
terminal settlement per accepted submission, an ordered queue per conversation, and
at-least-once execution over exactly-once recording
([`guide/durability.md:7-39`](https://github.com/withastro/flue/blob/a171cc1bc8a552775a820ae3d343ccd09597cc8c/apps/docs/src/content/docs/guide/durability.md#L7-L39)).
Without `db.ts`, however, Node production uses in-memory SQLite and a restart loses all
conversations, submissions, and state
([`guide/database.md:39-51`](https://github.com/withastro/flue/blob/a171cc1bc8a552775a820ae3d343ccd09597cc8c/apps/docs/src/content/docs/guide/database.md#L39-L51)).

### eve: AI SDK loop wrapped in Workflow durability

```text
HTTP channel
  -> compile/resolve agent graph
  -> Workflow runtime and workflowEntry
  -> durable session driver
  -> one durable turn step
  -> AI SDK ToolLoopAgent, limited to one model/tool step
  -> Workflow stream/checkpoint
  -> park or dispatch the next durable step
```

eve's workflow entry is a Workflow SDK `"use workflow"` function
([`execution/workflow-entry.ts:96-169`](https://github.com/vercel/eve/blob/6c5f4fe25f659bb21e9e267cfee3c9f9bbfc9474/packages/eve/src/execution/workflow-entry.ts#L96-L169)).
Its harness creates Vercel AI SDK `ToolLoopAgent` with `stopWhen: isStepCount(1)`, making the
outer eve/Workflow loop the durable step authority
([`harness/tool-loop.ts:1029-1075`](https://github.com/vercel/eve/blob/6c5f4fe25f659bb21e9e267cfee3c9f9bbfc9474/packages/eve/src/harness/tool-loop.ts#L1029-L1075)).

Unlike Flue, eve does not promise an ordered durable input queue for a busy session. Its docs
require clients to wait for `session.waiting` or queue bursts in the channel/application
([`execution-model-and-durability.mdx:71-77`](https://github.com/vercel/eve/blob/6c5f4fe25f659bb21e9e267cfee3c9f9bbfc9474/docs/concepts/execution-model-and-durability.mdx#L71-L77)).

## What can be reused elsewhere

| Surface | Portability | Practical answer |
| --- | --- | --- |
| Agent Skills (`SKILL.md`) | **High** | Ziggy's existing spec-shaped skills can be copied/imported into Flue or placed under eve's `agent/skills/`. Review host-specific tool names, paths, binaries, and credentials. |
| Ziggy Pi extensions | **Low** | They target the full Pi coding-agent extension API. Flue uses Pi core directly and eve uses AI SDK; neither loads them. Port behavior as native Flue/eve tools instead. |
| Flue Pi providers | **Medium at the Pi protocol, low through Flue** | Flue exposes Pi `Provider` objects, but Ziggy currently goes through coding-agent `ModelRuntime` and pins a different Pi version. Share or adapt against Pi's provider protocol, not Flue internals. |
| Flue SDK | **High over HTTP** | `@flue/sdk` is ESM and works anywhere `fetch` exists. It addresses one deployed conversation URL; it does not embed Flue's loop. |
| eve HTTP/client/frontend surfaces | **High over HTTP** | `eve/client` and React/Vue/Svelte integrations are supported exports, but the `eve` package requires Node 24. Ziggy should use the wire protocol through its own fetch adapter or a Node sidecar unless direct Bun compatibility is proven. |
| Flue `start()` | **Medium within supported Node hosts** | Useful for a standalone Node script/test, but one process holds one Flue runtime and `@flue/runtime` requires Node 22.19+. It is not a supported nested runtime inside Ziggy's Bun/Effect composition. |
| eve framework adapters | **Medium inside web apps** | Next/Nuxt/SvelteKit and Nitro/self-hosting surfaces make eve usable in existing applications, but the compiled eve app remains its own runtime. |
| Channel packages | **Low across frameworks** | Flue channels are verified inbound Hono routes; eve channels own eve continuation semantics; Ziggy gateways are resident transport owners with direct outbound replies. Their contracts differ. |
| Persistence/durability engines | **Low as code, high as lessons** | Flue stores and eve Workflow worlds are coupled to their record/step protocols. Borrow invariants and adapter shapes, not implementations. |
| Sandboxes | **Low as framework objects** | Each has framework-specific tool/context contracts. The underlying Docker, Cloudflare, Vercel, or remote sandbox service can be shared through separate adapters. |
| Hosted agents | **High as separate services** | A Ziggy Pi tool can use fetch-portable `@flue/sdk` for Flue or a Ziggy-owned HTTP adapter for eve. Keep remote conversation state separate from the Profile. |

The runtime-package caveat is contractual, not a claim that Bun must fail: `eve` declares Node
24+ and `@flue/runtime` declares Node 22.19+
([eve package](https://github.com/vercel/eve/blob/6c5f4fe25f659bb21e9e267cfee3c9f9bbfc9474/packages/eve/package.json#L401-L403),
[Flue runtime package](https://github.com/withastro/flue/blob/a171cc1bc8a552775a820ae3d343ccd09597cc8c/packages/runtime/package.json#L77-L79)).
Use the HTTP boundary unless direct Bun execution is deliberately tested and supported.

### Skills are the real direct bridge

Flue intentionally parses the Agent Skills format and packages imported `SKILL.md` trees,
while also supporting inline `defineSkill`
([`skill-frontmatter.ts:16-75`](https://github.com/withastro/flue/blob/a171cc1bc8a552775a820ae3d343ccd09597cc8c/packages/runtime/src/skill-frontmatter.ts#L16-L75),
[`guide/skills.md:98-146`](https://github.com/withastro/flue/blob/a171cc1bc8a552775a820ae3d343ccd09597cc8c/apps/docs/src/content/docs/guide/skills.md#L98-L146)).
eve says standards-compliant Agent Skills port as-is and supports flat Markdown, packaged
`SKILL.md` directories, and TypeScript definitions
([`docs/skills.mdx:6-55`](https://github.com/vercel/eve/blob/6c5f4fe25f659bb21e9e267cfee3c9f9bbfc9474/docs/skills.mdx#L6-L55)).
Pi likewise discovers `SKILL.md` directories through explicit skill paths
([`docs/research/pi-sdk-surface.md:323-334`](pi-sdk-surface.md)).

Ziggy's skill text is therefore reusable. Its executable extension code is not. A skill that
says “call `memory_write`” or assumes Ziggy's Profile cwd remains syntactically portable but
behaviorally Ziggy-specific until rewritten for the destination host.

## Can Ziggy tie into either framework?

### 1. Remote delegation: yes, with a hard state boundary

A Ziggy Pi extension can expose a tool such as `call_flue_agent` or `call_eve_agent`. The tool
would use `@flue/sdk` or a Ziggy-owned HTTP adapter and return remote progress/final output.
This is a reasonable fit for a specialized hosted worker.

Required invariant:

```text
Ziggy Profile/session/memory authority != remote framework conversation authority
```

Do not let both systems write the same Profile files, pretend their transcripts are one
session, or compact one another's history. Persist the remote conversation ID/URL as an
explicit reference if continuity is required.

### 2. In-process Flue inside Ziggy: unsupported and unverified

Flue's Node `start()` is public, but `@flue/runtime` requires Node 22.19+, direct Bun
compatibility is unproven, and it allows one Flue runtime per process
([`packages/runtime/src/node/start.ts:101-109`](https://github.com/withastro/flue/blob/a171cc1bc8a552775a820ae3d343ccd09597cc8c/packages/runtime/src/node/start.ts#L101-L109)).
Using it inside Ziggy would introduce a second loop/session/state/provider authority beside Pi
coding-agent, plus Node-target assumptions inside a Bun/Effect product. A separate Flue service
or process is clearer.

### 3. In-process eve inside Ziggy: no supported seam

eve publishes authoring definitions and hosted/client integrations, not its internal
`workflowEntry` or `createToolLoopHarness`. Its package export map centers on compiled eve apps,
HTTP clients, web-framework integrations, and framework-specific extension points
([`packages/eve/package.json:58-287`](https://github.com/vercel/eve/blob/6c5f4fe25f659bb21e9e267cfee3c9f9bbfc9474/packages/eve/package.json#L58-L287)).
Run it as its own service if Ziggy needs it.

### 4. Making Ziggy usable in other places: not yet a supported contract

Ziggy already has the right internal direction: conversational CLI/TUI, gateways, and
automation execution all call `ZiggyAgent`. But the package is private, bin-only, and has no
export map
([`package.json:2-6`](../../package.json)). `ZiggyAgentShape` is also narrower than the intended
client-neutral surface: it lacks event observation, steering, abort, session identity, and
reconnect semantics.

The smallest honest reuse move is **not** to adopt eve or Flue. It is to publish a headless
Ziggy application surface around Profile policy and `ZiggyAgent`, then add a transport only when
a second process or external client is actually required.

## What Ziggy should borrow—and what it should not

### Borrow now or soon

1. **Keep Agent Skills as the cross-runtime content format.** Test portable packages against
   host-specific tool/path assumptions.
2. **Borrow Flue's accepted-submission vocabulary when gateway work becomes load-bearing:**
   admission, attempt, settlement, idempotency key, and canonical recorded outcome are clearer
   than treating a live chat handle as durable work.
3. **Borrow both frameworks' separation of conversation durability from workspace durability.**
   Ziggy already separates curated memory from Pi transcripts; keep any future remote sandbox
   as a third explicit authority.
4. **Add a public headless boundary before adding web clients.** Stabilize prompt/events/abort/
   dispose/session identity in-process first; HTTP can project that contract later.

### Do not borrow yet

1. Do not replace Pi JSONL with a second conversation engine merely to match a framework.
2. Do not add a compiler/Vite/Nitro/Workflow layer to a Profile-first assistant.
3. Do not copy Flue/eve channel packages into Ziggy; their ownership and outbound contracts do
   not match resident gateways.
4. Do not merge remote eve/Flue state into Profile memory or Pi transcripts.
5. Do not treat shared Pi ancestry as binary compatibility. Ziggy pins full coding-agent
   `0.82.0`; Flue uses lower-level Pi packages `^0.83.0` and owns a different session protocol.

## Decision summary

- **Replace Ziggy with Flue?** Only if the product goal changes from a local folder-assistant to
  a deployable durable agent application framework. Flue is the closer migration target because
  of Pi, but Profile state and Pi sessions still require a redesign/migration.
- **Replace Ziggy with eve?** No for the current product. eve is a stronger fit for Vercel/Nitro
  backend agents and web application integration, not for preserving Pi/Profile semantics.
- **Use either from Ziggy?** Yes as a separate remote agent service over its public HTTP
  boundary; use Flue's fetch-portable SDK and a Ziggy-owned eve HTTP adapter unless Bun support
  is proven.
- **Use Ziggy assets elsewhere?** Skills: yes. Pi extensions, memory tools, channels, and
  sessions: adapt or rewrite.
- **Make Ziggy itself reusable elsewhere?** Expose and stabilize its headless application API;
  do not expose Pi adapter internals or invent a remote protocol before a real external client
  needs one.

## Evidence boundary and caveats

- Findings describe the exact commits listed above, not every released version.
- External documentation was checked against representative source execution paths. Where docs
  and source differed, source was treated as authoritative.
- No claim is made that Workflow durability, Flue database durability, or sandbox persistence
  has identical guarantees across every adapter; physical guarantees depend on the selected
  world/store/backend.
- Apache-2.0 licenses in eve and Flue permit code reuse subject to their license and notice
  obligations. Architectural fit remains the larger constraint.
