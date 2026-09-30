# Effect composition: main.ts and its blast radius

This plan turns `src/main.ts` into a thin Effect entrypoint. The composition is currently a hand-wired
pile, and the plan closes the guardrail gaps that let it get that way. It comes from the 2026-09-29
kvim review of `main.ts`, with facts checked against `vendor/effect` (4.0.0-beta.99).

Each slice lands as its own commit with `bun run check`, `bun run test` and a `LOG.md` entry.

## Why main.ts is the way it is

There are five root causes. Each one shows up as several of the review comments.

1. **Services don't own their wiring.** Most `XLive` layers leave their requirements open, so
   every dependency edge is spelled out in `main.ts`:
   - there are about 15 `XProvided` constants;
   - `ZiggyAgentLive.pipe(Layer.provide(PiAgentLive))` is written out six times;
   - `ProfilesLive` and `DoctorLive` are each wired twice.

   Effect's own code does the opposite. A service exports a `layer` with its dependencies already
   provided (`BunHttpPlatform.ts:47`, `MessageStorage.ts:1033`), and the entrypoint merges
   top-level layers. The duplicates don't build twice, because layers are memoized by reference
   (`Layer.ts:412-448`), but they hide the real graph.
2. **One layer for every command.** `program` is given a single merged layer holding all 17
   services, including the resident, three chat gateways and self-update. `Effect.provide` builds
   the whole layer before the program runs (`internal/layer.ts:8-22`). So `ziggy doctor` builds
   Slack.
3. **Host state is read at module scope, outside Effect.** At import time, `main.ts`:
   - reads `process.cwd()`, `homedir()` and `ZIGGY_HOME`;
   - computes `repositoryRoot`;
   - calls `bootstrapPiStandaloneRuntime()`.

   `terminalRenderOptions` reads the TTY, `TERM`, `NO_COLOR` and the column count, and that
   result is passed by hand into about 20 renderers. Nothing in Pi needs the bootstrap at import
   time. Pi reads the OAuth, Bedrock and Photon registrations on first use.
4. **Exit codes and errors bypass the error channel.** The `fail` helper prints and then
   *succeeds*. There are ten hand-set `process.exitCode = 1` lines. A 61-tag `catchTags` renders
   about 55 of those tags as `.message`.

   `runMain` already maps failures to exit codes through `Runtime.errorExitCode`, and
   `Runtime.errorReported` suppresses the duplicate log (`Runtime.ts:117-124, 292, 385`).
5. **All command logic lives in the entrypoint.** A 60-case `switch` makes up 800 lines of
   `Effect.gen`, with nested ternaries on `_tag`. The `faces/*-cli.ts` files are render-only, so
   the handlers had nowhere else to go.

Dead weight found along the way:

- `repositoryRoot` is threaded through about ten APIs and ignored by every one of them. Its only
  real use is `path.relative` for display in `extensions show`.
- `resident-service-operations.ts:141` resolves `ZIGGY_HOME` differently from
  `domain/profile.ts`.

## Target shape

```text
src/main.ts            decode argv -> dispatch -> BunRuntime.runMain   (~40 lines, no module-scope work)
src/composition.ts     the composition root: one named layer per capability, each fully provided
src/faces/commands/    one handler module per command area; handlers yield services, return Effect
```

- `main.ts` is the only place that runs Effects. It uses `Match.valueTags(command, {...})`, which
  is exhaustive at compile time, and wraps each area's handler in `Effect.provide(AreaLayer)`.
  That way a command builds only what it uses.
- Composition happens in one place. Adapters and application services export `layer` values;
  `composition.ts` names the capability layers (Agent, Resident, Extensions, Doctor, and so on)
  exactly once.
- Host state comes in as services:
  - `ZiggyPaths` covers cwd, home and `ZIGGY_HOME`, read through `Config`. It replaces
    `resolutionOptions` and the four raw arguments of `makeResidentGatewayLive`.
  - `TerminalOutput` covers pretty/colors/columns plus print, and replaces
    `terminalRenderOptions`.
  - The Pi standalone registration becomes `Layer.effectDiscard`, which the Pi-facing layers
    provide.
- Failures stay failures. Handlers fail with typed errors, and a single `renderCliFailure` in faces
  prints them. A `CliExit` error carries `Runtime.errorExitCode` for commands that already printed
  their own output (doctor, validate, serve status).
- `effect/unstable/cli` (`Command` with subcommands and `Command.provide`) is the fully idiomatic
  end state. It stays optional and last, because it replaces our hand parser and is still
  `unstable` in beta.99.

## Slices

1. **Composition root.** Status: done.
   - `src/composition.ts` names each layer once and exports `makeCliLayer`.
   - The Pi bootstrap is `PiStandaloneRuntimeLive`, provided under the whole CLI layer.
   - `help` and `--version` no longer build any services.
   - Application layers keep their ports open on purpose. Application may not import adapters,
     so the root closes them; this differs from Effect's library packages, where the
     implementation is the service.
   - `resolutionOptions` and `terminalRenderOptions` stay in `main.ts` until slices 3 and 4.
   - Move all layer wiring to `src/composition.ts`, one definition per service, and delete the
     duplicates.
   - Rename `AgentLive` to `ZiggyAgentLayer`. It's the application agent over the `PiAgent`
     adapter, which is the split the spec asks for.
   - Turn the Pi bootstrap into a layer.
   - Remove module-scope work from `main.ts`.
   - Covers review comments 2, 3 and 4.
2. **Delete `repositoryRoot`.** Status: done. Dropped from `PiAgent`, `ProfileExtensions`,
   `Doctor`, `Setup`, the resident and the UI config; every sink ignored it. `extensions show`
   prints paths relative to cwd.
3. **`ZiggyPaths` service.** Status: done.
   - `ZiggyPaths` (application) holds home, `ZIGGY_HOME`, the Profiles directory and registry, and
     `resolveTarget`. `ZiggyPathsLive` (Bun adapter) reads `ZIGGY_HOME` through `Config` and
     cwd/home through `Effect.sync` when the layer builds.
   - `makeResidentGatewayLive(...)` is now a plain `ResidentGatewayLive`. Extension health is an
     `ExtensionHealth` service that the root fills with the Pi adapter's function.
   - Resident operations take `ziggyHome` from `ZiggyPaths`, so a relative `ZIGGY_HOME` resolves
     the same way everywhere. Their host runtime is built in the layer, not at module scope.
   - `makeCliLayer(options)` is now the constant `CliLayer`.
   - Covers part of review comment 5. The resident's wide dependency merge shrinks with the
     per-area layers in slice 5.
4. **CLI output and exit.** Status: done.
   - `TerminalStyle` (`faces/terminal-ui.ts`, next to `TerminalRenderOptions`) reads the TTY,
     `TERM`, `NO_COLOR` and columns once, in its layer. Printing stays on `console` until slice 5.
   - A command's result is its exit code. `exitWith` turns a non-zero code into `CliExit`, which
     sets `Runtime.errorExitCode` and `Runtime.errorReported = false`.
   - `CliCommandFailed` replaces `fail(message)`. The 61-tag `catchTags` is down to the 7 tags that
     render more than `.message`, then one `Effect.catch`.
   - `disableErrorReporting` is gone, so defects are reported instead of exiting 1 silently.
   - Covers review comment 1.
5. **Per-area handlers.** Status: in progress (models done).
   - Area modules live in `src/faces/commands/<area>.ts`. Each exports its command type and a
     `run<Area>Command` that `Match.valueTags` over its tags, yields only its services, and prints
     through `Console`. `composition.ts` exports a matching `<Area>CommandsLayer`.
   - `main.ts` `dispatch` is one exhaustive `Match.valueTags` over every `CliCommand`, including
     help and version. Tags not moved yet map to `legacy`, which runs `runCommand` under `CliLayer`.
   - One area per commit: models, sessions, memory, auth, agents, automations, extensions,
     profiles/init, serve/web/open, run/acp, doctor, update.
   - `main.ts` dispatches with `Match.valueTags` and provides each area's layer.
   - Foreground-resident teardown becomes a property of the decoded command.
   - Covers review comment 6.
6. **Guardrails.** Status: pending. See below. Some of it lands first as slice 0.

## Guardrails

### Effect language service (slice 0)

The `@effect/tsgo` patch was not applied, so `bun run check` has been running plain `tsc`. With
the patch applied there are 2 errors, 53 warnings and 105 suggestions.

- Add `"postinstall": "effect-tsgo patch"` so the diagnostics always run.
- Fix the 2 errors (`missingReturnYieldStar` in tests).
- Ratchet `ignoreEffectWarningsInTscExitCode` to `false` once the warnings are fixed or
  suppressed at real boundaries. Most of them are `unknownInEffectCatch` (51).
- Raise these to error:
  - `globalConsoleInEffect`, `processEnvInEffect`, `runEffectInsideEffect`;
  - `strictEffectProvide`, `multipleEffectProvide`, `layerMergeAllWithDependencies`;
  - `globalDateInEffect`, `newPromise`.

### oxlint rules (`tooling/oxlint/ziggy`)

- **`no-console-outside-faces`:** 76 `console.*` calls outside `main.ts`, 49 of them in
  application code.
- **`no-process-global`:** `process.*` only in `main.ts` and the Bun/terminal adapters.
- **`no-module-scope-effects`:** no top-level calls outside an allowlist (`Schema`, `Layer`,
  `Context`, `Effect` and similar). This catches `main.ts:127` and the adapter singletons
  (`automation-sqlite.ts:785`, `ui-state.ts:377`).
- **`composition-root-only`:** `Layer.provide` and `Layer.merge*` only in `src/composition.ts`,
  apart from platform clients inside adapters.
- **`layer-dependency-direction`:** no value imports from `adapters/` or `faces/` into
  `application/` or `domain/`. There are 64 such imports today, so ratchet it with an allowlist
  that can only shrink.
- **`no-tag-branching`:** flag `._tag ===` comparisons (132 of them) and `switch (x._tag)`
  without a `never` guard. Point at `Match.valueTags`, `Match.tagsExhaustive` and
  `Effect.catchTags`.
- **`max-file-lines`:** 500 lines, with a shrinking allowlist. 30 files are over.
- **Test override:** turn off `no-effect-execution-boundary` for `test/**`, which removes 65
  file-level disables.

### Skills (`.agents/skills`)

New:

- `effect-services-and-layers`:
  - `Context.Service` with a `make` and a static `layer`, fully provided;
  - no raw-argument `makeXLive`;
  - no module singletons;
  - one composition root;
  - share layers by reference.
- `effect-cli-edge`:
  - `Console` and `Effect.log*` instead of `console`;
  - `Config` instead of `process.env`;
  - exit codes through `Runtime.errorExitCode`;
  - per-command layers;
  - host state as services.
- `effect-matching`: `Match.valueTags`, `Match.tagsExhaustive`, `Effect.catchTags` and `absurd`;
  no ternaries on `_tag`.
- `effect-callback-bridge`: running Effects from Pi, ACP and SDK callbacks with captured
  services (`Effect.context` plus `Effect.runPromiseWith`). There are 16 bare `Effect.runPromise`
  calls in `src/adapters/pi` today.

Sharpen:

- `effect-runtime-boundaries`: define "adapter" the way the lint rule does, and ban
  module-scope work.
- `typescript-type-safety`: make its `switch` example exhaustive.
- Every skill: name the lint or tsgo rule that backs it.
