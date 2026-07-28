# CLI polish

Status: planned only. Provider auth is already shipped separately; the four slices below remain
independent future work.

Four independent CLI gaps from the Starman coverage audit. Each section is a
standalone implementation block and can be selected, tested, and committed without
landing the other three. Preserve existing Profile files and keep every command
read-only except `init`.

The audit marks voice selection, doctor, session listing, and exit-code discipline as
small gaps at `docs/research/starman-coverage-audit.md:14-18`,
`docs/research/starman-coverage-audit.md:25-30`, and
`docs/research/starman-coverage-audit.md:35-43`.

## 1. `ziggy sessions <name|path>`

### Current state

`src/main.ts:27-38` has no sessions command. Root local sessions are written to
`<profile>/sessions` by `src/adapters/pi/pi-agent.ts:404-415` and
`src/adapters/pi/pi-agent.ts:647-658`. Resident chats use one leaf directory per chat
under `sessions/telegram`, `sessions/discord`, and `sessions/slack`
(`src/application/gateway.ts:202-204`,
`src/application/discord-gateway.ts:214-216`,
`src/application/slack-gateway.ts:217-219`). Automation runs use
`sessions/automations/<automation-id>` (`src/application/automations.ts:165-169`).

Fact-check result for the installed `@earendil-works/pi-coding-agent@0.82.0`:

- Pi does expose directory listing and metadata. `SessionManager.list(cwd,
  sessionDir)` returns `Promise<SessionInfo[]>`
  (`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:343-354`);
  `SessionInfo` includes path, created/modified dates, and message metadata
  (`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:125-139`).
- Listing is one directory only, not recursive: the installed implementation reads
  only the immediate `*.jsonl` children
  (`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:548-571`).
  Ziggy must enumerate its known leaf directories and call Pi once per directory.
- Pi's metadata has `messageCount`, not total entry count. Opening a listed file and
  calling `getEntries()` returns all non-header entries
  (`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:273-281`).
- The installed JSONL header shape is:

  ```ts
  {
    type: "session"
    version?: number
    id: string
    timestamp: string
    cwd: string
    parentSession?: string
  }
  ```

  This is the actual declaration at
  `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:4-12`;
  the installed writer emits those fields at
  `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1253-1266`.
  Therefore the raw-first-line fallback is not needed for 0.82.0. Re-check this fact
  before coding if the package version changes. The older SDK report establishes
  custom session directories but does not document listing
  (`docs/research/pi-sdk-surface.md:102-122`), so the installed declaration is the
  authority for this command.

### Steps

1. Add `src/adapters/pi/sessions.ts`. It is the only new file allowed to import Pi.
   Expose a Promise-based function that calls `SessionManager.list(profilePath,
   sessionDirectory)`, then opens each returned path with `SessionManager.open(...)`
   and records `getEntries().length`. Return plain Ziggy-owned values:
   `{ path, created, entryCount }`. Do not expose `SessionInfo` or
   `SessionManager` above the adapter.
2. Add `src/application/sessions.ts` with a `Sessions` Effect service and live Layer.
   Require a regular `SOUL.md`, then inspect:
   `sessions/` itself plus each immediate real directory under
   `sessions/{telegram,discord,slack,automations}/`. Missing session/category
   directories mean an empty list. Do not follow symlinks and do not recursively
   scan arbitrary descendants. Map filesystem/Pi failures into typed Ziggy errors.
3. Merge and sort every row by profile-relative path. Render exactly:
   `<relative-path>\t<created-ISO-8601>\t<entry-count>`. The path is relative to the
   Profile root, for example
   `sessions/telegram/user-123/2026-...jsonl`. Print `no sessions` only when the
   merged list is empty. Never print prompt or message content.
4. Wire `ziggy sessions <name|path>` into the usage text, command switch, and Layer
   composition in `src/main.ts`. Missing or extra arguments are usage errors and
   exit 2 once section 4 lands; until then use the current shared failure path.
5. Add focused tests for root, all four leaf families, stable relative-path order,
   total entry count including non-message entries, empty/missing directories,
   malformed/unreadable files, and an uninitialized Profile. Pin a sample first
   line matching the installed header shape so a Pi upgrade cannot silently change
   the contract.

### Definition of done

One command lists every valid root, Telegram, Discord, Slack, and automation JSONL
session exactly once. Each line has a Profile-relative path, the header creation
timestamp, and the count of non-header entries. It reveals no transcript content,
does not mutate the Profile, handles absent session trees, and keeps Pi types below
`src/adapters/pi/`.

### Proof command

```sh
bun test src/adapters/pi/sessions.test.ts src/application/sessions.test.ts && bun run check
```

## 2. `ziggy doctor <name|path>`

### Current state

There is no doctor route in `src/main.ts:27-38` or `src/main.ts:63-218`.
`listAuthStatus` is already a read-only provider inventory: it requires `SOUL.md`,
constructs the Profile-local model runtime, and checks every provider
(`src/adapters/pi/auth.ts:44-79`, `src/adapters/pi/auth.ts:81-121`). The application
wrapper is `Auth.status` at `src/application/auth.ts:26-35` and
`src/application/auth.ts:66-72`.

The existing gateway loaders already identify the config paths and use the typed
decoders:

- Telegram: `src/application/gateway.ts:48-90`
- Discord: `src/application/discord-gateway.ts:47-88`
- Slack: `src/application/slack-gateway.ts:50-91`

Memory limits are 2,200 code points for `MEMORY.md` and 1,375 for person/group docs
(`src/domain/memory.ts:4-6`, `src/domain/memory.ts:74-75`,
`src/domain/memory.ts:242-281`). Automation syntax is owned by
`parseAutomationFile` (`src/domain/automation.ts:76-141`); the current wake path
validates the filename-derived ID, reads the file, and invokes that parser at
`src/application/automations.ts:42-62`. Pi only admits existing Profile-local
`skills/` and `extensions/` directories
(`src/adapters/pi/pi-agent.ts:473-478`).

### Steps

1. Add `src/application/doctor.ts` with a `Doctor` Effect service and live Layer.
   The service returns structured check rows; `src/main.ts` owns plain-text
   rendering. Every probe must be read-only, bounded to the selected Profile, and
   must redact config values and credentials.
2. Check `SOUL.md` first. Emit `soul: ok` for a regular file. If it is missing or
   not a regular file, emit `soul: missing` or `soul: invalid`, skip dependent
   checks, and return exit 1 as the only nonzero doctor outcome.
3. For an initialized Profile, emit these stable checks:
   `auth`, `telegram`, `discord`, `slack`, memory, automations, `skills`, and
   `extensions`. Use `Auth.status`/`listAuthStatus` and print only configured
   provider IDs; `auth: ok (none configured)` is healthy. For each gateway, first
   distinguish a missing file, then decode existing text with the same exported
   domain decoder used by its `load*GatewayConfig`; report `ok`, `missing`,
   `invalid`, or `error` without printing tokens.
4. Check every existing regular `MEMORY.md`, `memory/users/*.md`, and
   `memory/groups/*.md` file using `codePointLength`. Emit one line per document as
   `memory <relative-path>: ok <used>/<cap>` or
   `memory <relative-path>: over-cap <used>/<cap>`; emit
   `memory: ok (no documents)` when none exist. Ignore unrelated nested paths and
   do not create missing memory files. Inspect sorted `automations/*.md` files,
   validate each filename stem with
   `validateAutomationId`, read it, and call `parseAutomationFile` once. Emit one
   `automations <relative-path>: ok|invalid|error` line per file, or
   `automations: missing` / `automations: ok (0 files)`. Separately emit whether
   `skills/` and `extensions/` are real directories. A bad optional check is
   reported in text but does not change exit 0.
5. Wire `ziggy doctor <name|path>` into `src/main.ts` and merge `DoctorLive` into
   the Layer. Keep output deterministic: the fixed checks above remain in that
   order and per-file rows sort by relative path. Add tests for a healthy minimal
   Profile, no configured auth, configured
   provider IDs with no secret output, missing/valid/invalid gateway configs,
   Unicode code-point cap boundaries, valid/invalid automations, missing/wrong-kind
   resource directories, read failures, and the uninitialized-only exit rule.
   Snapshot the Profile tree before and after doctor to prove no files changed.

### Definition of done

Doctor prints one plain-text line per check, never leaks a credential, and performs
no writes. Every initialized Profile exits 0 even when optional checks are missing,
invalid, over cap, or unreadable; only a missing/non-file `SOUL.md` exits 1.

### Proof command

```sh
bun test src/application/doctor.test.ts && bun run check
```

## 3. `ziggy init <name|path> [--voice clear|warm|operator]`

### Current state

The CLI accepts only one positional init argument and ignores later arguments
(`src/main.ts:64-79`). `Profiles.initProfile` has no voice input
(`src/application/profiles.ts:24-33`), and it exclusively creates `SOUL.md` from
the one generic template (`src/application/profiles.ts:84-115`). The current
default template is `soulTemplate(name)` at `src/domain/profile.ts:71-87`.

The Starman source defines the three reference voices and their required section
shape at
`/Users/yesh/code/personal/starman/packages/ziggy/src/profile-initialization.ts:22-68`.
Ziggy should adapt the distinctions, not copy Starman's product identity.

### Steps

1. Add `VoiceName = "clear" | "warm" | "operator"` and a strict
   `isVoiceName`/decoder in `src/domain/profile.ts`. Keep
   `soulTemplate(name)` byte-for-byte as the omitted-flag default. Add a separate
   `voicedSoulTemplate(name, voice)` using the exact drafts below:

   clear:

   ```md
   # ${name}

   ## Persona Summary

   You are ${name}, a clear and grounded general assistant. You live in this folder: its soul, memory, sessions, and skills are your durable world. Understand the request, surface the constraints that matter, and help your person reach a sound result without ceremony.

   ## Tone Directives

   Use calm, plain language. Be direct about what you know, what you do not know, and what you changed. Avoid filler, corporate phrasing, and performative enthusiasm.

   ## Default Verbosity

   Be brief by default. Add detail when it changes a decision, prevents a mistake, or your person asks for a deeper explanation.
   ```

   warm:

   ```md
   # ${name}

   ## Persona Summary

   You are ${name}, an attentive personal assistant with practical follow-through and genuine warmth. You live in this folder: use its plain files to remember what matters, reduce friction, and support your person without becoming intrusive.

   ## Tone Directives

   Write naturally and with gentle warmth. Notice emotion when it matters, offer encouraging clarity, and never use forced cheerfulness or empty reassurance. Ask when intent is unclear; act when it is clear.

   ## Default Verbosity

   Use a conversational amount of detail. Give enough context to make the next step easy while keeping routine answers compact.
   ```

   operator:

   ```md
   # ${name}

   ## Persona Summary

   You are ${name}, a decisive engineering operator. You live in this folder and treat its plain files as the source of durable context. Turn ambiguous technical work into explicit constraints, executable actions, and verified outcomes while protecting your person's systems and data.

   ## Tone Directives

   Be direct, precise, and evidence-led. Lead with the result or blocker, name tradeoffs without hedging, and treat errors as concrete facts to diagnose. Never claim a change is complete without proof.

   ## Default Verbosity

   Prefer terse operational updates and dense technical handoffs. Expand for architecture, risk, debugging evidence, or a decision that needs review.
   ```

   Preserve the existing final newline in every generated file.
2. Change `ProfilesShape.initProfile` and its implementation to accept an optional
   `VoiceName`. Select `soulTemplate(target.name)` when omitted and
   `voicedSoulTemplate(target.name, voice)` when present. Keep the existing `wx`
   creation and early return when `SOUL.md` exists, so rerunning with a different
   voice never overwrites human-owned text
   (`src/application/profiles.ts:104-115`).
3. Parse init arguments strictly in `src/main.ts`: accept exactly one target plus
   either no flag or `--voice <clear|warm|operator>` after it. Reject a missing
   value, unknown voice, duplicate flag, `--voice=value`, and extra positional or
   flag arguments with the exact usage line and exit 2. Update the top-level usage
   text at `src/main.ts:27-38`.
4. Add domain tests that pin all three complete templates and prove the three
   required sections differ. Add application tests for omitted-flag compatibility,
   each explicit voice, exclusive creation, and rerun preservation. Add CLI parsing
   tests for every accepted/rejected shape.

### Definition of done

Omitting `--voice` creates exactly the current generic SOUL text. Each explicit
voice creates the drafted named template with distinct Persona Summary, Tone
Directives, and Default Verbosity sections. Invalid syntax exits 2 before touching
the filesystem, and no init invocation overwrites an existing `SOUL.md`.

### Proof command

```sh
bun test src/domain/profile.test.ts src/application/profiles.test.ts src/main.test.ts && bun run check
```

## 4. Exit-code discipline

### Current state

All CLI failures share `fail`, which always sets exit 1
(`src/main.ts:48-52`). Missing/malformed arguments use that helper for `init`,
`auth`, `run`, `wake`, and the three gateway commands
(`src/main.ts:64-68`, `src/main.ts:96-105`, `src/main.ts:133-141`,
`src/main.ts:151-158`, `src/main.ts:169-174`,
`src/main.ts:179-207`). Invoking Ziggy with no command prints help and also exits 1
(`src/main.ts:209-212`).

`BunRuntime.runMain` is the sole production Effect execution edge
(`src/main.ts:269-282`). Its underlying Node-compatible runner turns SIGINT/SIGTERM
into root-fiber interruption
(`vendor/effect/packages/platform-node-shared/src/NodeRuntime.ts:36-58`), and
Effect's standard teardown maps interruption-only failure to 130
(`vendor/effect/packages/effect/src/Runtime.ts:117-124`). Ziggy currently overrides
that teardown for Telegram, Discord, and Slack and explicitly maps an
interruption-only exit to 0 (`src/main.ts:271-280`). `run` itself delegates to Pi
print mode at `src/adapters/pi/pi-agent.ts:404-456`; Pi print mode does not install
a SIGINT handler, so SIGINT remains owned by `BunRuntime`.

### Steps

1. Split user-input failures from runtime failures in `src/main.ts`. Keep
   `fail(message)` at exit 1 for typed operational errors, and add
   `usageFail(message)` that prints the relevant usage line to stderr and sets exit
   2.
2. Replace every argument-shape failure with `usageFail`: missing/extra init args,
   malformed auth flags, missing run prompt/target, missing wake args, missing
   gateway target, and missing args for the new `sessions`/`doctor` routes. Change
   the no-command help path to exit 2. Provider, filesystem, decode, and other
   operational failures remain exit 1; successful commands remain 0.
3. Delete the command-specific teardown override at `src/main.ts:271-280` and call
   `BunRuntime.runMain(program, { disableErrorReporting: true })` for every command.
   Remove now-unused `Cause`, `Exit`, and `Runtime` imports from `src/main.ts:3`.
   Do not add process-level signal handlers: the existing Effect runner is the
   single signal owner and already produces 130.
4. Add process-level CLI tests, not only helper unit tests. Assert exit 2 for no
   command and each malformed command shape; exit 1 for one initialized-profile
   operational failure; and 130 after sending SIGINT to a live command. Use a
   deterministic test fixture/preload that holds a gateway request open so the
   SIGINT test does not depend on real network timing. Assert bounded stderr and
   clean child termination.

### Definition of done

Valid success is 0, operational failure is 1, every recognized usage error is 2,
and SIGINT is 130 for `run` and resident commands. There is one Effect-owned signal
path and no command-specific teardown that converts interruption to success.

### Proof command

```sh
bun test src/main.test.ts && bun run check
```
