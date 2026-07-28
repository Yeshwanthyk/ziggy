# Skills catalog implementation plan

## Current direction and status — 2026-07-27

The live source is `../merlin`, not an in-repo Ziggy catalog. Ziggy must discover every direct
Pi skill under `../merlin/extensions/*/skills/*/SKILL.md` plus
`../merlin/skills/*/SKILL.md`. Extension-owned entries win ID collisions with the top-level
directory. The current tree contains 65 payloads and 61 unique IDs.

The Tier 1 vertical slice is implemented in the current worktree:

- `ziggy skills list <name|path>` reports Profile-installed skills and all 61 live Merlin skills;
- `ziggy skills add <name|path> <id|path> [--force]` copies the complete selected directory into
  `<profile>/skills/<id>`;
- replacement is staged and atomic, and an existing install is preserved unless `--force` is
  explicit;
- focused service tests cover collision precedence, nested assets, refusal, whole-tree
  replacement, and sorted listing;
- the dump Profile at `/Users/yesh/Documents/personal/dump/ziggy-vertical-slices/pal` sees all 61
  skills, has `humanizer` installed, and Pi's SDK TUI discovers it.

The older in-repo Starman porting proposal below is retained as research history. Where it
conflicts with this section—especially `catalog/`, the 40-entry roster, the first-six stopping
point, and later bundling tiers—this section is authoritative.

## Context

Ziggy already admits Profile-local Pi skills, but it has no bundled catalog or CLI for
installing them. Starman has 40 bundled extensions, but they cannot be copied unchanged:
Starman bundles use `extension.json`, supervised-command modules, and skill text that names
Starman-only command tools. Pi only understands the nested skill content, so every port must
become a plain Pi skill whose instructions invoke the real executable through Pi's `bash` tool.
The audit identifies this as a product gap and confirms that Profile-local skill admission is
already proven (`docs/research/starman-coverage-audit.md:59-69`). It also recommends the same
directory-copy model used by Hermes and OpenClaw (`docs/research/starman-coverage-audit.md:100-134`).

This plan is the implementation handoff. A fresh agent should execute Tier 1 in the order below,
stop at the headless-policy gate unless approval is recorded, and leave Tier 2 alone until a
compiled Ziggy executable exists.

### Outcome

Tier 1 adds:

- an in-repo `catalog/` containing portable Pi-format skills;
- the first six ports: `github`, `linear`, `tmux`, `weather`, `web-search`, and `summarize`;
- `ziggy skills add <name|path> <id|path> [--force]`;
- `ziggy skills list <name|path>`;
- focused tests and a TUI proof that an installed skill is discovered and can run.

No manifest, registry, approval database, extension host, or remote catalog is introduced.
The installed directory under `<profile>/skills/` remains the only Tier 1 state.

## Current state

### Pi's skill contract

Pi discovers an explicit skill directory through `additionalSkillPaths`. A directory containing
`SKILL.md` is a skill root and is not recursively treated as another catalog. A skill requires a
frontmatter `description`; `name` is optional but, when present, should be lowercase words
separated by hyphens. The Markdown body is the instruction payload, and relative references
resolve from the directory containing `SKILL.md`
(`docs/research/pi-sdk-surface.md:318-335`).

The Tier 1 on-disk contract is therefore:

```text
catalog/
  <id>/
    SKILL.md
    scripts/       # optional
    references/    # optional
    assets/        # optional

<profile>/
  skills/
    <id>/          # complete copy of catalog/<id> or an arbitrary source directory
      SKILL.md
      ...
```

Do not add `extension.json` to catalog entries. Do not put one skill below another skill's
directory: Pi stops traversal once it finds the outer `SKILL.md`
(`docs/research/pi-sdk-surface.md:325-327`).

### Runtime admission and tool policy

`createProfileRuntime` checks for `<profile>/skills` and, when present, passes that directory as
the only `additionalSkillPaths` entry. Default/global skill discovery is disabled with
`noSkills: true`, so the Profile directory remains the admission boundary
(`src/adapters/pi/pi-agent.ts:459-513`).

Tool access is a separate boundary:

- TUI calls `createProfileRuntime(..., "default")`, so Pi's default tools, including `bash`, are
  available (`src/adapters/pi/pi-agent.ts:647-671`).
- `ziggy run` calls `createProfileRuntime(..., "memory-only")`
  (`src/adapters/pi/pi-agent.ts:404-422`).
- Gateway handles and automation wake handles use `openChat`, which also passes
  `"memory-only"` (`src/adapters/pi/pi-agent.ts:607-623`).
- `"memory-only"` becomes `tools: ["memory_write"]`; default mode omits that filter while still
  registering Ziggy's custom `memory_write` tool (`src/adapters/pi/pi-agent.ts:494-500`).

Consequently, command-driving catalog skills work in the TUI today but cannot execute in
`run`, Telegram, Discord, Slack, or wake.

### Profiles application service

`Profiles` owns Profile filesystem operations through an Effect service. Its public shape
currently contains initialization, registry append, and profile listing
(`src/application/profiles.ts:24-36`). Implementations map filesystem failures into
`ProfileFileSystemError`, use exclusive creation for human-owned `SOUL.md`, tolerate missing
directories where appropriate, and return sorted listings
(`src/application/profiles.ts:38-115`, `src/application/profiles.ts:142-202`).

The skills operations belong in this service because they mutate Profile-owned files. Keep raw
filesystem calls inside the service implementation and expose Effect-returning methods to the
CLI.

### CLI conventions

`src/main.ts` uses a literal usage string, reads `process.argv` directly, resolves every
name-or-path through the common Profile resolution options, handles one command per switch case,
prints successful results to stdout, and funnels typed failures through the final
`Effect.catchTags` block (`src/main.ts:27-63`, `src/main.ts:64-95`,
`src/main.ts:219-267`). `run` demonstrates positional parsing with an optional flag
(`src/main.ts:151-168`). Follow that style; do not introduce a CLI framework for these two
commands.

Name-or-path Profile resolution treats path-like tokens as cwd-relative/absolute paths and plain
tokens as names under `~/.ziggy/profiles` (`src/domain/profile.ts:32-68`). Skill source resolution
should deliberately mirror this user-facing behavior without reusing `resolveProfileTarget`,
because a skill's display name and destination ID have different semantics.

## Locked decisions

### LOCKED — Tier 1 catalog shape

`catalog/` lives at the repository root. Every entry is one self-contained Pi-format skill at
`catalog/<id>/SKILL.md`. `description` is required; `name` is optional and, when supplied, is the
same lowercase-hyphen ID as the directory. Supporting scripts, references, and assets stay below
that skill directory so installation is a single recursive copy.

Every Starman port must be rewritten. A ported `SKILL.md` tells the model to use Pi's `bash` tool
to invoke the real CLI or a bundled, dependency-free Bun script. It must never mention or attempt
to invoke Starman command tools such as `use-github`, `linear-graphql`, `tmux-inspect`,
`weather`, `web-search`, or `summarize-extract` as agent tools.

`smart-memory` is a special case: rewrite its instructions to use Ziggy's existing
`memory_write` tool. It must not add another memory file, tool, database, or authority. The audit
records the same constraint (`docs/research/starman-coverage-audit.md:114-134`).

### LOCKED — catalog roster and port order

The bundled Starman catalog contains these 40 extension IDs:

```text
acp-router
agent-browser
apple-notes
apple-reminders
architecture-diagram
automation-creator
codex
coding-agent
diffs
executor
gh-issues
github
github-issues
github-pr-triage
gog
goplaces
here-now
humanizer
linear
lossless-claw
mcporter
nano-pdf
notion
obsidian
onepassword
open-computer-use
openai-whisper
peekaboo
qmd
self-improving-agent
session-logs
skill-creator
skill-curator
smart-memory
summarize
things-mac
tmux
weather
web-search
xurl
```

Port in this priority order: `github`, `linear`, `tmux`, `weather`, `web-search`, `summarize`,
then rank the remaining 34 by usefulness at the time of each port. Tier 1's first implementation
slice ends after the first six are usable and proven; the roster is not a requirement to create
34 empty placeholders. The audit confirms both the 40-entry gap and that the original bundles
are not Pi-compatible as-is (`docs/research/starman-coverage-audit.md:63-69`,
`docs/research/starman-coverage-audit.md:100-106`).

### LOCKED — Tier 1 CLI

`ziggy skills add <name|path> <id|path> [--force]` installs one skill:

- resolve `<name|path>` with `resolveProfileTarget`;
- if the source token is a lowercase-hyphen ID, resolve it under the repository `catalog/`;
- if the source token has path syntax, resolve it against cwd as an arbitrary skill directory;
- derive the destination ID from the catalog ID or arbitrary source directory basename;
- copy the complete source directory to `<profile>/skills/<id>`;
- refuse any existing destination unless `--force` is present;
- with `--force`, replace the complete destination rather than merging trees.

`ziggy skills list <name|path>` prints two sorted sections: installed Profile skills and currently
available catalog skills. An ID present in both sections is still printed in both; Tier 1 does not
infer versions or update state.

### LOCKED — later tiers

Tier 2 starts only after the compiled executable ships. It embeds catalog files through Bun
embedded assets, extracts instead of copying from the checkout, and adopts Hermes'
`.bundled_manifest` update semantics. Tier 3, a remote catalog repository, remains out of scope.
The reference comparison supporting these choices is
`docs/research/starman-coverage-audit.md:202-210`.

## Open decisions

### OPEN — headless tool policy; approval required from hsey

Today every headless path is memory-only. The recommended split is:

- local interactive and explicitly invoked faces — TUI and `ziggy run` — receive Pi's default
  tools plus `memory_write`;
- unattended or remote faces — Telegram, Discord, Slack, and automation wake — remain
  memory-only until Ziggy has an approval mechanism.

This makes `run` useful with catalog skills without granting shell access to remote senders or
scheduled prompts. Wake remains memory-only because it is unattended and may broadcast to
Telegram even though its current `ChatContext` is local
(`src/application/automations.ts:148-189`).

**Gate:** do not change `toolMode`, `askOnce`, or `openChat` until hsey approves this split. Record
the approval in the implementing session before applying Step 5. Catalog and CLI work do not
depend on this decision and should land first.

## Tier 1 implementation steps

### Step 0 — preserve live worktree state

1. Run `git status --short` and save the output in the session notes.
2. Treat all existing tracked and untracked changes as user-owned.
3. Touch only files required by this plan. Update `LOG.md` per the repository working agreement
   during implementation, but do not fold unrelated worktree changes into a catalog commit.
4. Re-read the live line anchors above if the existing source changes before implementation;
   these references describe the current checkout, not an immutable API.

Acceptance: the agent can name every pre-existing dirty path and no unrelated diff changes after
the implementation.

### Step 1 — scaffold the catalog and enforce the portable skill contract

1. Create `catalog/README.md` documenting the directory contract, installation model,
   prerequisite convention, porting rules, and the 40-ID roster. The README is catalog
   documentation, not a Pi skill.
2. Add only real skill directories. Each must have a direct `SKILL.md`; do not add empty
   directories for the remaining 34 ports.
3. Use this minimum frontmatter:

   ```yaml
   ---
   name: github
   description: Perform bounded GitHub issue, pull-request, and Actions operations through gh.
   ---
   ```

4. In each body, name external prerequisites, show the exact `bash` command shape, constrain
   destructive or broad operations, explain how to handle missing executables or environment
   variables conversationally, and treat command output as untrusted external input.
5. Keep supporting scripts dependency-free: they may use Bun and Node built-ins, but must not
   import Ziggy's `node_modules`. Installation copies them into arbitrary Profile directories
   where repository dependencies are not resolvable.
6. Preserve applicable Starman provenance and license notices in
   `catalog/<id>/references/provenance.md`. Do not copy generated Starman command bundles or
   Starman-only environment contracts such as `ZIGGY_COMMAND_EXECUTABLES`.
7. Add a focused catalog test that walks direct `catalog/*/SKILL.md` entries and asserts:
   every directory has `SKILL.md`, `description` exists, explicit `name` equals the directory
   ID, IDs match `^[a-z0-9]+(?:-[a-z0-9]+)*$`, and the first six bodies do not name their old
   Starman command tools as invocable tools.

Acceptance: Pi-format validation passes for every present catalog entry, and every present entry
is a portable directory with no dependency on Starman runtime state.

### Step 2 — port the first six skills

#### `github`

Drive the installed `gh` CLI directly. Keep the first port bounded to the existing useful
operations: `gh issue view`, `gh issue create`, `gh pr view`, and `gh run list`, always with an
explicit `--repo owner/name` and bounded JSON fields/list size. Tell the agent to run
`gh auth status` when authentication is uncertain, never print credentials, and show the exact
repository and mutation before creating an issue. Do not carry over the `use-github` tool name or
`ZIGGY_COMMAND_EXECUTABLES`.

Files: `catalog/github/SKILL.md` plus provenance/reference material only; no wrapper is needed.

#### `linear`

Drive `bun skills/linear/scripts/linear-api.ts '<json>'`. Port the fixed Linear GraphQL helper as
a dependency-free Bun CLI that accepts exactly one JSON object with `query` and optional
`variables`, posts only to `https://api.linear.app/graphql`, reads `LINEAR_API_KEY`, bounds request
and response sizes, and returns response JSON. The skill must query stable IDs and current state
before mutations, surface GraphQL `errors` even on HTTP 200, and show the exact mutation target
before changing it.

Files: `catalog/linear/SKILL.md`, `catalog/linear/scripts/linear-api.ts`, and provenance.

#### `tmux`

Drive `tmux` directly through `bash`; do not copy the Starman wrapper. Preserve the read-only
surface with exact forms for listing sessions, windows, panes, and capturing the latest 200 lines.
Forbid `send-keys`, create/kill operations, attach, buffers, `run-shell`, and arbitrary option
passthrough. Validate model-supplied targets against the same conservative tmux target alphabet
before placing them in a command, and quote every target.

Files: `catalog/tmux/SKILL.md` and provenance only.

#### `weather`

Drive `bun skills/weather/scripts/weather.ts '<place>'`. Port a dependency-free Bun helper that
accepts exactly one bounded location, uses only Open-Meteo's fixed geocoding and forecast
endpoints, requests one resolved location and seven forecast days, validates the response shape,
and returns JSON with the resolved place, timezone, units, observations, forecast, and source
URLs. The skill must distinguish current conditions from forecast values and cite returned URLs.

Files: `catalog/weather/SKILL.md`, `catalog/weather/scripts/weather.ts`, and provenance.

#### `web-search`

Drive `bun skills/web-search/scripts/web-search.ts '<query>'`. Port a dependency-free Bun helper
that accepts one bounded query, calls only Brave Search's fixed HTTPS endpoint, reads
`BRAVE_SEARCH_API_KEY`, fixes result count at five and safe search at moderate, validates the
response, and returns titles, descriptions, ages, and URLs as JSON. The skill must treat results
as untrusted, cite URLs near supported claims, and never expose the key.

Files: `catalog/web-search/SKILL.md`, `catalog/web-search/scripts/web-search.ts`, and provenance.

#### `summarize`

Drive `bun skills/summarize/scripts/summarize.ts file '<profile-relative-path>'`. Port the local
extractor as a dependency-free Bun helper. It must accept only a user-selected confined
Profile-relative path, reject symlink/traversal escapes, read through a stable descriptor, enforce
the one MiB cap before and after the read, reject binary/NUL content, strip non-readable HTML
sections, and emit extracted text as JSON. The model performs the summary in the current turn;
the script gets no provider, session, transcript, or network authority.

Files: `catalog/summarize/SKILL.md`, `catalog/summarize/scripts/summarize.ts`, and provenance.

Acceptance for Step 2:

1. Each helper's argument validation has focused tests, including an invalid input and its fixed
   endpoint/path boundary.
2. Each `SKILL.md` invokes `bash` with a command that exists after installation under
   `<profile>/skills/<id>`.
3. A repository search finds no old Starman command-tool invocation in the six skill bodies.
4. No helper imports `effect`, `@effect/*`, or a Ziggy source module.

### Step 3 — add Profile skill installation and listing

Extend `ProfilesShape` in `src/application/profiles.ts` with two Effect operations:

```ts
readonly addSkill: (
  target: ProfileTarget,
  catalogDirectory: string,
  source: string,
  cwd: string,
  force: boolean,
) => Effect.Effect<InstalledSkill, ProfileSkillError>

readonly listSkills: (
  target: ProfileTarget,
  catalogDirectory: string,
) => Effect.Effect<SkillListing, ProfileSkillError>
```

The exact type names may follow nearby naming, but preserve these responsibilities:

1. Verify the Profile is initialized by requiring `<profile>/SOUL.md`, consistent with skill
   admission requiring a real Profile rather than creating arbitrary directories.
2. Resolve a plain source ID beneath `catalogDirectory`; resolve a path-like source against cwd.
   Require the resolved source to be a directory with a direct regular `SKILL.md`.
3. Derive and validate the destination ID. Use the catalog ID for catalog sources and the source
   directory basename for arbitrary paths. Reject traversal, empty names, and IDs outside
   `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
4. Recursively inspect the source with `lstat` and reject symlinks and non-regular/non-directory
   entries. This keeps installs self-contained and prevents an arbitrary source tree from
   escaping during copy.
5. Copy into a unique sibling staging directory under `<profile>/skills/`, then rename the
   complete staged directory into place. Always clean abandoned staging on failure.
6. Without `--force`, fail before mutation when the destination exists. With `--force`, move the
   old destination to a unique backup, promote the staged directory, restore the backup if
   promotion fails, and remove the backup only after success. Force means full replacement, never
   a recursive merge.
7. Return `{ id, sourcePath, destinationPath, replaced }` for deterministic CLI output.
8. For listing, treat direct child directories containing a regular `SKILL.md` as skills, sort by
   ID, and return separate `installed` and `available` arrays. Ignore unrelated files and
   incomplete directories rather than presenting them as usable skills.

Add typed failures for invalid source, invalid ID, missing `SKILL.md`, already-installed
destination, and filesystem failure. Put stable Profile/skill error definitions with the other
Profile domain failures, then add the new tags to `src/main.ts`'s centralized catch block. Do not
throw defects for expected operator input.

Focused service tests must prove:

- catalog-ID and arbitrary-path installation copy nested supporting files;
- a second install refuses to overwrite and leaves bytes unchanged;
- `--force` replaces the whole tree, including removal of stale destination-only files;
- invalid sources and symlinks fail before destination mutation;
- listing is sorted and separates installed from available entries;
- a failed staged replacement restores the old installed skill.

Acceptance: the Profiles service can install and list skills without `src/main.ts`, and every
expected failure is typed.

### Step 4 — expose `ziggy skills add` and `ziggy skills list`

1. Add both forms to the usage string in `src/main.ts`.
2. Resolve the development catalog root from the source checkout in one function, based on
   `import.meta.dir` and the repository-root `catalog/`. Keep that resolution at the entrypoint so
   Tier 2 can replace the source without changing Profile mutation rules.
3. Add a `case "skills"` branch with strict parsing:

   ```text
   ziggy skills add <name|path> <id|path> [--force]
   ziggy skills list <name|path>
   ```

4. Accept `--force` only once and only as the final `add` argument. Reject missing or extra
   arguments with the exact relevant usage line and exit code 1, matching current conventions.
5. Call `profiles.addSkill` or `profiles.listSkills`; do not perform filesystem work in
   `src/main.ts`.
6. Print add success as one stable line:
   `installed <id> at <destination>` or `replaced <id> at <destination>`.
7. Print list output in two labeled sections:

   ```text
   installed:
     summarize
   available:
     github
     linear
     summarize
     tmux
     weather
     web-search
   ```

   Print `(none)` below an empty section so the output is unambiguous.
8. Provide no implicit install, update, remove, enable, disable, or sync behavior.

Acceptance: both commands work with Profile names and Profile paths, arbitrary skill sources work
from cwd-relative and absolute paths, and malformed argv never mutates the Profile.

### Step 5 — change local headless tool policy only if approved

**Blocked until hsey explicitly approves the open decision above.**

If approved:

1. Replace the stringly `toolMode` parameter with a named policy type whose two values clearly
   mean local-default and remote/unattended-memory-only. Keep policy selection at face call sites.
2. Make `askOnce`, and therefore `ziggy run`, construct the local-default runtime.
3. Keep `openTui` local-default.
4. Keep `openChat` memory-only for Telegram, Discord, and Slack.
5. Keep automation wake memory-only because it is unattended and may broadcast. If hsey wants
   wake to use shell-capable skills, record that as a separate approval decision rather than
   inferring it from `run`.
6. Add a focused runtime-construction test or an extracted pure-policy test proving the mapping:
   TUI/run omit the Pi tool filter; gateway/wake pass only `memory_write`.

If approval is absent, skip this step, mark the run-face proof pending, and still complete every
other Tier 1 step.

## Proof

### Automated gate

Run:

```sh
bun run fmt
bun run lint
bun run typecheck
bun test
bun run check
git diff --check
```

`bun run check` is the repository pre-commit gate defined by the project working agreement.
Run the focused tests during development, then run the complete gate above before each logical
commit.

### TUI end-to-end proof

Use `summarize` because it is deterministic, local, and exercises both an installed supporting
script and Pi's `bash` tool.

```sh
export ZIGGY_HOME="$(mktemp -d)"
bun src/main.ts init skills-proof
printf '# Skills proof\nThe planted catalog skill executed successfully.\n' \
  > "$ZIGGY_HOME/profiles/skills-proof/proof.md"
bun src/main.ts skills add skills-proof summarize
bun src/main.ts skills list skills-proof
bun src/main.ts skills-proof
```

Inside the TUI:

1. Run `/skill` and verify `summarize` is shown.
2. Load/select `summarize` using Pi's displayed skill command.
3. Prompt: `Summarize proof.md using the summarize skill. Include the document heading.`
4. Verify the assistant invokes
   `bun skills/summarize/scripts/summarize.ts file proof.md` through `bash`.
5. Verify the answer includes `Skills proof` and the success sentence.

Save the observed command and response in implementation notes. This proves the entire path:
catalog directory → copy into Profile → `additionalSkillPaths` admission → `/skill` discovery →
skill instructions → `bash` → bundled helper.

Also run negative CLI proofs:

```sh
bun src/main.ts skills add skills-proof summarize
bun src/main.ts skills add skills-proof summarize --force
bun src/main.ts skills list skills-proof
```

The first repeat must fail without changing the destination; the forced repeat must succeed and
the final list must still contain one installed `summarize`.

### `run` end-to-end proof, only after tool-policy approval lands

```sh
bun src/main.ts run skills-proof \
  "Summarize proof.md using the summarize skill. Include the document heading."
```

Verify the printed answer contains `Skills proof` and the success sentence, and capture evidence
that the helper executed. If Step 5 did not land, do not weaken the proof or temporarily grant
tools; record this proof as gated and pending.

### Completion gate

Tier 1 is complete when:

- all six catalog entries pass format and helper tests;
- add/list behavior and overwrite safety pass service tests;
- the full repository gate passes;
- the TUI proof passes;
- the run proof passes if and only if the approved policy change landed;
- logical commits keep catalog ports, CLI/service work, and any separately approved tool-policy
  change reviewable.

## Tier 2 — after the compiled executable ships

Do not begin this section while Ziggy is source-run only. The trigger is a real compiled-executable
build and smoke test in the repository.

### Embedded catalog

1. Generate a build-time catalog index containing every skill ID, every relative file path,
   content length, and SHA-256 digest.
2. Generate explicit Bun asset imports for every catalog file and compile them into the executable
   as embedded assets. Do not depend on a checkout-relative `catalog/` at runtime.
3. Add a catalog-source abstraction with development-filesystem and compiled-embedded
   implementations. `skills list` reads metadata from the selected source; `skills add` extracts
   the selected embedded directory into the same Profile staging flow used by Tier 1.
4. At executable startup or first catalog access, verify the generated index and embedded bytes
   agree. A missing or digest-mismatched asset is a packaged-build failure, not an empty catalog.
5. Add a compiled smoke test that runs the executable outside the checkout, lists embedded
   catalog skills, installs one into a temporary Profile, and proves all supporting files arrived.

### Bundled-manifest sync semantics

Add `<profile>/skills/.bundled_manifest` as the only Tier 2 catalog baseline. It maps a bundled
skill ID to the digest of the exact directory last copied from Ziggy. Write it atomically.
Implement Hermes' four-state behavior described in
`docs/research/starman-coverage-audit.md:204-209`:

1. New bundled skill, no manifest entry, no local destination: copy it and record the embedded
   digest.
2. Tracked local skill whose current digest equals the recorded origin digest: it is unchanged by
   the user; upgrade it when the embedded digest changes, then record the new digest.
3. Tracked local skill whose current digest differs from the recorded origin digest: preserve it
   byte-for-byte and report `user-modified`; do not advance its recorded origin digest.
4. Tracked skill missing locally: treat it as user-deleted and do not resurrect it.
5. Bundled skill removed from the executable: remove only its manifest entry, never a local
   directory.
6. New bundled skill colliding with an untracked local directory: preserve the local directory and
   do not claim it in the manifest unless its digest is exactly equal to the embedded skill.

Use the same backup/promote/restore transaction as forced Tier 1 installation. Sync must emit a
summary of copied, upgraded, unchanged, user-modified, user-deleted, collided, and removed-from-
bundle IDs. Add state-transition tests for every branch plus interruption recovery.

Decide the invocation point during Tier 2 implementation. Prefer an explicit
`ziggy skills sync <name|path>` until automatic startup mutation has a clear product requirement;
the update semantics are locked, but silent automatic mutation is not.

## Out of scope

Tier 3 is a remote catalog git repository fetched by immutable release tag. Its index would use
the same skill-directory and digest contract as the embedded catalog, and a fetched tag with a
newer accepted catalog version would win over the embedded version. Authentication, provenance,
signature/trust policy, caching, offline fallback, and remote update UX must be designed together;
none of them belong in Tier 1 or Tier 2.

Also out of scope: Starman `extension.json`, supervised-command infrastructure, seals,
permissions manifests, registries, scanners, skill enable/disable/remove commands, global skill
admission, TS extension cataloging, remote-channel shell approval, and a second memory system.
