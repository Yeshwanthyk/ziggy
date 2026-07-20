# Effect v4 state as of 2026-07-19

This report distinguishes npm's stable `latest` channel from its v4 `beta` channel. Version and repository claims were checked live on 2026-07-19. The primary sources are npm metadata and the Effect repository at the exact `effect@4.0.0-beta.99` tag.

## 1. Release status and package layout

The newest Effect 4 release is **`effect@4.0.0-beta.99`**, published 2026-07-17. It is a **beta**, not a stable release. npm's `beta` dist-tag points to `4.0.0-beta.99`; npm's default `latest` dist-tag still points to stable v3, **`effect@3.22.0`**. Install v4 explicitly with `npm install effect@beta` / `bun add effect@beta`, or pin `effect@4.0.0-beta.99`.

Sources: [npm `effect` package](https://www.npmjs.com/package/effect), [npm registry metadata, including dist-tags](https://registry.npmjs.org/effect), [release tag `effect@4.0.0-beta.99`](https://github.com/Effect-TS/effect/tree/effect%404.0.0-beta.99).

v4's package story is **a unified core, not literally one npm package**:

- The main package is still unscoped **`effect`**. Cross-platform services such as `FileSystem` moved into it, and formerly separate feature packages largely moved to `effect/unstable/*` entry points: HTTP is `effect/unstable/http`, sockets are `effect/unstable/socket`, and processes are `effect/unstable/process`.
- Runtime implementations remain separate scoped packages: **`@effect/platform-bun`**, **`@effect/platform-node`**, **`@effect/platform-node-shared`**, and **`@effect/platform-browser`**. On the v4 beta channel these are version-aligned with core; currently they are all `4.0.0-beta.99`.
- The old **`@effect/platform` is a v3 package only** at present: its npm `latest` is `0.97.0` and it has no `beta` dist-tag. Do not add it to a v4 project.
- Likewise, **`@effect/schema` is not a v4 package**. Its npm `latest` is the legacy `0.75.5`, with no beta channel. Schema is supplied by `effect` itself.

Sources: [v4 core package manifest](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/effect/package.json), [Bun adapter manifest](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/platform-bun/package.json), [Node adapter manifest](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/platform-node/package.json), [npm `@effect/platform`](https://www.npmjs.com/package/@effect/platform), [npm `@effect/schema`](https://www.npmjs.com/package/@effect/schema).

## 2. What replaced `@effect/platform`

The portable contracts moved into `effect`; runtime-specific layers remain in `@effect/platform-bun` or `@effect/platform-node`.

### Bun runtime and daemon entry point

Install `effect@beta` and `@effect/platform-bun@beta`. Run the top-level program with **`BunRuntime.runMain`** imported from **`@effect/platform-bun/BunRuntime`** (or the package barrel). `BunServices.layer` bundles the normal Bun implementations of filesystem, paths, child-process spawning, crypto, terminal, and stdio.

Sources: [`BunRuntime.ts`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/platform-bun/src/BunRuntime.ts), [`BunServices.ts`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/platform-bun/src/BunServices.ts).

### HTTP and WebSocket server

Portable server/router APIs are in **`effect/unstable/http`**, notably `HttpServer`, `HttpRouter`, and related modules. The Bun implementation is **`BunHttpServer`** from **`@effect/platform-bun/BunHttpServer`**; use `BunHttpServer.layer(...)` / `layerConfig(...)`. It is backed by `Bun.serve` and includes server-side WebSocket upgrade support.

Portable socket contracts are **`Socket`** and **`SocketServer`** from **`effect/unstable/socket`**. Bun client WebSocket layers are in **`@effect/platform-bun/BunSocket`** (`layerWebSocketConstructor`, `layerWebSocket`); the Bun socket-server implementation is **`@effect/platform-bun/BunSocketServer`**. For an HTTP server that upgrades connections, `BunHttpServer` is the relevant adapter.

Sources: [HTTP barrel](https://github.com/Effect-TS/effect/tree/effect%404.0.0-beta.99/packages/effect/src/unstable/http), [socket barrel](https://github.com/Effect-TS/effect/tree/effect%404.0.0-beta.99/packages/effect/src/unstable/socket), [`BunHttpServer.ts`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/platform-bun/src/BunHttpServer.ts), [`BunSocket.ts`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/platform-bun/src/BunSocket.ts), [`BunSocketServer.ts`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/platform-bun/src/BunSocketServer.ts).

### Filesystem

The service API is **`FileSystem` from `effect/FileSystem`** (also exported from the top-level `effect` barrel). On Bun, provide **`BunFileSystem.layer`** from **`@effect/platform-bun/BunFileSystem`**, or use `BunServices.layer`. The Bun implementation currently reuses the shared Node filesystem implementation.

Sources: [`FileSystem.ts`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/effect/src/FileSystem.ts), [`BunFileSystem.ts`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/platform-bun/src/BunFileSystem.ts).

### Child processes

The portable API is **`ChildProcess` and `ChildProcessSpawner` from `effect/unstable/process`**. On Bun, provide **`BunChildProcessSpawner.layer`** from **`@effect/platform-bun/BunChildProcessSpawner`**, or `BunServices.layer`. The Bun adapter currently re-exports the shared Node-compatible implementation.

Sources: [process modules](https://github.com/Effect-TS/effect/tree/effect%404.0.0-beta.99/packages/effect/src/unstable/process), [`BunChildProcessSpawner.ts`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/platform-bun/src/BunChildProcessSpawner.ts), [official child-process example](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/ai-docs/src/60_child-process/10_working-with-child-processes.ts).

Node uses the same portable modules with `NodeRuntime`, `NodeServices`, `NodeHttpServer`, etc. from `@effect/platform-node`.

## 3. v4 versus v3 APIs relevant to a daemon

### Services and layers

All v3 service-definition forms—`Context.Tag`, `Context.GenericTag`, `Effect.Tag`, and **`Effect.Service`**—are replaced by **`Context.Service`**. A v4 effectful service constructor can be stored in the `make` option, but v4 no longer auto-generates v3's `.Default` layer; define a layer explicitly, normally `static readonly layer = Layer.effect(this, this.make)`, and provide dependencies to that layer yourself.

Layer composition remains central. A meaningful runtime change is that layer memoization is shared across `Effect.provide` calls by default; use `Layer.fresh` or `Effect.provide(layer, { local: true })` when distinct instances are required. Long-running daemons should still assemble one application layer and launch/run it at a single runtime boundary.

Sources: [services migration](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/migration/services.md), [layer memoization migration](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/migration/layer-memoization.md), [official service examples](https://github.com/Effect-TS/effect/tree/effect%404.0.0-beta.99/ai-docs/src/01_effect/03_services).

### Fibers and concurrency

The runtime was substantially rewritten, but structured concurrency remains the model. The important source-level changes are **`Effect.fork` → `Effect.forkChild`** and **`Effect.forkDaemon` → `Effect.forkDetach`**. `forkScoped` and `forkIn` remain. Fork operations now accept options including `startImmediately` and `uninterruptible`. `forkAll` and `forkWithErrorHandler` were removed; use individual forks or higher-level concurrency combinators and put error handling inside the forked effect. For daemon correctness, prefer scoped/child fibers; reserve `forkDetach` for work deliberately independent of parent shutdown.

Sources: [forking migration](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/migration/forking.md), [fiber keep-alive migration](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/migration/fiber-keep-alive.md).

### Stream

`Stream` remains a first-class top-level module (`import { Stream } from "effect"`) and retains scoped, concurrent streaming. There are breaking API/representation changes: for example, `Stream.asyncEffect` became `Stream.callback`, and `Stream.runCollect` now returns `Effect<A[]>` rather than `Effect<Chunk<A>>`. This is not a mechanical version bump for a stream-heavy daemon; compile and behavior-test every stream boundary, shutdown path, callback adapter, and collection assumption.

Sources: [v3-to-v4 migration map](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/migration/v3-to-v4.md), [official v4 Stream examples](https://github.com/Effect-TS/effect/tree/effect%404.0.0-beta.99/ai-docs/src/03_stream), [`Stream.ts`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/effect/src/Stream.ts).

### Schedule and cron

`Schedule` remains in `effect`. v4 directly supports cron-like repetition with **`Schedule.cron(expression, timeZone?)`**, where the expression is a five-field cron expression or a parsed `Cron`; parsing failures are typed as `CronParseError`. Examples include `Schedule.cron("30 2 * * *")` and `Schedule.cron("0 9 * * 1", "America/New_York")`. Retry/repeat composition remains (`Effect.retry`, `Effect.repeat`), but several names changed, including `Schedule.intersect` → `Schedule.both`; `Schedule.stop` and `Schedule.once` are represented by `Schedule.recurs(0)` and `Schedule.recurs(1)`.

Sources: [`Schedule.cron` implementation and examples](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/effect/src/Schedule.ts#L839), [official Schedule guide source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/ai-docs/src/06_schedule/10_schedules.ts), [migration map](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/migration/v3-to-v4.md).

### Schema

Schema is **`Schema` from `effect` / `effect/Schema`**. There is no v4 `@effect/schema`; that older standalone package is not part of the v4 beta line. Schema is integrated into core and substantially redesigned, not merely relocated. Representative changes include `Schema.TaggedError` → `Schema.TaggedErrorClass`, `Literal(a, b)` → `Literals([a, b])`, `filter` → `check` (with predicate names generally gaining an `is` prefix), and removal of `validate*` in favor of `decode*` plus `Schema.toType`. Transforms, optional fields, classes, and parse-error formatting have larger migration changes.

Sources: [Schema migration guide](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/migration/schema.md), [`Schema.ts`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/effect/src/Schema.ts), [npm `@effect/schema`](https://www.npmjs.com/package/@effect/schema).

## 4. Bun compatibility and `bun build --compile`

Normal Bun execution is explicitly supported through `@effect/platform-bun`, including Bun-native HTTP/WebSocket handling. The v4 tree tests and publishes a Bun adapter, so `bun run` is a first-class target rather than accidental Node compatibility.

There is, however, a concrete compiled-binary caveat. Effect issue **#2126** reported that `Stream.mkUint8Array` crashed in binaries built with **both `bun build --compile` and `--minify`**, while it did not reproduce under `bun run`, Node, or `bun build --compile` without minification. A maintainer attributed it to Bun's minifier freezing a generic accumulator and advised not using Bun to minify code, suggesting a mature minifier such as terser. The issue was closed as upstream/not Effect-side. The initially proposed Effect workaround was not treated as a complete solution because the same mutable pattern can occur elsewhere.

Practical recommendation: **Bun runtime: yes; `bun build --compile`: test your exact binary; `bun build --compile --minify`: avoid for now**. Pin Bun and Effect versions, exercise multi-chunk streams, child processes, signal shutdown, HTTP/WS upgrades, and packaged-file access in the compiled artifact. No current Effect issue found establishes that plain `--compile` is generally broken.

Sources: [effect-smol issue #2126 and maintainer discussion](https://github.com/Effect-TS/effect-smol/issues/2126), [`@effect/platform-bun`](https://www.npmjs.com/package/@effect/platform-bun).

## 5. Repository branch/tag and offline documentation paths

Effect v4 has moved into **`Effect-TS/effect`'s `main` branch**. v3 maintenance is on **`v3`** (with `changeset-release/v3` for releases). There is no active `v4` branch. The exact reproducible v4 release tag is **`effect@4.0.0-beta.99`**, commit **`6184a7dc53cb9310e299b65ad6d6c712c2cbf202`**. The older `Effect-TS/effect-smol` repository was the v4 development home; its work/history has been merged into the main Effect repo, and current references should use `Effect-TS/effect`.

Sources: [`main`](https://github.com/Effect-TS/effect/tree/main), [`v3`](https://github.com/Effect-TS/effect/tree/v3), [`effect@4.0.0-beta.99`](https://github.com/Effect-TS/effect/tree/effect%404.0.0-beta.99), [Effect organization repositories](https://github.com/orgs/Effect-TS/repositories).

Inside the current repo, the useful offline agent-reference paths are:

- **`ai-docs/src/`** — v4 narrative guides (`index.md`) plus checked TypeScript examples. Exact topic paths include `ai-docs/src/01_effect/`, `03_stream/`, `06_schedule/`, `51_http-server/`, and `60_child-process/`.
- **`migration/`** — detailed v3→v4 migration notes, including `migration/v3-to-v4.md`, `services.md`, `forking.md`, `schema.md`, and layer/runtime notes.
- **`packages/effect/src/`** — authoritative source/JSDoc for core modules; unstable feature sources are under `packages/effect/src/unstable/`.
- **`packages/platform-bun/src/`** and **`packages/platform-node/src/`** — runtime adapter source and JSDoc.
- **`cookbooks/`** and **`.patterns/`** — additional examples/pattern guidance.

There is **no root `docs/` directory at this v4 tag/current main**; older search indexes may show one from the pre-merge v3 tree. The public website's prose is maintained separately in **[`Effect-TS/website`](https://github.com/Effect-TS/website)**, so submoduling only `Effect-TS/effect` gives the v4 `ai-docs`, migration documents, API JSDoc, and examples, but not the entire website content corpus.

For a reproducible offline reference, add the repo as a submodule and pin the release tag/commit rather than tracking moving `main`:

```sh
git submodule add https://github.com/Effect-TS/effect.git vendor/effect
git -C vendor/effect checkout effect@4.0.0-beta.99
```

Sources: [`ai-docs/src`](https://github.com/Effect-TS/effect/tree/effect%404.0.0-beta.99/ai-docs/src), [`migration`](https://github.com/Effect-TS/effect/tree/effect%404.0.0-beta.99/migration), [`packages/effect/src`](https://github.com/Effect-TS/effect/tree/effect%404.0.0-beta.99/packages/effect/src), [website repository](https://github.com/Effect-TS/website).

## 6. Production maturity judgment

**Conservative answer: not yet the default choice for a risk-averse production project.** The maintainers still publish it under the semver prerelease `4.0.0-beta.*` and npm's default `latest` remains v3. That is the strongest unambiguous release-contract signal. The `effect/unstable/*` paths used for HTTP, sockets, processes, and other ecosystem features explicitly reserve additional API freedom even after core stabilizes.

**Pragmatic answer: viable for a new, well-tested project whose team accepts churn.** By beta.99 it has had five months and roughly one hundred beta iterations, dedicated Bun/Node adapters, extensive tests, migration material, and real adopters. Starting new on v4 can be cheaper than building on v3 and later performing the large migration. But pin exact versions, expect source-breaking changes between betas, isolate execution/runtime adapters, and budget for migrations until `4.0.0` stable. Avoid it when dependency compatibility, a frozen API, complete narrative documentation, or low operational risk is more important than avoiding a future v3→v4 migration.

This split matches visible community evidence: InfoQ describes the release as beta with a rewritten runtime and unified package ecosystem; experienced Effect adopter Tom MacWright called v4 promising but explicitly deferred production migration because it is beta and because deprecated APIs still matter. An open migration-doc issue from a large-codebase adopter lists many removed/renamed APIs and missing migration guidance. These are not claims that the runtime is unusable; they are evidence that API/documentation stability is still below a normal stable release.

Sources: [npm release channels](https://registry.npmjs.org/effect), [InfoQ's v4 beta summary](https://www.infoq.com/news/2026/04/effect-v4-beta/), [Tom MacWright's Effect v4 migration note](https://macwright.com/2026/03/18/effect-devlog), [open migration-documentation issue #6379](https://github.com/Effect-TS/effect/issues/6379), [v4 unstable exports](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.99/packages/effect/package.json).

## Bottom line

For a new Bun daemon in July 2026, the coherent v4 stack is `effect@4.0.0-beta.99` plus `@effect/platform-bun@4.0.0-beta.99`, using `effect/FileSystem`, `effect/unstable/http`, `effect/unstable/socket`, and `effect/unstable/process`. It is technically credible and likely preferable if the project consciously opts into beta churn, but it is not stable by npm/semver or maintainer release-channel signals. Pin it, keep one runtime boundary, test shutdown and compiled artifacts, and do not use Bun minification for the production executable.
