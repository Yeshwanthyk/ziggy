# pi-ai as ziggy's provider layer

Dependency assessment for `@earendil-works/pi-ai`: what it is, what it costs, and the verdict on how ziggy should depend on it (directly, pinned, api/*-scoped) versus its sibling `pi-agent-core` (not a dependency — ziggy owns the agent loop).

Date: 2026-07-19
Source repo: https://github.com/earendil-works/pi (local clone: `/Users/yesh/.opensrc/repos/github.com/earendil-works/pi/0.80.6`, package: `packages/ai`)
Primary sources: `packages/ai/{package.json,CHANGELOG.md,src/index.ts,src/models.ts,src/types.ts,src/api/lazy.ts,src/auth/{types,helpers}.ts,src/providers/openai-codex.ts,src/utils/oauth/{openai-codex,load,pkce}.ts}`

## What it is

`@earendil-works/pi-ai` (published as `@earendil-works/pi-ai`, version `0.80.6` at research time) is a "unified LLM API with automatic model discovery and provider configuration" — it normalizes ~30 providers' chat-completion APIs behind a common `Provider`/`Model`/stream contract, handles per-provider auth (API key + OAuth), and computes usage/cost. It is one package in the `pi` monorepo alongside `packages/agent` (published as `@earendil-works/pi-agent-core`, "general-purpose agent with transport abstraction, state management, and attachment support" — the actual agent _loop_, deliberately out of scope for ziggy, see the closing section), `packages/coding-agent`, `packages/orchestrator`, and `packages/tui`.

## Consumable API surface

### Root entrypoint is core-only, side-effect free

As of the `0.80.0` breaking change (documented in `CHANGELOG.md`), the root `@earendil-works/pi-ai` import is explicitly "core-only and side-effect free": no generated model catalogs, no provider factories, no api-registry, no OAuth implementations. `src/index.ts`'s own comment states this directly:

```ts
// Core only, side-effect free: no generated catalogs, no provider factories,
// no api-registry, no OAuth implementations, no compat. Provider factories
// live under "@earendil-works/pi-ai/providers/*", API implementations under
// "@earendil-works/pi-ai/api/*", the old global API under
// "@earendil-works/pi-ai/compat".
```

The root re-exports only types, pure helpers (`calculateCost`, `hasApi`, `modelsAreEqual`, `getSupportedThinkingLevels`, `clampThinkingLevel`), `createModels`/`createProvider`, and the auth/credential-store interfaces. Everything with real weight or side effects — generated model catalogs, concrete provider factories, OAuth flow implementations — lives behind subpath exports (`package.json` `exports` map): `./compat` (legacy global API, temporary), `./providers/*`, `./api/*`, `./oauth`, `./bedrock-provider`. This is the same exports-subpath discipline flue uses (see `docs/research/flue.md`) — a hub-and-spoke package shape where the root stays cheap and consumers opt into exactly the surface they need.

### Per-API `stream`/`streamSimple` modules

`src/api/*.ts` — one module per wire protocol, not per provider: `anthropic-messages.ts`, `openai-completions.ts`, `openai-responses.ts`, `openai-codex-responses.ts`, `azure-openai-responses.ts`, `bedrock-converse-stream.ts`, `google-generative-ai.ts`, `google-vertex.ts`, `mistral-conversations.ts`, plus shared helpers (`openai-responses-shared.ts`, `openai-prompt-cache.ts`, `transform-messages.ts`, `simple-options.ts`) and non-chat modules (`cloudflare.ts`, `github-copilot-headers.ts`, `openrouter-images.ts`). Every API module exports exactly `stream` and `streamSimple` — this uniform two-function contract is `ProviderStreams` (`src/types.ts`):

```ts
export interface ProviderStreams {
  stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
}
```

Providers with multiple wire protocols (e.g. OpenAI: completions vs. responses vs. Codex-responses) can supply either a single `ProviderStreams` implementation or a `Partial<Record<TApi, ProviderStreams>>` map keyed by `model.api`, dispatched by `createProvider()`. Consumers can import a single `api/*` module directly and bypass the `Models` registry entirely — `stream`/`streamSimple` are plain functions taking `(model, context, options)`, no provider-registry object required. This is confirmed by each `.lazy.ts` sibling file (`openai-codex-responses.lazy.ts`, etc.), which wraps the corresponding module via `lazyApi()` (`src/api/lazy.ts`) for deferred dynamic import.

### `Model` as a plain data object, `Provider`/`Models` as thin orchestration

`Provider<TApi>` (`src/models.ts`) is a small interface: `id`, `name`, optional `baseUrl`/`headers`, required `auth: ProviderAuth`, `getModels()` (sync, must not throw — a throwing implementation is treated as "no models"), optional `refreshModels()` for dynamic providers (concurrent calls share one in-flight fetch; failures leave the last-known list in place and reject the caller), and `stream`/`streamSimple`. `createProvider(input: CreateProviderOptions)` builds one from parts — this is what every built-in provider factory (`src/providers/*.ts`) and any custom `models.json` provider goes through. `Models`/`MutableModels` is the runtime collection: `setProvider`/`getProvider`/`getModels`/`getModel`/`refresh`/`getAuth`/`stream`/`complete`/`streamSimple`/`completeSimple`. Ziggy does not need this registry layer at all if it only ever talks to a small, statically-known set of providers — it can import `api/*` modules and provider factories directly and skip `createModels()`.

### Message/usage types

`src/types.ts` (715 lines) defines the wire-agnostic message model ziggy would adopt as its own internal representation if it depends on pi-ai directly: `UserMessage` (`content: string | (TextContent|ImageContent)[]`), `AssistantMessage` (`content: (TextContent|ThinkingContent|ToolCall)[]`, plus `api`/`provider`/`model`/`responseModel?`/`responseId?`/`diagnostics?`/`usage`/`stopReason`/`errorMessage?`/`timestamp`), `ToolResultMessage<TDetails>`, and `Usage`:

```ts
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number; // subset of cacheWrite written with 1h retention (Anthropic only)
  reasoning?: number; // subset of output; only set by providers that report a breakdown
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
```

`StopReason = "stop" | "length" | "toolUse" | "error" | "aborted"`. `calculateCost(model, usage)` (`src/models.ts`) applies `model.cost` tiers (`model.cost.tiers` keyed by `inputTokensAbove`, matched by the highest threshold the actual input-token count clears) and the Anthropic-specific 2x-base-rate handling for 1h cache writes (`longWrite = usage.cacheWrite1h ?? 0`, billed at `rates.input * 2` instead of `rates.cacheWrite`) — a real provider-billing-quirk ziggy would either have to reimplement or get for free by depending on pi-ai for cost accounting specifically.

## Auth: API-key and OAuth as two symmetric strategies

`ProviderAuth = { apiKey?: ApiKeyAuth; oauth?: OAuthAuth }` (`src/auth/types.ts`) — every provider has _some_ auth story, even ambient-only ones (env vars, AWS profiles, ADC files, keyless local servers), which still implement `ApiKeyAuth.resolve()` to report configured/unconfigured state. `envApiKeyAuth(name, envVars)` (`src/auth/helpers.ts`) is the standard case: stored credential wins, else first non-empty env var, with a `login` that prompts for a secret. Providers with non-standard resolution write their own `ApiKeyAuth`.

`OAuthAuth` is a three-method interface — `login(callbacks)`, `refresh(credential)` (network call, throws on `invalid_grant` etc., run under the credential store's per-provider lock so concurrent requests can't double-refresh a rotating token), `toAuth(credential)` (side-effect-free derivation of `{apiKey, headers?, baseUrl?}` from a valid credential — async specifically so lazy wrappers can defer-load the implementation). `CredentialStore.modify()` is deliberately the _only_ write path — "serialized read-modify-write" per provider id, cross-process too where the backing store supports it (e.g. a file lock) — which is the mechanism that makes concurrent-request token refresh safe without a separate distributed lock.

### `lazyOAuth`: keep Node-only flow code out of non-Node bundles

```ts
export function lazyOAuth(input: { name: string; load: () => Promise<OAuthAuth> }): OAuthAuth {
  let promise: Promise<OAuthAuth> | undefined;
  const loaded = () => {
    promise ??= input.load();
    return promise;
  };
  return {
    name: input.name,
    login: async (callbacks) => (await loaded()).login(callbacks),
    refresh: async (credential) => (await loaded()).refresh(credential),
    toAuth: async (credential) => (await loaded()).toAuth(credential),
  };
}
```

Provider factories (e.g. `openaiCodexProvider()` in `src/providers/openai-codex.ts`) declare `auth: { oauth: lazyOAuth({ name: "OpenAI (ChatGPT Plus/Pro)", load: loadOpenAICodexOAuth }) }` — the OAuth _implementation_ only loads on first `login`/`refresh`/`toAuth` call. The loader (`src/utils/oauth/load.ts`) goes one step further and routes the dynamic `import()` through a **variable specifier** built at runtime (`import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier`) specifically so that static bundlers cannot statically follow the import graph into Node-only code:

```ts
/**
 * Loads an OAuth flow module through a variable specifier so bundlers cannot
 * follow the import into Node-only flow code (`node:http` callback servers,
 * `node:crypto` PKCE). The `.ts`/`.js` rewrite keeps the trick working from
 * both source and built output.
 */
```

`src/utils/oauth/openai-codex.ts` carries the same discipline at the module level — `node:crypto`/`node:http` are imported via `await import(...)` inside an `if (typeof process !== "undefined" && ...)` guard, never as top-level imports, with the comment `// NEVER convert to top-level imports - breaks browser/Vite builds`. This is the concrete mechanism enabling the "Bun-compile/Workers" story described below: the flow-orchestration code (state machine, callback URL parsing, token exchange calls) is plain TypeScript using `fetch`, but the _transport_ pieces it optionally needs (`node:http` for a local OAuth callback server, `node:crypto.randomBytes` for the `state` parameter) are isolated behind guarded dynamic imports that a bundler physically cannot tree-shake incorrectly into a browser/Workers build.

### Confirmed OAuth flows

- **`anthropic` (Claude Pro/Max)** — `src/utils/oauth/anthropic.ts`: PKCE-based browser flow, same "Node.js-only, not browser environments" framing, `node:http` imported the same guarded-dynamic-import way for the local callback server.
- **`openai-codex` (ChatGPT Plus/Pro)** — `src/utils/oauth/openai-codex.ts` (confirmed in full): OAuth client id `app_EMoamEEZ73f0CkXaXp7hrann` against `https://auth.openai.com` (`/oauth/authorize`, `/oauth/token`), redirect `http://localhost:1455/auth/callback`, scope `openid profile email offline_access`, PKCE S256 + a `state` param (`node:crypto.randomBytes(16)`), plus `id_token_add_organizations=true` and `codex_cli_simplified_flow=true` query params and an `originator` field (defaults `"pi"`). Supports both a **browser flow** (local `node:http` server on port 1455, races a "paste the code manually" prompt against the callback — "whichever completes first wins", with `AbortController`-based cancellation of the losing side) and a **device-code flow** (`/api/accounts/deviceauth/usercode` → poll `/api/accounts/deviceauth/token`, 15-minute timeout, explicit handling of `deviceauth_authorization_pending` and `slow_down` error codes). The account id is extracted by decoding the access token as a JWT and reading a custom claim path `https://api.openai.com/auth.chatgpt_account_id` — **not** returned as a separate field by the token endpoint. `refresh` posts `grant_type=refresh_token` to the same `/oauth/token` endpoint. The provider factory (`src/providers/openai-codex.ts`) confirms the base URL used for actual chat requests: `baseUrl: "https://chatgpt.com/backend-api"` — i.e. auth happens against `auth.openai.com` but inference requests go to `chatgpt.com/backend-api`, a different host entirely.
- **`github-copilot`** — `src/utils/oauth/github-copilot.ts` exists (device-code based, per changelog entries about "device-code login polling" and `slow_down` interval handling) but was not read in full for this report.

## Custom `baseUrl` support

`StreamOptions.headers` can override/suppress provider headers (`null` value suppresses a default header), and `AuthResult.auth.baseUrl` lets an `ApiKeyAuth`/`OAuthAuth`'s `resolve()`/`toAuth()` override the provider's base URL per-credential — the changelog cites GitHub Copilot's per-credential `baseUrl` and Cloudflare's request-specific base URL derivation (`options.apiKey`/`options.env` participating in auth resolution) as concrete uses. `Models.applyAuth()` (`src/models.ts`) shows the merge precedence explicitly: `const requestModel = auth.baseUrl ? {...model, baseUrl: auth.baseUrl} : model` — auth-resolved `baseUrl` overrides the model's static one, and explicit per-request `options.apiKey`/`headers`/`env` win over auth-resolved values per-field (`options?.apiKey ?? auth.apiKey`), with `headers`/`env` merged per-key rather than wholesale-replaced.

## `cacheRetention`/`sessionId` prompt-cache controls

`StreamOptions` (`src/types.ts`) exposes two provider-agnostic knobs:

```ts
cacheRetention?: CacheRetention;  // "none" | "short" | "long" — providers map to their own supported values; default "short"
sessionId?: string;               // session-affinity / prompt-cache hint; ignored by providers that don't support it
```

The Anthropic-specific option type documents the concrete mapping: `cacheRetentionOverride` doc-comments describe `"anthropic"`-style `cache_control` markers applied to the system prompt, last tool definition, and last user/assistant text content; a flag for whether to send session-affinity headers (`session_id`, `x-client-request-id`, `x-session-affinity`) derived from `options.sessionId` when caching is enabled (default `false` for that header set, but a _separate_ OpenAI-style knob defaults `true` for its own `session_id` cache-affinity header); and a flag for whether the provider supports long retention (`prompt_cache_retention: "24h"` for OpenAI-style, or `cache_control.ttl: "1h"` for Anthropic-style — default `true`). In short: `cacheRetention`/`sessionId` are the portable knobs, and each provider's option type layers on the provider-specific header/marker mechanics pi-ai already knows how to translate them into.

## Dependency weight, lazy loading, Bun-compile/Workers notes

`package.json` dependencies: `@anthropic-ai/sdk` (0.91.1), `@aws-sdk/client-bedrock-runtime` (3.1048.0), `@google/genai` (1.52.0), `@mistralai/mistralai` (2.2.6), `@opentelemetry/api` (1.9.0), `@smithy/node-http-handler` (4.7.3), `http-proxy-agent`, `https-proxy-agent`, `openai` (6.26.0), `partial-json`, `typebox`. That's real weight if all of it loads eagerly — but the package is structured specifically so it doesn't: every `api/*.ts` module has an `.lazy.ts` sibling wrapping it via `lazyApi()` (`src/api/lazy.ts`), which defers the actual provider-SDK import until the first `stream()`/`streamSimple()` call on that specific API, deduplicated by the host's normal module import cache. A ziggy process that only ever talks to, say, Anthropic-messages and OpenAI-codex-responses never pays for loading `@aws-sdk/client-bedrock-runtime`, `@google/genai`, or `@mistralai/mistralai` at all, provided ziggy imports the specific `api/*` (or `.lazy.ts`) modules it needs rather than a catalog-all `providers/all` entrypoint.

For Workers/edge-style runtimes specifically: PKCE generation (`src/utils/oauth/pkce.ts`) is written against the **Web Crypto API** (`crypto.getRandomValues`, `crypto.subtle.digest`) and explicitly documented as "works in both Node.js 20+ and browsers" — i.e. it's already Workers-compatible with zero changes. What is _not_ Workers-compatible is the **interactive** half of each OAuth flow: the local `node:http` callback server that catches the browser redirect, and `node:crypto.randomBytes` for the `state` parameter (trivially replaceable with Web Crypto). The token _exchange_/_refresh_ calls themselves (`exchangeAuthorizationCode`, `refreshAccessToken` in `openai-codex.ts`) are plain `fetch()` calls with no Node-specific API surface — they're already portable. This confirms the "vendor only the OAuth token-exchange for Workers later" framing: ziggy doesn't need to reimplement or vendor the PKCE math or the token-exchange HTTP calls (already portable), only the interactive authorization-code-acquisition step (browser launch + local callback listener), which a Workers deployment would replace with a different mechanism entirely (e.g. a pre-provisioned refresh token, or an external device-code flow driven from a CLI that then hands ziggy just the resulting credential).

## Coupling and stability

`CHANGELOG.md` shows sustained multi-release-per-week cadence through mid-2026 (six `0.80.x` patch releases between `2026-06-23` and `2026-07-09`), active external contribution (`@davidbrai`, `@gukoff`, `@stephanmck` credited on specific fixes), and a real breaking-change history: `0.80.0` (2026-06-23) restructured the entire package — root entrypoint became core-only/side-effect-free, `Provider` type renamed to `ProviderId`, API implementation modules moved from `src/providers/` to `api/*` and renamed by API id rather than vendor name, the `@earendil-works/pi-ai/base` selective-provider entrypoint was removed outright — with an explicit migration guide in the same changelog entry. This is squarely pre-1.0 API-surface churn: real, not hypothetical, and the reason ziggy should pin an exact version rather than a range.

## What ziggy adds on top

pi-ai gives ziggy: normalized streaming across ~30 providers, cost accounting, and OAuth/API-key credential lifecycle. It does **not** give ziggy: an agent loop (tool-call orchestration, turn/step state machine, context management/compaction, sandboxing) — that's `pi-agent-core`'s job in the pi monorepo, and ziggy is deliberately not depending on it (see below). It also doesn't give ziggy persistence, a wire protocol for attach clients, or any of the Session/Harness-level concerns flue and eve's research already cover. pi-ai's job in ziggy's architecture is narrowly: "given a `Model` and a `Context`, produce an `AssistantMessageEventStream`, handling auth and billing along the way" — everything above that line is ziggy's own.

## Verdict

- **Depend directly** on `@earendil-works/pi-ai`, not vendored/forked — the provider-normalization and OAuth-flow-maintenance burden (rate limits, model catalog drift, provider quirks like Anthropic's 1h-cache-write 2x billing or GitHub Copilot's per-credential `baseUrl`) is exactly the kind of un-fun, high-churn code that's worth paying an external-maintenance cost for, and the maintainers are demonstrably active.
- **Pin exact** (`0.80.6`, no `^`/`~` range) given the confirmed pre-1.0 breaking-change history; bump deliberately, read the changelog's "Breaking Changes" section every time.
- **Import only the `api/*` modules ziggy actually uses** (via the `.lazy.ts` wrappers or direct dynamic import), not `providers/all` or the `./compat` global-API entrypoint — this keeps unused provider SDKs (Bedrock, Google, Mistral, etc.) out of ziggy's dependency graph at runtime, consistent with the package's own side-effect-free-root design intent.
- **Vendor only the OAuth token-exchange path for Workers later**, and only the non-portable half of it (interactive browser-callback acquisition) — the PKCE math and the actual token HTTP calls are already Web-Crypto/`fetch`-based and portable as-is; there's nothing to vendor there.

## Boundary decision: pi-ai per model call, ziggy owns the loop

pi-ai is scoped to a single model call: `Model` + `Context` in, `AssistantMessageEventStream` out. `pi-agent-core` (`@earendil-works/pi-agent-core`, `packages/agent` in the same monorepo, described in its own `package.json` as "General-purpose agent with transport abstraction, state management, and attachment support" — files `agent-loop.ts`, `agent.ts`, `harness/`, `proxy.ts`, `types.ts`, `node.ts`) is the layer above that: the actual multi-turn agent loop, tool dispatch, state management, and a transport/attachment abstraction of its own. Ziggy is **not** taking `pi-agent-core` as a dependency, deliberately: ziggy's own Session/Operation/Step model, harness composition, sandboxing, and attach protocol (see `docs/research/flue.md`, `docs/research/eve.md`, `docs/research/codex-app-server.md`) are first-class architectural decisions ziggy needs to own outright, not inherit from an external package whose loop design, state shape, and attachment semantics were built for `pi`'s own CLI/TUI/orchestrator stack and would constrain or duplicate ziggy's equivalent concepts. Taking pi-ai without pi-agent-core is a clean cut: pi-ai's contract ends exactly at "stream one model response," which is a genuinely reusable, provider-churn-absorbing unit; everything above that — the loop that decides _when_ to call the model again, with _what_ context, and _what to do_ with tool calls — is ziggy's to design so it composes correctly with ziggy's own persistence and attach-protocol decisions instead of pi's.
