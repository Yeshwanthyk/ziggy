# Complete Ziggy executable with exact-source lookup

Implementation packet for a fresh AI coding session. This plan records the product decision made
after `docs/research/executable-self-discovery.md`: Ziggy ships as one executable, while source used
for investigation is fetched on demand from exact public GitHub release coordinates. This plan
supersedes the research report's sidecar-first recommendation.

Start from a clean, committed `main`. The working tree used to write this plan had concurrent
unrelated Slack and extension work; do not regenerate catalogs, stamp a release commit, or overwrite
those changes from a dirty checkout.

## Orientation

Today, the `ziggy` command used in development is a native launcher that invokes Bun against
`src/main.ts`. The application then treats the checkout as its runtime resource shelf:
`src/main.ts` derives `repositoryRoot` from `import.meta.dir`; extension manifests, executable
extension entrypoints, skills, and skill assets are discovered with ordinary filesystem calls. A
Bun standalone compile can run simple commands, but after relocation `/extensions` is absent under
`/$bunfs`, so the current executable is not distributable.

The target separates two concerns:

1. **Runtime completeness.** One downloaded executable contains Ziggy, Pi, built-in extension
   factories, required skills, selected built-in skill content, and required runtime assets. Normal
   operation does not need Bun, Node, `node_modules`, a Ziggy checkout, a runtime sidecar, or the
   network.
2. **Self-investigation.** The executable contains only a small exact-release source catalog. When
   the model is stuck after checking normal help and skills, a read-only tool fetches the exact Ziggy
   or Pi source archive identified by that catalog, verifies it, and searches or reads it. Downloaded
   source is reference material only; it is never imported or executed.

Keep `extensions/*/index.ts` and `extensions/*/skills/**` as the human authoring layout. A build-time
generator converts that layout into a statically imported runtime catalog. This is a packaging
change, not a new extension authority. `<profile>/extensions.json` remains the sole optional-package
selection authority, Profile skills retain first precedence, and Pi remains the agent loop and
resource consumer.

A “single executable” permits Ziggy's existing Profile/session/cache state and bounded temporary
files created while a tool runs. It does **not** permit adjacent installation resources, a persistent
unpacked runtime tree, or startup downloads. The source cache is created only after an explicit
source-lookup tool call and is never needed to run Ziggy.

## Settled decisions

| ID | Decision |
| --- | --- |
| D1 | The release artifact is one Bun standalone executable per target platform. No required sidecars. |
| D2 | Ziggy startup and all ordinary Profile operations work offline without a checkout, Bun/Node, or `node_modules`. |
| D3 | Repository-owned extension code is statically linked through a generated catalog; it is not downloaded from GitHub for execution. |
| D4 | Built-in skills and required non-code assets are embedded from the same manifest-validated package shelf. |
| D5 | `extensions.json` keeps its current sorted optional IDs and startup-owned selection semantics. `pi-packages` and `extension-authoring` remain required. |
| D6 | A required Ziggy operations skill handles supported workflows. Source lookup is a fallback for missing, ambiguous, or contradicted guidance—not the primary UX. |
| D7 | Source lookup resolves `ziggy` to the exact Ziggy release commit/archive and `pi` to the exact Pi 0.82.0 source release used by the executable. It never silently uses `main`, `latest`, or a moving tag. |
| D8 | Fetched source is bounded, provenance-labeled, hash-verified, read-only reference input. It is never loaded as an extension or executed. |
| D9 | Resident services launched by a compiled binary execute `[process.execPath, "serve", profilePath]`; no Bun or source-entrypoint argument is captured. |
| D10 | The first complete proof target is macOS arm64. Cross-target builds follow from the same manifest only after that artifact passes the clean-room proof. |

## Scope

### In scope

- deterministic build-time validation and generation of the built-in package catalog;
- static linking of all repository-owned Pi extension factories;
- embedding and Pi admission of built-in skills without repository directory scans;
- preserving Profile-local skill precedence and current extension selection behavior;
- preserving `skills list/add` and `extensions list/show/add/remove` from the executable;
- adapting helper-backed packages that currently assume physical repository paths;
- embedding Pi assets needed by the actual Ziggy TUI/runtime;
- an exact-release source manifest for Ziggy and Pi;
- read-only source status/search/read tools backed by verified GitHub release archives;
- compiled-mode resident launch vectors;
- deterministic macOS arm64 build and clean-room verification;
- documentation and release metadata updates.

### Out of scope

- downloading extension code for runtime execution;
- a remote extension marketplace or automatic extension updates;
- arbitrary dependency source lookup in the first slice;
- a custom agent loop, provider layer, or session format;
- self-update, auto-install, code signing/notarization automation, or GitHub release publishing;
- making optional external products such as `gh`, Apple applications, browsers, or service CLIs part
  of the Ziggy binary. Their extension skills must continue to report explicit prerequisites;
- executing anything from the source-reference cache;
- bundling the complete Ziggy or Pi source trees into the executable.

## Preserved authorities and contracts

| Concern | Authority after this work | Contract |
| --- | --- | --- |
| Profile policy and memory | Human-owned files under the Profile | Never generated from or shadowed by the runtime catalog. |
| Optional package selection | `<profile>/extensions.json` | Sorted unique IDs; required IDs excluded; changes apply to a newly opened runtime/restarted resident process. |
| Built-in package metadata | Generated catalog produced from repository `package.json#pi` manifests | Build fails on invalid IDs, manifests, collisions, missing files, escapes, or stale generated output. |
| Built-in extension execution | Statically imported extension factories in the executable | Only required/selected factories are passed to Pi. GitHub source is never executable authority. |
| Built-in skill execution | Embedded skill entries generated from the same package manifests | Profile-local declared-name collision wins, then required skills, then selected package skills in ID order. |
| Session history | Pi JSONL under the Profile | Unchanged. |
| Source identity | Embedded release-source manifest | Exact repository, commit/version, archive URL, archive SHA-256, and logical root. |
| Source cache | `$ZIGGY_HOME/cache/source/<component>/<commit-or-version>/` | Optional, read-only reference cache; atomically populated only by source lookup. |
| Resident launch | Generated launchd/systemd definition | Compiled binary launches itself; source mode may still launch Bun + `Bun.main` for development. |

## Current paths that must change

| Current path/symbol | Current assumption | Target |
| --- | --- | --- |
| `src/main.ts` — `repositoryRoot` | `import.meta.dir/..` is a physical checkout | Remove production `repositoryRoot`; inject a built-in catalog capability. |
| `src/adapters/fs/profile-extensions.ts` — `readExtensionPackage`, `scanExtensionShelf`, `setExtensionSelection` | Built-in manifests and resources are read from repository directories at runtime | Profile selection I/O remains filesystem-owned; package lookup/validation comes from generated catalog values. |
| `src/adapters/pi/resources.ts` — `discoverPiResources` | Returns extension and skill paths | Return selected catalogue factories and embedded skill descriptors while preserving selected physical Profile extension and skill paths. |
| `src/adapters/pi/pi-agent.ts` — `createProfileRuntime` | Passes `additionalExtensionPaths` and repository skill paths | Pass catalogue factories through `extensionFactories`; merge embedded catalogue skills through `skillsOverride`; retain Profile-local physical extension and skill paths. |
| `src/application/profiles.ts` — `repositorySkillCatalog`, extension list/show/mutate | Lists and copies from repository directories | List/show from catalog metadata; copy embedded skill files into the Profile for `skills add`; selection validation uses catalog IDs. |
| `src/application/doctor.ts` — resource check | Rediscovers checkout paths | Validate catalog/selection and embedded resource availability without filesystem mutation. |
| `src/application/setup.ts` and service signatures | Thread `repositoryRoot` through setup/doctor | Remove the argument and consume the catalog capability. |
| `src/application/resident-service.ts` / `resolveResidentLaunch` | `Bun.main` may be treated as a physical entrypoint | Explicitly distinguish source mode from standalone mode; compiled vector is always self-exec. |
| `package.json` | Development entrypoint only | Add generation, stale-check, binary build, and clean-room smoke scripts. |

## Target runtime catalog

Generate a checked-in TypeScript module, for example
`src/adapters/pi/generated/builtin-catalog.ts`, from a deterministic script such as
`tooling/generate-builtin-catalog.mjs`. The generator is the only code that scans the repository
shelf. Production runtime code imports the generated value and performs no repository discovery.

The generated surface should be equivalent to:

```ts
interface BuiltInSkillFile {
  readonly logicalPath: string;
  readonly embeddedPath: string;
  readonly executable: boolean;
  readonly sha256: string;
}

interface BuiltInSkill {
  readonly name: string;
  readonly description: string;
  readonly disableModelInvocation: boolean;
  readonly filePath: string;
  readonly baseDir: string;
  readonly files: ReadonlyArray<BuiltInSkillFile>;
}

interface BuiltInPackage {
  readonly id: string;
  readonly description: string;
  readonly kind: "skill" | "code" | "skill+code";
  readonly required: boolean;
  readonly sourcePath: string;
  readonly extensionFactory?: InlineExtension;
  readonly skills: ReadonlyArray<BuiltInSkill>;
}

interface BuiltInCatalog {
  readonly packages: ReadonlyArray<BuiltInPackage>;
  readonly extensionAuthoring: BuiltInSkill;
  readonly fingerprint: string;
}
```

The exact type names may change, but preserve these properties:

- every extension factory is a static top-level import;
- every embedded file has a logical path and content hash;
- generated ordering is deterministic;
- metadata is sufficient for list/show/selection without disk access;
- skill `filePath`/`baseDir` values point to Bun-embedded files that Pi's in-process read tool can
  read;
- build uses `--asset-naming=[dir]/[name].[ext]` (or a proven equivalent) so relative references
  resolve predictably;
- generated `SourceInfo` is created through Pi's exported `createSyntheticSourceInfo` rather than
  fabricated assertions;
- the generator rejects symlinks, path escapes, duplicate package or skill IDs, invalid
  frontmatter, missing declared files, and unsupported entry types;
- `bun run check:catalog` regenerates in memory or in a temporary location and fails if the checked-in
  module is stale.

Do not move runtime metadata into a second hand-maintained catalog. Repository manifests remain the
authoring source; the generated module is a release artifact checked for drift.

## Target execution flows

### Open a Profile

```text
ziggy executable
→ decode Profile extensions.json
→ validate IDs against BuiltInCatalog
→ retain Profile-local skill path, if present
→ select required + selected embedded skills
→ select required + selected static extension factories
→ Pi createAgentSessionServices
     no ambient extensions/skills
     additionalSkillPaths = Profile-local only
     extensionFactories = Ziggy hidden factories + selected built-ins
     skillsOverride = Profile skills first + selected embedded skills
→ normal Pi session/TUI/print/gateway execution
```

### Add a catalog skill to a Profile

```text
ziggy skills add <profile> <id>
→ resolve embedded skill by ID
→ validate complete generated file list and hashes
→ copy bytes from embedded paths into same-directory staging tree
→ preserve intended executable bits only
→ atomically publish under <profile>/skills/<id>
→ existing --force and no-symlink guarantees remain
```

This is a user-requested Profile mutation, not runtime extraction. Once copied, the Profile owns the
installed skill tree under existing rules.

### Investigate source when stuck

```text
model checks loaded skill / ziggy help
→ still needs implementation facts
→ source_lookup({ component: "ziggy" | "pi", action: "status" | "search" | "read", ... })
→ resolve exact embedded release-source entry
→ use verified cache if complete
→ otherwise fetch exact public release source archive
→ enforce timeout/size cap and SHA-256
→ inspect with Bun.Archive and atomically populate read-only cache
→ search or read bounded passages
→ return repository + version/commit + logical path + line range + hash
```

A network failure, unavailable archive, or integrity mismatch returns a typed tool failure. It never
blocks ordinary Ziggy startup or changes the Profile.

### Install a resident service

```text
source mode:     [process.execPath, Bun.main, "serve", profile]
standalone mode: [process.execPath, "serve", profile]
```

The mode decision must be explicit and tested. Do not infer solely from whether `stat(Bun.main)`
succeeds, because Bun's virtual `$bunfs` paths may satisfy in-process filesystem probes.

## Implementation chunks

### Chunk 0 — Freeze a clean baseline and prove the red executable behavior

**Behavior delivered:** A reproducible failing proof and an isolated output location for executable
work, without changing production behavior.

**Files/symbols:**

- add a focused smoke script under `tooling/`, not a shell blob inside package scripts;
- `package.json` temporary/proof command if useful;
- no production source change yet.

**Steps:**

1. Start from clean committed `main`; record commit, Bun 1.3.13, package lock hash, and platform.
2. Compile `src/main.ts` with `--compile`, `--no-compile-autoload-bunfig`, and
   `--no-compile-autoload-dotenv` into a temporary directory.
3. Copy only the executable to a second clean directory and run `version`, `help`, and
   `extensions list`.
4. Retain the expected red proof that extension/resource discovery fails under `$bunfs`.
5. Add a regression harness that can later turn green without referencing the checkout in its run
   environment.

**Verification:** The harness passes only when it observes the known failure category; it must not
leave build output in the repository.

**Risk:** A source-mode test can accidentally resolve the checkout. The harness must execute the
copied artifact with a temporary `HOME`/`ZIGGY_HOME` and a cwd outside the repository.

### Chunk 1 — Generate and validate the static built-in catalog

**Behavior delivered:** Every repository package is represented by deterministic generated metadata;
all ten current executable `index.ts` files are statically imported.

**Files/symbols:**

- new `tooling/generate-builtin-catalog.mjs`;
- new generated `src/adapters/pi/generated/builtin-catalog.ts`;
- new domain/catalog value types in a focused `src/domain/extension-catalog.ts` or equivalent;
- `package.json` scripts: `generate:catalog`, `check:catalog`;
- focused generator tests/fixtures under `tooling/`.

**Steps:**

1. Reuse the existing package ID, manifest, path-containment, and skill-frontmatter invariants from
   `src/adapters/fs/profile-extensions.ts`; do not create weaker build-only parsing.
2. Sort package IDs, declared extension paths, skill roots, and files deterministically.
3. Generate static imports for all extension factories and embedded asset imports for all skill
   files.
4. Include top-level required `skills/extension-authoring/SKILL.md` and make the required Ziggy
   operations skill explicit in the generated catalog. If that skill does not yet exist, add it as a
   focused package/reference rather than injecting large docs into every prompt.
5. Include repository/release logical source paths for later source lookup, but no live checkout
   paths.
6. Make generation idempotent and stale-checkable.

**Verification:**

- generator fixtures reject duplicate IDs, invalid manifests, missing files, symlinks, escapes, and
  duplicate declared skill names;
- production shelf test asserts every current package and all ten extension factories appear once;
- two generations are byte-identical;
- `bun run check:catalog` fails after a fixture manifest changes without regeneration;
- `bun run check` remains green.

**Risk:** Generated files can become a hidden second authority. The stale check and deterministic
regeneration are mandatory before runtime migration.

### Chunk 2 — Replace runtime repository discovery with the catalog capability

**Behavior delivered:** CLI extension listing/selection, doctor, setup, and Pi runtime composition no
longer require `repositoryRoot`.

**Files/symbols:**

- `src/main.ts` — remove production `repositoryRoot` threading;
- `src/adapters/fs/profile-extensions.ts` — retain only Profile selection decoding/writing and
  physical Profile safety;
- `src/application/profiles.ts` — replace `repositorySkillCatalog`, list/show/mutate lookup;
- `src/application/doctor.ts`, `src/application/setup.ts` — consume catalog-based checks;
- `src/adapters/pi/resources.ts` — produce selected embedded resources/factories;
- `src/adapters/pi/profile-extension-selection.ts` — use catalog values;
- corresponding tests.

**Steps:**

1. Introduce one typed read-only catalog capability/value and inject it into application services.
2. Move built-in package lookup out of the Profile filesystem adapter; do not make application code
   import generated adapter values directly.
3. Preserve byte-for-byte `extensions.json` no-op behavior and existing atomic replacement.
4. Preserve list/show ordering, descriptions, package kinds, required markers, and TUI multi-select.
5. Replace absolute checkout paths in CLI show output with stable logical catalog paths such as
   `extensions/weather`.
6. Remove `repositoryRoot` from public application service signatures once all consumers migrate.

**Verification:** Existing Profile extension/list/show/add/remove, doctor, setup, and TUI selection
tests pass against an injected catalog. Add a test that changes cwd and hides the repository after
catalog import; all read-only catalog operations still succeed.

**Risk:** This touches several service signatures. Keep it one complete vertical migration; do not
leave mixed catalog/filesystem package authority.

### Chunk 3 — Compose Pi from static factories and embedded skills

**Behavior delivered:** A Profile runtime loads required/selected built-ins from the executable while
preserving Profile-local skill precedence.

**Files/symbols:**

- `src/adapters/pi/resources.ts` — new `PiResources` shape;
- `src/adapters/pi/pi-agent.ts` — `createProfileRuntime` resource loader options;
- generated catalog helper that maps embedded descriptors to Pi `Skill` values;
- `src/adapters/pi/resources.test.ts` and real-Pi loading proof.

**Steps:**

1. Keep Pi ambient discovery disabled.
2. Pass static code extensions through `extensionFactories`; stop using
   `additionalExtensionPaths` for repository packages.
3. Keep `<profile>/skills` as the only physical `additionalSkillPaths` source.
4. Use `skillsOverride` to append required and selected embedded `Skill` descriptors after
   Profile-local skills, de-duplicating by declared skill name with current precedence.
5. Create `SourceInfo` with Pi's `createSyntheticSourceInfo` and stable logical package origins.
6. Keep Ziggy hidden factories (`ziggy-tui`, Profile memory, Profile agent guidance, automation
   handler) in their existing order; add selected package factories without duplicating them during
   runtime replacement.
7. Prove a selected code extension tool and a selected skill-only package through the actual Pi
   loader in both source and compiled modes.

**Verification:**

- selected and required skill/factory sets are exact and sorted;
- a broken unselected package cannot block a Profile, while generator/repository checks still fail
  the build globally;
- Profile-local collision wins;
- selection changes apply only after runtime reopen/restart;
- Pi diagnostics contain no missing-path or duplicate-resource failures;
- the copied standalone executable runs `extensions list`, opens a minimal Profile runtime, and no
  longer accesses the checkout.

**Risk:** Bun 1.3.13 embedded directories do not support normal `readdir`, but explicit embedded file
paths work in-process. The generated catalog must enumerate files; no runtime directory scan may
remain.

### Chunk 4 — Preserve skill installation and helper-backed package behavior

**Behavior delivered:** `skills add` copies embedded trees correctly, and every currently executable
package has an explicit compiled-mode strategy.

**Files/symbols:**

- `src/application/profiles.ts` — `resolveSkillSource`, `copySkill`, and embedded-source branch;
- helper-backed packages currently including `agent-browser`, `diffs`, `linear`,
  `open-computer-use`, `web-search`, plus any generator-discovered skill scripts;
- package-specific focused tests.

**Steps:**

1. Extend skill source resolution to a discriminated physical-or-embedded source. Preserve external
   physical path installation only where it is an intentional existing CLI feature.
2. Copy embedded files by manifest, verify hashes, preserve only declared executable bits, and use
   the existing sibling staging/atomic publication path.
3. Generate a compatibility inventory for every package file referenced through `new URL(...,
   import.meta.url)`, every Python/JS helper spawned by a code extension, and every skill instruction
   that executes a relative script.
4. Choose the smallest per-package fix:
   - import repository-owned JS/TS helper logic in-process where its contract is already a function;
   - materialize a bounded helper to a process-owned temporary directory only for the duration of a
     child-process call when an external interpreter/tool genuinely requires a physical path;
   - keep external product executables as explicit extension prerequisites;
   - port a Python helper only when temporary materialization cannot preserve behavior.
5. Never populate a persistent runtime sidecar or execute anything downloaded by source lookup.
6. Ensure interruption cleans temporary helper trees and never writes them into the Profile unless
   the user invoked `skills add`.

**Verification:**

- nested skill assets and templates survive `skills add` byte-for-byte;
- overwrite refusal/`--force`, symlink rejection, and atomic replacement remain;
- each helper-backed code extension has one compiled-artifact focused test;
- process interruption leaves no helper temp tree;
- optional missing external executables produce the existing bounded tool error rather than a
  module/path failure.

**Risk:** This is the largest compatibility surface. Do not declare the executable complete while
any selected built-in package fails only because its repository-relative helper disappeared.

### Chunk 5 — Embed Pi runtime assets required by Ziggy

**Behavior delivered:** TUI and current Pi-backed operations run from the one-file artifact without
Pi's normal sidecars.

**Files/symbols:**

- build generator/config;
- focused Pi adapter bootstrap as needed;
- exact Pi 0.82.0 paths for theme assets, interactive images, HTML export templates, Photon WASM,
  and optional clipboard native modules;
- compiled-mode tests.

**Steps:**

1. Inventory which Pi sidecar assets Ziggy actually exercises. Do not copy Pi's full binary release
   layout blindly.
2. Embed statically addressable assets with explicit imports and logical names.
3. For Pi APIs that insist on directory scans, prefer an existing override/injection API. If none
   exists, add the narrowest Ziggy adapter shim and document the pinned Pi dependency.
4. Directly include platform-native modules where Bun's standalone support requires static imports.
5. Keep platform-specific build inputs isolated so macOS arm64 does not accidentally embed another
   target's native binary.
6. Run the real TUI in a controlled terminal from outside the checkout.

**Verification:** `version`, `help`, Profile initialization, model status, one print turn, one TUI
turn, session continuation, and HTML/session behavior actually used by Ziggy run with only the
artifact present. Missing optional clipboard support may degrade explicitly, but must not crash
startup.

**Risk:** Pi's official binary uses sidecars. This chunk is a release blocker and must be proven
against the exact pinned 0.82.0 implementation rather than guessed from current upstream.

### Chunk 6 — Add exact-release source catalog and read-only lookup

**Behavior delivered:** When normal guidance is insufficient, the agent can fetch, search, and read
the exact public Ziggy or Pi source corresponding to the running executable.

**Files/symbols:**

- new generated `src/generated/release-source-manifest.ts` or equivalent;
- new domain schemas/errors, for example `src/domain/source-reference.ts`;
- new focused GitHub release/archive adapter, for example
  `src/adapters/github/source-archive.ts`;
- new application service `src/application/source-reference.ts`;
- Pi tool definition in `src/adapters/pi/source-reference-tool.ts`, admitted in
  `createProfileRuntime`;
- required Ziggy operations skill/reference explaining when to use it;
- build script fields for repository, commit/version, URL, SHA-256, logical root, and maximum size.

**Tool contract:**

```text
source_lookup
  component: "ziggy" | "pi"
  action: "status" | "search" | "read"
  query?: string
  path?: string
  offset?: integer
  limit?: integer
```

Return bounded text plus component, repository, release/version, exact commit, path, line range, and
archive/content hash. Search result count, read bytes, archive bytes, redirects, and request duration
must be capped.

**Steps:**

1. Generate Ziggy coordinates from a clean release commit. Dirty developer builds are marked dirty
   and must either disable remote self-source lookup or point only to the last committed tree while
   clearly reporting the mismatch.
2. Resolve Pi coordinates from a checked-in reviewed mapping for exact `0.82.0`; verify the official
   source release asset and checksum before implementation relies on it.
3. Fetch only after a tool call. No startup network and no hidden background refresh.
4. Use a focused Effect boundary with Schema-decoded metadata and typed failures. The repository's
   current raw-fetch guidance permits only Telegram, so update that policy/skill explicitly as part
   of this approved second raw HTTP boundary; do not introduce an unreviewed fetch elsewhere.
5. Verify SHA-256 before making content available. Use `Bun.Archive` for tar inspection/extraction;
   independently reject absolute paths, traversal, unsafe links, duplicates/case collisions,
   excessive counts, and expanded-size overflow.
6. Populate the cache through a same-parent temporary directory and atomic rename. A completion
   manifest binds cache content to the source entry and archive hash.
7. Search only regular text files with bounded per-file and total work. Read rejects paths outside
   the component root.
8. Treat all returned source as untrusted reference content. Never add fetched instructions to the
   system prompt automatically and never pass cache paths into Pi extension or skill loading.
9. The required operations skill tells the model: use help/loaded skills first, then source lookup;
   cite exact paths/commits; never substitute `main` or `latest`.

**Verification:**

- status does not perform network I/O;
- first lookup downloads and verifies the exact archive; second lookup uses cache;
- offline miss, timeout, 404, redirect overflow, size overflow, hash mismatch, malformed archive,
  traversal, link, and cancellation all return stable typed failures;
- search/read are bounded and provenance-labeled;
- source cache mutation is detected and repaired/refused, never silently trusted;
- fetched fixture code cannot register a tool or enter runtime resource paths;
- Squarey's automation question can locate the exact automation docs/domain implementation without
  a developer checkout.

**Risk:** GitHub-generated archives and release assets have different stability guarantees. Prefer
published release source assets with recorded checksums. Do not stamp an unverifiable URL/hash into
a release.

### Chunk 7 — Make resident services self-launch the compiled binary

**Behavior delivered:** `serve install` from the artifact writes a service definition containing only
the executable, `serve`, and the resolved Profile path.

**Files/symbols:**

- `src/application/resident-service.ts` — `ResidentServiceRuntime`, `definitionFor`;
- `src/adapters/bun/resident-service.ts` — `resolveResidentLaunch`;
- launchd/systemd renderer tests and subprocess proof.

**Steps:**

1. Add an explicit runtime-mode value (`source` or `standalone`) at the executable boundary.
2. In standalone mode, skip `Bun.main` resolution completely.
3. Preserve source-mode development launch vectors.
4. Include runtime mode/vector in the service fingerprint so an old Bun+source definition is
   detected as drift and replaced only under existing managed-definition rules.
5. Install/start/status/restart/stop/uninstall a disposable compiled service.

**Verification:** Retained plist/unit evidence contains no Bun path, checkout path, `$bunfs` path, or
`node_modules`; restart survives moving/renaming the development checkout; logs and readiness remain
unchanged.

**Risk:** Replacing or moving the executable after service installation changes its launch target.
Self-update/install-path policy is outside this plan; document that the installed executable path
must remain stable.

### Chunk 8 — Build command, clean-room proof, and documentation convergence

**Behavior delivered:** One reproducible macOS arm64 artifact meets the complete-executable contract.

**Files/symbols:**

- `package.json` final scripts;
- build driver under `tooling/`;
- generated catalog and release-source manifest checks;
- `README.md`, `AGENTS.md`, `docs/research/minimal-ziggy-scout.md`,
  `docs/research/executable-self-discovery.md`, operations docs, and `LOG.md`.

**Build behavior:**

1. require clean release source for a release-stamped artifact;
2. run catalog generation/stale check and release-source manifest validation;
3. run existing `bun run check` and focused tests;
4. compile with Bun 1.3.13, explicit target, deterministic defines, and no standalone dotenv/bunfig
   autoload;
5. emit one executable plus a machine-readable build report outside the distributed artifact;
6. hash the artifact and record source commit, Bun version, target, lock hash, catalog fingerprint,
   and source-manifest entries.

**Clean-room proof:** Copy only the executable to a disposable location or VM with the Ziggy checkout
absent, Bun/Node and `node_modules` absent, network initially disabled, and fresh `HOME`/`ZIGGY_HOME`.
Prove:

- `version` and complete help;
- minimal and guided Profile initialization;
- extensions list/show/add/remove and TUI multi-select;
- selected skill-only and code-extension loading;
- `skills add` with nested assets;
- doctor/model status without unwanted writes;
- one real print turn and one real TUI turn with continuation;
- automation create/validate and one manual wake;
- resident install/start/status/restart/stop/uninstall with self-exec launch vector;
- no reads from the original checkout and no required adjacent files;
- offline source lookup fails clearly without affecting runtime;
- after enabling network, Ziggy and Pi exact-source status/search/read succeed and cite their pinned
  identities.

Update the old research report with a prominent decision note rather than deleting its option
analysis. Update the minimal architecture sentence that previously deferred a compiled-executable
gate. Document development (`bun src/main.ts`) separately from distribution (`dist/ziggy`).

**Risk:** A smoke run on the build machine can accidentally satisfy native or PATH dependencies.
The final claim requires an environment that lacks the development checkout and language runtimes,
not merely a different cwd.

## Verification matrix

| Contract | Focused proof | Artifact proof |
| --- | --- | --- |
| Catalog completeness | Generator inventory equals manifests and expected package/factory counts | `extensions list/show` outside checkout |
| Selection authority | Existing decode/atomic/no-op tests against injected catalog | Add/remove, reopen, tool/skill availability changes |
| Skill precedence | Profile collision test over embedded required/optional skills | TUI `/skill` resolves Profile version |
| Static extension loading | Real Pi loader test with selected factories | Selected code tool executes from copied artifact |
| Skill installation | Embedded nested tree byte/mode tests | `skills add`, compare installed bytes |
| Helper compatibility | One focused compiled test per helper-backed package | Representative external and in-process helper calls |
| Pi assets | Exact pinned adapter/TUI tests | Real print/TUI/session smoke with one file |
| Source identity | Generated manifest clean/dirty/version tests | `source_lookup status` reports artifact commit/Pi 0.82.0 |
| Source integrity | Hash/archive/path/cap fixtures | First download then verified cache reuse |
| Offline independence | Network adapter never called during startup/runtime tests | Full ordinary smoke with network disabled |
| Source isolation | Cache paths cannot enter resource loader | Fetched fixture cannot register tools |
| Resident self-launch | Source/standalone vector unit tests | Installed service contains only executable + serve + Profile |
| One-file distribution | Build output assertion | Copy only executable; checkout/Bun/node_modules absent |

Required gates before the milestone is called complete:

```sh
bun run check:catalog
bun run check
bun test ./src ./extensions
bun run test:helpers
bun run build:binary
bun run smoke:binary
```

Use the repository's final script names if they differ, but preserve separate catalog drift, normal
quality, build, and clean-room smoke gates.

## Rollout

1. Land generator/catalog infrastructure while source mode remains the default development path.
2. Migrate all runtime consumers to the catalog and keep source-mode behavior green.
3. Close every helper and Pi asset incompatibility; do not hide unsupported packages from the
   catalog to make the smoke test pass.
4. Land source lookup after the runtime artifact is already independent of GitHub.
5. Land self-launching service behavior and run the disposable macOS service proof.
6. Publish the macOS arm64 artifact as an experimental/manual build only after the clean-room matrix
   passes.
7. Add macOS x64, Linux x64/arm64, and Windows only with target-native asset/helper proofs. Do not
   label untested cross-compiles supported.

Observability should stay bounded and local:

- `version` includes only the Ziggy version by default;
- source tool status reports exact source identities and cache state without network;
- doctor gains checks for generated catalog fingerprint and release-source manifest validity, but
  does not fetch source;
- build reports and retained clean-room evidence live outside Profiles and are not runtime state.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Generated catalog drifts from manifests | Deterministic generator, checked-in output, mandatory stale check. |
| Mixed filesystem/catalog authority | Complete signature migration in Chunk 2; generated catalog is sole built-in runtime authority. |
| Bun virtual filesystem lacks directory operations | Enumerate every file at build time; use explicit embedded paths; no runtime scans. |
| Relative skill helper cannot be used by a subprocess | Per-package in-process adaptation or bounded process-temp materialization; compiled tests. |
| Pi expects official binary sidecars | Exact 0.82.0 inventory and real TUI proof; use narrow injection/shims, not guesses. |
| Dirty binary points to source it does not contain | Release builds require clean commit; dirty dev artifacts clearly disable/mismatch source lookup. |
| GitHub outage blocks ordinary Ziggy | Source fetch only occurs on explicit lookup; runtime catalog is embedded. |
| Moving branch/tag explains wrong behavior | Manifest pins exact release asset/commit and SHA-256; never resolve latest. |
| Prompt injection in fetched source/docs | Bounded tool output with provenance; no automatic prompt append; never execute. |
| Source archive traversal or decompression bomb | Hash, byte/file/count caps, strict path/link validation, atomic cache publish. |
| Service captures development invocation | Explicit standalone mode and retained plist/unit assertion. |
| Optional external integration mistaken for core dependency | Skills report prerequisites; clean-room core matrix distinguishes built-in runtime from external product calls. |

## Open implementation decisions and gating spikes

These do not reopen the product shape, but the new session must resolve them before claiming the
corresponding chunk complete.

1. **Embedded skill path proof.** Confirm Bun 1.3.13 plus explicit asset naming preserves direct
   `SKILL.md` and relative asset reads through Pi's in-process read tool in a compiled artifact.
   Directory enumeration is not required. This gates Chunk 3.
2. **Helper compatibility matrix.** Record the chosen in-process, process-temp, or external-prerequisite
   strategy for every generator-discovered helper. This gates Chunk 4 and the all-packages claim.
3. **Pi asset map.** Determine exactly which official Pi sidecars are reached by Ziggy's current
   TUI/print/session paths and how each is embedded or injected. This gates Chunk 5.
4. **Verified source artifacts.** Confirm stable exact archive URLs and SHA-256 values for Ziggy's
   release source and Pi 0.82.0. If Pi's official source artifact/checksum is unavailable, add a
   reviewed release-time archival mechanism rather than trusting a moving GitHub-generated tarball.
   This gates Chunk 6.
5. **Raw HTTP policy update.** Amend the repository's raw-fetch guidance to permit only the existing
   Telegram boundary and the new read-only exact-source archive boundary, each independently typed
   and tested. This gates production source download.

No other product decision is open: the target is one runtime-complete executable with exact public
source lookup on demand.
