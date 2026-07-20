# Flue — architecture reference

One-line summary: Flue is a TypeScript "agent harness framework" (Astro team) that compiles agent/workflow projects into deployable server artifacts, built around a three-interface waist (tools, sandbox, persistence) that every storage/sandbox/channel backend implements from _outside_ the runtime.

Date: 2026-07-19
Source: `github.com/withastro/flue` (main) — local cache `/Users/yesh/.opensrc/repos/github.com/withastro/flue/main`

## What flue is

Flue is "not another SDK" — a programmable harness that gives a model sessions, tools, skills, instructions, filesystem access, and a sandbox, then lets you deploy the same agent definition to Node, Cloudflare Workers, GitHub Actions, GitLab CI, or a sandbox provider (Daytona, etc.). The core primitive is `createAgent(initialize)`, a lazy, frozen initializer — not a live instance — that the runtime calls every time it needs to prepare a `Harness` (on a workflow's `ctx.init()`, or when an addressable agent interaction starts).

Terminology tree, from `AGENTS.md` (flue is disciplined about keeping this contract explicit and enforced by convention, not just docs):

```
Agent profile      — one reusable defineAgentProfile(...) value
Created agent      — one runtime initializer from createAgent(...)
Agent module       — agents/<name>.ts; default-exports a created agent
└─ AgentInstance    — URL <id>; provided to createAgent(({ id }))
   └─ Harness       — runtime-initialized agent environment; default name "default"
      └─ Session    — one harness.session(name?); default name "default"
         └─ Operation — one session.prompt / skill / task / shell call
            └─ Turn  — one LLM round-trip inside pi-agent-core
Workflow            — workflows/<name>.ts; exports run(...)
└─ Workflow run/invocation — unique ctx.id === runId
```

Direct HTTP/WS agent prompts run inside persistent Sessions and are explicitly _not_ called "runs" — "runs" is reserved for workflow invocations. This kind of precise, enforced vocabulary (their `AGENTS.md` calls out specific words like "sandbox adapter" vs "channel" and forbids terminology drift) is a direct precedent for ziggy's own primitive vocabulary contract.

## Monorepo shape and tooling

Hub-and-spoke pnpm workspace (`pnpm@11`, Node `>=22`, TypeScript `6.0.3` pinned via `pnpm.overrides`):

- `packages/runtime` (`@flue/runtime`) — the hub: harness, sessions, tools, sandbox plumbing. Everything else depends on it or nothing.
- `packages/cli` (`@flue/cli`) — Vite-based build/dev tooling, discovery, target integration, the `flue` binary.
- `packages/sdk` (`@flue/sdk`) — client SDK for consuming _deployed_ agents/workflows (invoke, stream).
- `packages/opentelemetry`, `packages/postgres`, `packages/libsql`, `packages/mysql`, `packages/mongodb`, `packages/redis` — adapter/observability spokes.
- Channel packages: `packages/slack`, `discord`, `telegram`, `teams`, `whatsapp`, `twilio`, `linear`, `notion`, `zendesk`, `shopify`, `stripe`, `resend`, `intercom`, `google-chat`, `github`, `salesforce-marketing-cloud`, `messenger` — each a thin spoke.
- `examples/*` — one directory per channel/database/deploy-target integration test fixture, plus `hello-world`, `cloudflare`, `react-chat`, `chat-sdk`, `braintrust`, `imported-skill`.
- `blueprints/` — the markdown integration-guide corpus (see below).

Tooling: `turbo` for task graph, `biome` (lint+format) + `knip` (dead-export detection) + `prettier` (style), `check` = `turbo run build check:lint check:types && turbo run test`. This "biome+knip+turbo" combination is the direct precedent ziggy adopted (oxlint+oxfmt+knip) — same shape, different linter (oxc instead of biome) because ziggy is Bun-first.

**Channel packages depend on nothing runtime-side.** They are plain HTTP verification + SDK wrapper + tool-definition packages that a project imports; they don't import `@flue/runtime` themselves in a way that couples them to its internals — this is the proof-point that "gateway/channel packages can be dependency-free leaves of a thin protocol/tool surface" (cited in ziggy's Gateway decision, D-Gateway / D9 area).

## The three-interface waist

`packages/runtime/src/adapter.ts` documents this explicitly (comment reproduced near-verbatim because it's exactly the discipline ziggy wants to copy):

> This surface is intentionally narrow: store interfaces, vocabulary types, and pure adapter helper functions. It does not expose runtime orchestration, provider plumbing, or generated-entry internals. There is ONE adapter contract for every backend — no SQL-only or "expert" tiers. Each store interface documents its per-method invariants in prose (atomicity, idempotency, gating conditions) so that non-SQL backends such as MongoDB are first-class implementations. An adapter is correct when the executable contract suites pass: `defineStoreContractTests`, `defineRunStoreContractTests`, and `defineEventStreamStoreContractTests` from `@flue/runtime/test-utils`.

The three waist interfaces:

1. **`ToolDefinition`** (`tool.ts`, `tool-types.ts`) — `defineTool({ name, description, parameters, execute })`. `parameters` accepts either a valibot schema (converted once to plain JSON Schema via `toJsonSchema`, cached by object identity in a `WeakMap` so the agent loop's compiled-validator cache stays warm across turns) or raw JSON Schema passed through unchanged. `execute` is wrapped so model-supplied args are `v.safeParse`'d before the user callback runs; validation failures throw `ToolInputValidationError`, which becomes an error tool-result the model can self-correct from (not a hard crash).
2. **`SessionEnv` / `SandboxApi`** (`sandbox.ts`) — the execution-environment seam. `createFlueFs(env)` adapts any `SessionEnv` (local, bash-factory, remote `SandboxApi` wrapper) to one public `FlueFs` surface (`readFile`, `readFileBuffer`, `writeFile`, `stat`, `readdir`, `exists`, `mkdir`, `rm`). Cross-mode contract like "writeFile creates missing parent directories" is implemented exactly once (`writeFileCreatingParents`) and shared by every adapter, rather than reimplemented per backend — write-first, retry-with-mkdir-on-failure, so the common path costs one round trip.
3. **`PersistenceAdapter`** (`adapter.ts`, `agent-execution-store.ts`) — `SessionStore`, `RunStore`, `EventStreamStore` (stable) plus the `AgentSubmissionStore` turn-journal/stream-chunk/lease method groups (explicitly marked unstable pre-1.0). Built-in SQL adapters (`postgres`, `mysql`, `libsql`) implement it via `sql-*.ts` helpers; non-SQL adapters (`mongodb`, `redis`) implement the same contract natively. Adapters are proven correct by passing the shared `defineStoreContractTests` suite — not by code review of the implementation. This is the exact "contract-test harness" pattern ziggy's storage seam (D-storage) is modeled on.

## Domain model detail

- **`createAgent`** (`agent-definition.ts`) returns `Object.freeze({ __flueCreatedAgent: true, initialize })` — a marker-tagged, frozen value, not a class instance. `defineAgentProfile(profile)` validates against a strict valibot schema (`AgentProfileSchema`, `v.strictObject` — unknown fields are a hard validation error, not silently dropped) and returns the profile unchanged; profiles compose via `resolveAgentProfile`, which merges a profile's `skills`/`tools`/`subagents` arrays with per-call overrides (`hasOwn` checks distinguish "explicitly set to undefined" from "not passed").
- **`Harness`** (`harness.ts`) is the composition root: holds `sessions` (`get`/`create`/`delete`, keyed by name, `openSessions: Map<string, Session>` + a `pendingSessionOperations` map to serialize concurrent open/create on the same name), `fs` (via `createFlueFs`), and `shell()` (returns a `CallHandle`, i.e. an abortable/awaitable handle wired to shell execution + event emission). It is constructed with `instanceId`, `name`, `config`, `env` (SessionEnv), `store` (SessionStore), an `eventCallback`, `agentTools`, an optional `toolFactory`, and an optional `submissionStore` for durable-execution turn journaling.
- **`Session`** (`session.ts`) is the internal implementation; user code only ever receives the facade from `createPublicSession()`, which exposes exactly the `FlueSession` contract — deliberate internal/public split so the public surface can't accidentally leak internals. `Session` directly imports `Agent`, `AgentMessage`, `AgentTool`, `AgentToolResult`, `StreamFn` from `@earendil-works/pi-agent-core` and `streamSimple`, `Model`, `Message`, etc. from `@earendil-works/pi-ai` — i.e. flue _does_ depend on pi-agent-core for its loop (unlike ziggy's decision to own the loop itself), and calls `streamSimple` from pi-ai for the actual model call, exactly matching ziggy's understanding of pi-ai as a wire-only `streamSimple(model, context, options)` primitive. `Session` also owns compaction (`compaction.ts`: `calculateContextTokens`, `shouldCompact`, `isContextOverflow`, `prepareCompaction`, `compact`), skill activation (`createActivateSkillTool`, `createPackagedSkillReadTool`), the `task()` tool for subagent delegation (`createTaskTool`, with `TaskDepthExceededError` guarding runaway recursion), and synthetic result tools.
- **Synthetic finish/give_up tools** (`result.ts`): every session gets two model-callable structured-output tools baked in — `FINISH_TOOL_NAME` and `GIVE_UP_TOOL_NAME` — used to force the model to explicitly signal task completion or explicit abandonment rather than the harness having to guess from a plain text response. `ResultUnavailableError` covers the case where a caller asks for a structured result but the agent never called either tool.
- **Error hierarchy** (`errors.ts`) is deliberately centralized in one file (their own comment: consolidating "keeps message tone and detail level consistent," "notice duplicates," "establish norms by example"). Every error class carries three separately-audienced fields: `message` (one sentence, caller-safe, always rendered), `details` (longer caller-safe prose — explicitly forbidden from leaking sibling/neighbor enumeration, filesystem paths, or source-fix instructions), and `dev` (filesystem paths, framework internals, fix instructions — rendered only in local dev). Consumers are expected to `instanceof`-check against exported classes and read structured fields, never parse `message` strings — message text is not API. This "two-audience error taxonomy" is a strong pattern ziggy should consider for its own error types (daemon-internal vs. client-facing).
- **`FLUE_SCHEMA_VERSION`** (`schema-version.ts`) — every persisted store durably records the schema/format version it was created with (`flue_meta` key/value table for SQL backends; adapter-native equivalent otherwise) and _refuses to open_ a store with an unknown or newer version (`PersistedSchemaVersionError`). Explicitly: "There is deliberately no migration framework here — just the stamp and the loud check." When a persisted format changes, migration logic lands alongside a version bump; there's no generic migration runner. This is the exact model ziggy adopted for its own schema-version stamp decision (D-schema-version): loud refusal over silent corruption, no migration framework at v1.

## Blueprints

`blueprints/` is the source-of-truth markdown corpus served at `https://flueframework.com/cli/blueprints/<slug>.md` and returned verbatim by the `flue add`/`flue update` CLI commands — the CLI does zero code generation itself; a blueprint is "a Markdown guide for an AI coding agent, not an npm package or runtime abstraction. The CLI fetches and prints the guide; the coding agent edits the user's project."

- Four kinds: `sandbox`, `channel`, `database`, `tooling`. New kinds require discussing CLI/runtime/maintenance changes with the flue team first — kinds are a closed, deliberately curated set.
- File naming: `<kind>--<name>.md` (e.g. `channel--slack.md`) for named blueprints, `<kind>.md` with `"root": true` frontmatter for the generic fallback guide (e.g. `channel.md`, used when a user points `flue add channel <url>` at an unsupported provider).
- Frontmatter is JSON (not YAML), fenced by `---`: `{ "kind": ..., "version": <monotonic int>, "website"?: ..., "aliases"?: [...], "root"?: true }`. The website strips frontmatter before returning the guide to the CLI.
- Guides are written as instructions _to the coding agent_, addressing it directly ("You are an AI coding agent adding a provider channel to a Flue project..."), and must work identically for a fresh `add` and a re-run `update` — no conditional show/hide branching in the prose. The generic `channel.md` guide walks the agent through: read `AGENTS.md` first, detect package manager/target, pick the first existing source root (`.flue/` > `src/` > repo root), inspect existing `channels/`/`agents/`/`workflows/`, verify-then-parse the provider's webhook signature before touching application logic, and stamp a `// flue-blueprint: channel/<provider>@1` marker comment in the generated file so future `update` runs can diff against a known guide version.
- This markdown-guide-as-integration-mechanism, addressed directly to an agent, applied as a real filesystem edit rather than through an abstraction layer, is the direct model for ziggy's own Blueprint concept (long-tail extension integrations an agent applies as edits rather than a loaded plugin).

## Transferable ideas for ziggy

- Three-interface waist (tools / sandbox-env / persistence) with ONE contract per interface and executable contract-test suites as the correctness bar, not code review — directly informs ziggy's storage seam (local now, Cloudflare later) and its extension tool ABI.
- Frozen, lazy `createAgent`-style initializers over live singletons — avoids accidental startup-order coupling.
- Public/internal split for stateful objects (`Session` vs. `createPublicSession()` facade) as the pattern for anything ziggy exposes across the daemon/client boundary.
- Centralized, two-audience error taxonomy (`message`/`details` caller-safe, `dev` internal-only) — a candidate shape for ziggy's own error types crossing the attach-protocol boundary.
- Schema-version stamp + loud refusal + no migration framework, exactly matching ziggy's own decision — flue is direct precedent, not just inspiration.
- Blueprint-as-markdown-guide-to-an-agent, versioned frontmatter, `update` reusing the same guide as `add` — direct model for ziggy's Blueprint mechanism.
- Dependency-free channel packages as proof that gateway/channel code needn't depend on the runtime package — direct precedent for ziggy's Gateway packages depending only on `protocol`.
