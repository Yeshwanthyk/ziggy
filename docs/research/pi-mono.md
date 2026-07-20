# pi-mono architecture report

pi-mono is the closest existing system to ziggy's target shape: a small agent-loop core, a
thin/lazy provider layer, and a JSONL session format, wrapped by a much larger coding-agent CLI
and TUI. Ziggy takes the loop/provider split as its template and explicitly does not take the
coding-agent package's size as a target.

Date: 2026-07-19
Source: `github.com/badlogic/pi-mono` (upstream), local cache at
`/Users/yesh/Documents/personal/reference/pi-mono` (also mirrored in opensrc at
`github.com/badlogic/pi-mono@bc469b0`). Published packages consumed by ziggy:
`@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` (opensrc: `github.com/earendil-works/pi@0.80.6`).

## 1. Package layout and dependency direction

Monorepo, `packages/*`, npm workspaces. Approximate size (`find -name '*.ts' | xargs wc -l`,
excluding `node_modules`/`dist`):

| package        | LOC      | role                                                                                                                                                                                                    |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`        | ~14,000  | bare agent loop — `AgentLoopConfig`, `AgentEvent` stream, tool execution, steer/follow-up queues. No CLI, no TUI, no session persistence.                                                               |
| `ai`           | ~52,000  | provider/wire layer — one `StreamFn` per API family, model registry, OAuth, image models. Most of the LOC is generated model metadata + per-provider request/response mapping, not orchestration logic. |
| `tui`          | ~25,700  | terminal rendering components, independent of `agent`.                                                                                                                                                  |
| `orchestrator` | ~2,000   | small — multi-agent coordination on top of `agent`.                                                                                                                                                     |
| `coding-agent` | ~111,500 | the actual "pi" CLI/TUI product: session persistence, extensions, slash commands, interactive mode, session picker, and every product feature. This is where most of the mass lives.                    |

Dependency direction is strictly `coding-agent → agent → ai`, and `tui` is a leaf consumed by
`coding-agent`. Nothing in `agent` or `ai` imports from `coding-agent` or `tui`. This is the
structural fact ziggy's own `core`/`protocol` split is modeled on: a small loop package that only
knows about `ai`, and a much larger product-surface package layered on top.

**Where minimalism ends**: `agent` (loop) and `ai` (wire calls) are genuinely small and
single-purpose. `coding-agent` is not — it carries session tree/compaction, extension
loader/runner/wrapper, slash-command registry, interactive-mode UI state, session picker/selector
components, and more. Ziggy's core (`packages/core`) is deliberately scoped closer to
`agent`+session-persistence only; the product surfaces ziggy is planning (TUI, CLI, extensions)
stay in separate packages rather than folding into one `coding-agent`-sized package.

## 2. `agent` package: loop vs. harness split

`packages/agent/src/`: `agent.ts`, `agent-loop.ts` (792 lines), `types.ts` (430 lines), `node.ts`,
`proxy.ts`, `index.ts`.

`AgentLoopConfig` (`types.ts:140`) extends `SimpleStreamOptions` — the loop config _is_ a stream
options superset, not a separate config surface. Key loop-shape types:

- `AgentEvent` union (`types.ts:415-429`) — lifecycle-tagged events, not a monolithic message
  stream:
  ```ts
  type AgentEvent =
    | { type: "agent_start" }
    | { type: "agent_end"; messages: AgentMessage[] }
    | { type: "turn_start" }
    | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
    | { type: "message_start"; message: AgentMessage }
    | {
        type: "message_update";
        message: AgentMessage;
        assistantMessageEvent: AssistantMessageEvent;
      }
    | { type: "message_end"; message: AgentMessage }
    | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
    | {
        type: "tool_execution_update";
        toolCallId: string;
        toolName: string;
        args: any;
        partialResult: any;
      }
    | {
        type: "tool_execution_end";
        toolCallId: string;
        toolName: string;
        result: any;
        isError: boolean;
      };
  ```
  A "turn" is explicitly documented as one assistant response plus any tool calls/results — the
  same granularity ziggy uses for its own Turn noun.
- `BeforeToolCallResult`/`AfterToolCallResult`/`BeforeToolCallContext`/`AfterToolCallContext`
  (`types.ts:60-116`) — before/after tool hooks are first-class loop config, not bolted on. Ziggy's
  S1 plan mirrors this hook shape for its own before/after tool hooks.
- `ToolExecutionMode = "sequential" | "parallel"` and `QueueMode = "all" | "one-at-a-time"`
  (`types.ts:41,49`) — steer/follow-up queue draining is a config choice, not hardcoded.

`agent-loop.ts` structure (`runLoop`, `agentLoop`/`agentLoopContinue`/`runAgentLoop`): an **outer
loop** that continues when queued follow-up messages arrive after the agent would otherwise stop,
wrapping an **inner loop** that processes tool calls and steering messages
(`agent-loop.ts:166-270`, comments in source). Steering is checked "at start (user may have typed
while waiting)" — i.e., steer messages are drained opportunistically before the next model call,
not via interrupt/preemption of an in-flight stream. A `"length"` stop reason (output cut off by
token limit) explicitly fails _every_ pending tool call rather than executing possibly-truncated
arguments (`agent-loop.ts:208-210`) — a defensive pattern worth keeping in ziggy's own loop.

Tool execution has two paths, `executeToolCallsSequential` and `executeToolCallsParallel`
(`agent-loop.ts:435,491`), selected by `ToolExecutionMode`. `AgentTool` (`types.ts:373`) extends a
plain `Tool<TParameters>` with typed-details support, and untyped (JS extension) tools that return
no content are normalized so a null result never leaks into session history or provider payloads
(`agent-loop.ts:779-780`) — a concrete "extensions must not corrupt canonical history" precedent.

## 3. `ai` package: two-tier provider design

`packages/ai/src/`: top-level `stream.ts`/`types.ts`/`models.ts`/`models-store.ts`/`oauth.ts`/
`cli.ts`/`compat.ts`, plus `providers/*.ts` (one file per wire API/vendor) and `auth/*.ts`
(credential store, OAuth flows).

**Tier 1 — wire APIs**: ~10 distinct `StreamFn` implementations, one per request/response shape
(`openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`,
`anthropic`, `amazon-bedrock`, `google`/`google-vertex`/`google-gemini-cli`, plus shared helpers
in `openai-responses-shared.ts`/`google-shared.ts`/`transform-messages.ts`).

**Tier 2 — providers**: ~30 named vendors (`zai`, `xai`, `together`, `openrouter`, `mistral`,
`cerebras`, `minimax`, `moonshotai`, `github-copilot`, `cloudflare-workers-ai`, regional variants
like `xiaomi-token-plan-cn`/`-sgp`, etc.), most defined as thin `*.models.ts` metadata files that
point at a Tier-1 wire API plus a `baseUrl`. This is the exact mechanism ziggy relies on for
"OpenAI-compatible endpoint" support without a `registerProvider` ceremony: a provider is a
`Model` object with a `baseUrl`, not a new code path.

`StreamOptions` (`types.ts:113-143`) — the fields ziggy's provider adapter passes through as-is:
`temperature`, `maxTokens`, `signal`, `apiKey`, `transport`, `cacheRetention` ("Prompt cache
retention preference... Default: short"), `sessionId` ("Optional session identifier for providers
that support session-based caching... enable prompt caching, request routing, or other
session-aware features. Ignored by providers that don't support it."), plus `onPayload`/
`onResponse` inspection hooks. `cacheRetention`/`sessionId` being plain optional fields (not a
separate caching subsystem) is why ziggy can pass session identity straight through to pi-ai's
`streamSimple` without building its own cache-control layer.

`openai-codex-responses.ts` and its OAuth counterpart in `auth/` are the concrete evidence that
ChatGPT Plus/Pro (codex-subscription) auth is _already_ an ordinary wire provider in this stack —
this is what let ziggy drop the "delegated engine" design and treat codex-subscription auth as
just another pi-ai provider (D7).

## 4. Session format (`coding-agent`): JSONL v3 tree

`packages/coding-agent/src/core/session-manager.ts` (session persistence) and `agent-session.ts`
(runtime wiring). Sessions are per-file JSONL: `<timestamp>_<sessionId>.jsonl` inside a session
directory; `SessionManager` filters directory listings on `.endsWith(".jsonl")`.

Entry types (`SessionEntry` union, `session-manager.ts:46-140`): `SessionMessageEntry`,
`ThinkingLevelChangeEntry`, `ModelChangeEntry`, `CompactionEntry<T>`, `BranchSummaryEntry<T>`,
`CustomEntry<T>`, `LabelEntry`, `SessionInfoEntry`, `CustomMessageEntry<T>`. Every entry has `id`
and `parentId: string | null` (`SessionEntryBase`, line 49) — sessions are a **tree**, not a flat
log; a schema-version field is stamped per entry (`entry.version = 3`, line 259) with an explicit
migration path (`migrateV2ToV3`, `if (version < 3)`, lines 226-284).

Reading the active context walks the tree from root to the current leaf
(`buildActiveSessionEntryList`-equivalent logic, lines 407-455): if the path contains a
`CompactionEntry`, the _latest_ compaction entry is included, older summarized entries before its
`firstKeptEntryId` are omitted, and only entries after the compaction point are replayed in full
(lines 407-448). This is the direct precedent for ziggy's own "frozen snapshot + volatile suffix"
context assembly — compaction is a tree operation (branch off a summary node), not a destructive
rewrite of the log. Resume/branching switches which file/leaf is active (`switchToSessionFile`,
comment at line 825) without touching prior entries.

## 5. Extension mechanism and Bun-compiled-binary loading

`packages/coding-agent/src/core/extensions/{loader,runner,types,wrapper,index}.ts`. `loader.ts`
uses **jiti**, not native `import()`, specifically because native `import()` cannot resolve
arbitrary on-disk extension paths from inside a Bun single-file compiled binary. Two loader modes
selected by `isBunBinary` (`loader.ts:413-416`):

```ts
// In Bun binary: use virtualModules for bundled packages (no filesystem resolution)
// Also disable tryNative so jiti handles ALL imports (not just the entry point)
...(isBunBinary
  ? { virtualModules: VIRTUAL_MODULES, tryNative: false }
  : { alias: getAliases() })
```

`VIRTUAL_MODULES` (comment at line 47: "Modules available to extensions via virtualModules (for
compiled Bun binary)") is a fixed allowlist of packages baked into the compiled binary and handed
to extensions by name instead of by filesystem resolution — extensions can't just `import` any
npm package that happens to be on disk next to them when running compiled.

This is a materially different (and more conservative) approach than what ziggy's own empirical
Bun-plugin-loading test found viable (`docs/research/bun-compiled-plugin-loading.md`): pi's
coding-agent uses jiti + virtual-module allowlisting everywhere, whereas ziggy confirmed that
Bun's _native_ `await import()` on absolute on-disk paths works directly from a compiled binary,
including nested relative imports, `node:` builtins, and adjacent `node_modules` resolution. Pi's
choice to route through jiti is likely defensive/portability-driven (it also has to work
uncompiled, under Node, etc.) rather than evidence that native dynamic import is unsafe — but it
is direct prior art that a serious, shipped project treats compiled-binary + arbitrary-on-disk
extension code as risky enough to sandbox behind a virtual-module allowlist rather than trusting
native resolution. Ziggy's tiered extension model (D8) keeps this same instinct: only a narrow,
approved `defineTool` escape hatch loads in-process; everything else is manifest+subprocess.

## 6. TUI layering

`packages/tui` has zero dependency on `coding-agent` — it is rendering primitives (components,
key handling, layout) consumed by `coding-agent`'s interactive mode, not a session-aware client
itself. Ziggy's own `tui` package is modeled the same way: it should depend only on `protocol`
(the attach-protocol client SDK), not on `core`.

## Summary of transferable patterns

1. Loop package (`agent`) has zero knowledge of persistence, CLI, or extensions — only
   `AgentLoopConfig`/`AgentEvent`/tool execution. Ziggy's `core` session engine follows this.
2. Provider layer is two-tier (wire API vs. named vendor-as-metadata-over-a-wire-API) with
   `baseUrl` as the generic "OpenAI-compatible endpoint" mechanism — no registry ceremony needed.
3. `cacheRetention`/`sessionId` are plain `StreamOptions` fields, not a separate subsystem —
   ziggy's provider adapter can pass session identity straight through.
4. Session persistence is an id/parentId tree with a stamped schema version and an explicit
   migration path; compaction is a branch operation, read-path walks root→leaf and honors the
   latest compaction node.
5. Steer/follow-up queues are drained opportunistically inside an outer/inner loop split, not via
   stream preemption.
6. Extension loading in a compiled binary is treated as risky by a real shipped project (jiti +
   virtual-module allowlist), reinforcing why ziggy keeps in-process extension loading as a single
   narrow, approved escape hatch rather than the default tier.
7. `coding-agent`'s ~111k LOC is the cautionary example of what NOT to target — ziggy's `core`
   should stay closer to the `agent` package's scope.
