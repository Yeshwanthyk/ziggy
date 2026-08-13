---
shaping: true
status: selected-for-implementation
updated: 2026-08-13
---

# Standalone Ziggy with bundled extensions in one executable

> **Decision, 2026-08-13:** restore compile-all. Approved repository packages are compiled into
> the one Ziggy executable. They are ~400 KB of real files; Bun+Pi+Effect dominate binary size.
> Do **not** download extension code from GitHub to run it. `extensions.json` only enables IDs
> already in the binary. Profile-local `<profile>/extensions/<id>/` still wins on collision.
> There is no `source_lookup`. The GitHub-install shape below is historical and is not the
> selected implementation.

This is the implementation authority for the next Ziggy milestone.

Ziggy is one complete executable. Optional extensions are selected, not installed-from-network.
Setup docs ship as skill `references/` (`ziggy-operations`). Pi docs later follow Pi's own npm
`docs/` + `examples/` advertisement pattern.

The work ends when `/Users/yesh/commands/ziggy` works without Homebrew Bun, this source checkout,
repository package folders, or `node_modules`, and the Squarey Profile passes the acceptance checks
in this document.

## Selected shape (restored)

| Part | Mechanism |
| ---- | --------- |
| S1 | `catalog.json` is generator input. A build-time scan emits `src/generated/builtin-catalog-metadata.ts`, `src/generated/builtin-files.ts`, and `src/adapters/pi/generated/builtin-resources.ts`. |
| S2 | `extensions list` / `show` read generated metadata. They do not scan a checkout folder. |
| S3 | `extensions add` writes `extensions.json` and provisions owned automations from embedded files. It does not copy a bundled package into the Profile. |
| S4 | Runtime `extensionFactories` = Ziggy hidden factories + selected bundled factories. `additionalExtensionPaths` = Profile-owned packages only. |
| S5 | Skills: Profile dir first, then required embedded (`pi-packages`, `extension-authoring`, `ziggy-operations`), then selected package skills. |
| S6 | Profile-owned `<profile>/extensions/<id>/` still wins on ID collision. |
| S7 | Optional external CLIs (`gh`, browsers, Apple apps) stay prerequisites, not packed in. |
| S8 | Later: Pi 0.84.1, helper-script embedding, resident self-launch, macOS arm64 clean-room. |

The remainder of this file is the superseded GitHub-install plan, kept as research context.

---

# Historical: Standalone Ziggy with a GitHub extension catalogue

This is the implementation authority for the next Ziggy milestone.

It replaces the former plan to compile every optional extension into Ziggy. Do not restore that
design. Ziggy is one complete executable. Optional extensions are immutable GitHub release assets
that Ziggy installs into a Profile.

The work ends when `/Users/yesh/commands/ziggy` works without Homebrew Bun, this source checkout,
repository package folders, or `node_modules`, and the Squarey Profile passes the acceptance checks
in this document.

## 1. Current state and exact failure

Current committed baseline:

- `6b231de` — Profile extension catalogue and Curator runtime.
- `297b0e3` — catalogue and learning-boundary documentation.
- `main` is two commits ahead of `origin/main` when this plan was written.
- `bun run check` passes.
- `bun test` passes with 379 tests.
- Squarey passes `doctor` from source mode.

The installed command is not standalone:

```text
~/.local/bin/ziggy -> /Users/yesh/commands/ziggy
/Users/yesh/commands/ziggy contains:
  /opt/homebrew/bin/bun
  /Users/yesh/code/personal/ziggy/src/main.ts
```

The launcher is allowed to remain behind the `~/.local/bin/ziggy` symlink. The problem is the
launcher content, not the symlink. Replace `/Users/yesh/commands/ziggy` with the real compiled
executable.

A fresh `bun build src/main.ts --compile` executable starts, but this command fails outside the
checkout:

```text
ziggy extensions list
unknown extension 'acp-router'
```

The first divergence is:

```text
embedded catalog.json
  -> approved ID acp-router
  -> ExtensionCatalogService.list(repositoryRoot)
  -> readExtensionPackage(repositoryRoot, "acp-router")
  -> compiled repositoryRoot is under /$bunfs
  -> extensions/acp-router/package.json is not embedded
  -> failure
```

The same physical-checkout assumption exists in Pi resource discovery, required skills, doctor,
setup, skill listing/copying, and resident self-launch.

## 2. Requirements

| ID  | Requirement                                                                                                                                                      | Status    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| R0  | A person can install and run Ziggy as one native executable without Bun, a Ziggy checkout, or `node_modules`.                                                    | Core goal |
| R1  | GitHub `catalog.json` is the only approved public extension index. Ziggy never treats a local repository folder as another catalogue.                            | Must-have |
| R2  | An approved optional extension is copied into the chosen Profile before Ziggy selects or executes it.                                                            | Must-have |
| R3  | An installed Profile continues to run, remove extensions, and validate itself without GitHub access.                                                             | Must-have |
| R4  | The executable contains Ziggy, Pi, Effect, TypeBox, and the minimal core skills needed to operate and author Profile extensions.                                 | Must-have |
| R5  | Profile extension packages stay visible under `<profile>/extensions/<id>/`. Ziggy creates no persistent extracted package shelf or hidden package cache.         | Must-have |
| R6  | CLI and TUI use one catalogue/install/select/deactivate lifecycle and one `extensions.json` selection record.                                                    | Must-have |
| R7  | Existing local extension behavior remains available, including relative source modules, skill references, helper scripts, automation templates, and macOS tools. | Must-have |
| R8  | The final artifact is proven from outside the checkout against Squarey, including runtime resource loading and resident self-launch.                             | Must-have |
| R9  | The local design leaves a clean later boundary for a Durable Object control plane and a Bun execution container. It does not implement cloud hosting now.        | Must-have |

## 3. Selected shape

### S: Compiled core plus GitHub-installed Profile extensions

| Part | Mechanism                                                                                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | A fixed HTTPS URL points to `catalog.json` on `Yeshwanthyk/ziggy`. `extensions list`, `extensions show`, `extensions add`, `skills list`, `skills add`, and the TUI fetch and Schema-decode it. Runtime startup does not fetch it.                 |
| S2   | Each catalogue entry points to one immutable GitHub release asset for one extension and includes its SHA-256. An asset contains one top-level `<id>/` package folder.                                                                              |
| S3   | `extensions add` downloads one asset, checks its byte and archive limits, verifies SHA-256, validates its tree and manifest in temporary staging, then atomically renames it to `<profile>/extensions/<id>/`.                                      |
| S4   | `extensions.json` records only active optional IDs. Runtime resolves every selected ID only from the Profile. It never falls back to the Ziggy checkout or GitHub.                                                                                 |
| S5   | `pi-packages` guidance and `extension-authoring` are compiled file assets. They are core Ziggy resources, not optional catalogue packages and not Profile copies.                                                                                  |
| S6   | Pi's compiled extension loader exposes `effect` in the same virtual-module table that already exposes Pi and TypeBox. Approved and Profile-created extensions can import the reviewed core module set without external `node_modules`.             |
| S7   | Relative modules and helper assets remain inside the installed Profile package. This preserves current Python, AppleScript, shell, and wrapper behavior. Bare imports outside the reviewed core set are rejected by the catalogue packaging check. |
| S8   | Compiled mode self-launches with `[process.execPath, ...arguments]`. Source mode may continue to use `[Bun executable, Bun.main, ...arguments]`.                                                                                                   |
| S9   | Tests inject catalogue clients and archive bytes. Production has one fixed catalogue URL. There is no ambient production environment variable that changes the trust root.                                                                         |

## 4. Fit check

| Req | Requirement                                                                                                                                                      | Status    | Selected shape |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | :------------: |
| R0  | A person can install and run Ziggy as one native executable without Bun, a Ziggy checkout, or `node_modules`.                                                    | Core goal |       ✅       |
| R1  | GitHub `catalog.json` is the only approved public extension index. Ziggy never treats a local repository folder as another catalogue.                            | Must-have |       ✅       |
| R2  | An approved optional extension is copied into the chosen Profile before Ziggy selects or executes it.                                                            | Must-have |       ✅       |
| R3  | An installed Profile continues to run, remove extensions, and validate itself without GitHub access.                                                             | Must-have |       ✅       |
| R4  | The executable contains Ziggy, Pi, Effect, TypeBox, and the minimal core skills needed to operate and author Profile extensions.                                 | Must-have |       ✅       |
| R5  | Profile extension packages stay visible under `<profile>/extensions/<id>/`. Ziggy creates no persistent extracted package shelf or hidden package cache.         | Must-have |       ✅       |
| R6  | CLI and TUI use one catalogue/install/select/deactivate lifecycle and one `extensions.json` selection record.                                                    | Must-have |       ✅       |
| R7  | Existing local extension behavior remains available, including relative source modules, skill references, helper scripts, automation templates, and macOS tools. | Must-have |       ✅       |
| R8  | The final artifact is proven from outside the checkout against Squarey, including runtime resource loading and resident self-launch.                             | Must-have |       ✅       |
| R9  | The local design leaves a clean later boundary for a Durable Object control plane and a Bun execution container. It does not implement cloud hosting now.        | Must-have |       ✅       |

## 5. Explicit non-goals

Do not add these in this milestone:

- a Cloudflare Worker, Durable Object, Container, R2 bucket, or cloud deployment;
- a marketplace web UI or separate catalogue service;
- a persistent catalogue cache;
- a hidden extracted package shelf;
- runtime npm installation or arbitrary bare-module resolution;
- catalogue signatures beyond GitHub HTTPS plus immutable asset SHA-256;
- automatic replacement or upgrade of an existing Profile package;
- a second extension selection database;
- a new extension update command;
- Windows or Linux release proof;
- source-code self-investigation tools.

The local executable must be structurally portable. Platform parity and cloud adapters are later
work.

## 6. Domain language and authority

Use these terms consistently:

| Term                  | Meaning                                                     | Authority                                            |
| --------------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| Catalogue             | Public metadata for approved optional extensions            | GitHub `catalog.json`                                |
| Catalogue entry       | One approved extension version and immutable asset identity | One decoded row in `catalog.json`                    |
| Release asset         | One `.tar.gz` containing one extension package              | Immutable GitHub release asset                       |
| Installed package     | Validated package bytes available to one Profile            | `<profile>/extensions/<id>/`                         |
| Active selection      | Optional IDs loaded by a Profile runtime                    | `<profile>/extensions.json`                          |
| Core resource         | Required guidance or code compiled into Ziggy               | The executable                                       |
| Profile-owned package | A package created locally or installed from the catalogue   | `<profile>/extensions/<id>/`                         |
| Temporary staging     | Download/extraction directory used during one install       | `<profile>/.ziggy-download-*`, deleted on settlement |

The catalogue approves. The Profile stores. `extensions.json` activates. Pi executes.

## 7. Public data contracts

### 7.1 Catalogue document

Replace the current `bundled | github` union with one public GitHub asset entry.

```json
{
  "version": 1,
  "extensions": [
    {
      "id": "self-improvement",
      "version": "0.1.0",
      "description": "Bounded Profile learning observations and Curator-managed skill packages.",
      "kind": "skill+code",
      "assetUrl": "https://github.com/Yeshwanthyk/ziggy/releases/download/extensions-2026.08.12.1/self-improvement-0.1.0.tar.gz",
      "assetSha256": "<64 lowercase hex characters>",
      "skills": [
        {
          "name": "curator",
          "description": "Review repeated completed Profile sessions and apply bounded improvements.",
          "path": "skills/curator"
        }
      ],
      "executables": ["index.ts"]
    }
  ]
}
```

Schema rules:

- `version` is exactly `1`.
- IDs use `^[a-z0-9]+(?:-[a-z0-9]+)*$` and are unique.
- Versions and descriptions are non-empty.
- `kind` is `skill`, `code`, or `skill+code`.
- `assetUrl` is HTTPS and has the exact trusted host and repository prefix:
  `github.com/Yeshwanthyk/ziggy/releases/download/`.
- `assetSha256` is 64 lowercase hexadecimal characters.
- Skill names are unique within an entry.
- Skill and executable paths are relative, normalized, non-empty, and cannot contain `..`.
- Entry arrays are sorted by ID. Skill arrays are sorted by name. Executable arrays are sorted.
- `pi-packages` is removed from this public catalogue. It becomes a core resource.

Do not put an archive URL for the same Git commit into a catalogue that also records that archive's
checksum. That release identity is circular. Publish immutable assets first. Then commit the
catalogue rows that point to them.

### 7.2 Package archive

One asset contains exactly one top-level package directory:

```text
self-improvement/
├── package.json
├── index.ts
├── src/
├── skills/
└── automations/
```

Installation limits for v1:

- maximum compressed response: 10 MiB;
- maximum regular files: 512;
- maximum total regular-file bytes: 50 MiB;
- maximum one-file size: 10 MiB;
- exactly one top-level directory named after the catalogue ID;
- no absolute paths, `..`, symlinks, devices, sockets, or other special entries;
- no `node_modules`, `.git`, secrets, or generated runtime state;
- the package manifest ID, catalogue ID, declared skills, executable paths, and automation paths
  must agree.

Use `Bun.Archive` in the runtime installer. Do not require an external `tar` executable. Inspect
archive files and limits before extraction. Inspect the extracted physical tree again before
publication.

### 7.3 Allowed extension imports

The v1 reviewed bare-module allowlist is:

```text
@earendil-works/pi-coding-agent
@earendil-works/pi-agent-core
@earendil-works/pi-ai
@earendil-works/pi-ai/compat
@earendil-works/pi-ai/oauth
@earendil-works/pi-ai/providers/all
@earendil-works/pi-tui
effect
typebox
typebox/compile
typebox/value
node:* built-ins
bun:* built-ins
```

Legacy `@mariozechner/*` Pi aliases remain accepted because Pi already supports them.

Relative imports are allowed and must remain inside the package. Catalogue publishing must fail on
another bare import. A future package that needs another library must bundle or vendor that library
under relative package paths, or Ziggy must deliberately add it to this contract.

### 7.4 Core skills

Compile these two `SKILL.md` files into the executable as Bun file assets:

- `extensions/pi-packages/skills/pi-packages/SKILL.md`;
- `skills/extension-authoring/SKILL.md`.

Pi must receive readable `/$bunfs/...` file paths for these assets. They must not be copied to a
Profile and must not appear as optional extensions.

## 8. State and lifecycle invariants

1. `extensions list` and `extensions show` read only the remote catalogue. They never scan a local
   repository or Profile.
2. `extensions add` never writes `extensions.json` until package download, checksum, extraction,
   manifest validation, and automation provisioning all succeed.
3. A failed install leaves the prior package, selection, automation definitions, and human files
   unchanged.
4. An existing `<profile>/extensions/<id>/` is never overwritten. Add validates and reuses it or
   reports a collision.
5. `extensions remove` needs no network. It pauses only exact extension-owned automation and removes
   only the selected ID.
6. Runtime startup needs no network. Every selected ID must resolve to a physical Profile package.
7. A missing selected package fails with one stable message that names the missing Profile path and
   suggests `ziggy extensions add <profile> <id>`.
8. A locally created package can be selected even when it is absent from the public catalogue.
9. The TUI calls the same application operations as the CLI. It does not implement another
   downloader or selection writer.
10. Catalogue failure is explicit. Do not silently use an embedded or cached catalogue.
11. Installed packages continue to load when GitHub is unavailable.
12. Core skill content is release-aligned with the executable.
13. Compiled resident launch vectors never contain a Bun path, `src/main.ts`, or the source checkout.

## 9. Complete breadboard

### 9.1 Places

| ID  | Place                     | Description                                                                  |
| --- | ------------------------- | ---------------------------------------------------------------------------- |
| P1  | Ziggy CLI/TUI             | The operator lists, inspects, installs, selects, or removes extensions       |
| P2  | Catalogue boundary        | Ziggy fetches and validates public approval metadata                         |
| P3  | Installer boundary        | Ziggy downloads and validates one immutable package asset                    |
| P4  | Profile filesystem        | Installed packages, active selection, automations, skills, and runtime state |
| P5  | Pi runtime                | Ziggy composes core resources and selected Profile packages into Pi          |
| P6  | Resident service boundary | launchd/systemd starts the compiled executable                               |
| P7  | GitHub release boundary   | Maintainers publish immutable assets and the public catalogue                |

### 9.2 Caller-visible affordances

| ID  | Place | Owner      | Affordance                            | Trigger         | Wires out  | Returns to |
| --- | ----- | ---------- | ------------------------------------- | --------------- | ---------- | ---------- |
| U1  | P1    | CLI        | `extensions list`                     | command         | N1         | U1         |
| U2  | P1    | CLI        | `extensions show <id>`                | command         | N1         | U2         |
| U3  | P1    | CLI        | `extensions add <profile> <id>`       | command         | N2         | U3         |
| U4  | P1    | CLI        | `extensions remove <profile> <id>`    | command         | N6         | U4         |
| U5  | P1    | TUI        | `/extensions` checklist               | command/save    | N1, N2, N6 | U5         |
| U6  | P1    | CLI        | `skills list/add`                     | command         | N1, N7     | U6         |
| U7  | P1    | CLI        | `doctor <profile>`                    | command         | N8         | U7         |
| U8  | P1    | CLI        | `serve install/start/restart`         | command         | N10        | U8         |
| U9  | P1    | CLI        | `run`, TUI, gateway, wake             | command/message | N9         | U9         |
| U10 | P7    | maintainer | package and catalogue publish scripts | command         | N11        | U10        |

### 9.3 Code affordances

| ID  | Place | Owner                        | Code affordance                                                                               | Trigger        | Wires out           | Returns to     |
| --- | ----- | ---------------------------- | --------------------------------------------------------------------------------------------- | -------------- | ------------------- | -------------- |
| N1  | P2    | GitHub catalogue adapter     | fetch and Schema-decode catalogue                                                             | U1, U2, U5, U6 | S1                  | U1, U2, U5, U6 |
| N2  | P3    | extension catalogue service  | ensure package installed                                                                      | U3, U5         | N1, N3, N4, N5      | U3, U5         |
| N3  | P3    | archive client               | bounded asset download and SHA-256 verification                                               | N2, N7         | S2                  | N4             |
| N4  | P3    | Bun archive adapter          | inspect, extract, and validate one package in staging                                         | N3             | S3                  | N5, N7         |
| N5  | P4    | Profile package publisher    | exclusive atomic package publication and automation provisioning                              | N4             | S4, S6              | N2             |
| N6  | P4    | extension deactivation       | pause owned automation and remove selection                                                   | U4, U5         | S5, S6              | U4, U5         |
| N7  | P4    | skill installer              | copy a selected skill from an installed or staged package                                     | U6             | N1, N3, N4, S7      | U6             |
| N8  | P4    | doctor resource check        | validate core assets, selection, and installed packages without network                       | U7             | S4, S5, S8          | U7             |
| N9  | P5    | Pi resource composition      | load core skills and selected Profile package resources                                       | U9             | S4, S5, S7, S8, N12 | U9             |
| N10 | P6    | resident launch resolver     | choose self-exec or source-mode launch vector                                                 | U8             | S9                  | U8             |
| N11 | P7    | release tooling              | validate package imports, build immutable assets, calculate hashes, and render catalogue rows | U10            | S1, S2              | U10            |
| N12 | P5    | Pi compiled extension loader | resolve approved virtual modules including Effect                                             | N9             | S8                  | N9             |

### 9.4 Stores

| ID  | Place | Store                         | Description                                            | Writer/source         | Reader/consumer               |
| --- | ----- | ----------------------------- | ------------------------------------------------------ | --------------------- | ----------------------------- |
| S1  | P7/P2 | GitHub `catalog.json`         | Only approved public index                             | N11                   | N1                            |
| S2  | P7/P3 | immutable release asset       | One approved package archive                           | N11                   | N3                            |
| S3  | P3    | temporary staging             | One bounded download/extraction transaction            | N3, N4                | N4, N5; deleted on settlement |
| S4  | P4    | `<profile>/extensions/<id>/`  | Installed Profile package                              | N5 or local authoring | N8, N9, N6, N7                |
| S5  | P4    | `<profile>/extensions.json`   | Active optional IDs                                    | N2 after N5, N6       | N8, N9, U5                    |
| S6  | P4    | `<profile>/automations/*.md`  | Human and extension-owned definitions                  | N5, existing commands | N6, N8, scheduler             |
| S7  | P4    | `<profile>/skills/`           | Loose Profile skills                                   | N7 or human           | N9                            |
| S8  | P5    | compiled Ziggy/Pi/core assets | Core executable code, virtual modules, and core skills | build                 | N8, N9, N12                   |
| S9  | P6    | launchd/systemd definition    | Resident command vector                                | N10                   | service manager               |

### 9.5 Main traces

Catalogue list:

```text
U1 -> N1 -> S1 -> N1 -> U1
```

Approved install and selection:

```text
U3 -> N2 -> N1 -> S1
         -> N3 -> S2 -> S3
         -> N4 -> S3
         -> N5 -> S4 + S6
         -> S5
         -> U3
```

Offline runtime:

```text
U9 -> N9 -> S8 + S5 + S4 + S7 -> N12 -> U9
```

Offline removal:

```text
U4 -> N6 -> S4 + S6 + S5 -> U4
```

Compiled resident:

```text
U8 -> N10 -> S9 -> service manager -> compiled Ziggy serve
```

## 10. Target source ownership

This is the expected destination. Agents may adjust filenames when a better existing owner is found,
but they must preserve the contracts and report the change in `LOG.md`.

| Area                 | Owner files/symbols                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Catalogue schema     | `src/domain/extension-catalog.ts` — replace the current entry union and keep tagged failures                                  |
| Catalogue HTTP       | `src/adapters/github/extension-catalog.ts` — add catalogue fetch beside bounded asset download                                |
| Catalogue service    | `src/application/extension-catalog.ts` — remove `repositoryRoot`; list/show use metadata; add installs assets                 |
| Catalogue layer      | `src/main.ts`, `src/catalog.ts` — remove embedded catalogue value and production repository-root catalogue wiring             |
| Package installer    | `src/adapters/fs/extension-installer.ts` — replace external tar and bundled copy with `Bun.Archive` asset staging             |
| Profile packages     | `src/adapters/fs/profile-extensions.ts` — selection and physical Profile package validation only                              |
| Pi resources         | `src/adapters/pi/resources.ts` — core assets plus selected Profile packages only                                              |
| Pi runtime           | `src/adapters/pi/pi-agent.ts` — no production `repositoryRoot`; retain Profile paths and add core skill assets                |
| TUI                  | `src/adapters/pi/profile-extension-selection.ts` — same catalogue service lifecycle as CLI                                    |
| Profile operations   | `src/application/profiles.ts` — remote skill metadata/install; no repository skill/package scan                               |
| Doctor/setup         | `src/application/doctor.ts`, `src/application/setup.ts` — no `repositoryRoot`; offline Profile/core checks                    |
| Compiled module map  | Bun patch for `@earendil-works/pi-coding-agent@0.82.0`; `package.json` and `bun.lock` record the patch                        |
| Resident self-launch | `src/application/resident-service.ts` and its Bun adapter/renderer tests                                                      |
| CLI output           | `src/main.ts` and `src/faces/cli.ts` — preserve the small public command surface                                              |
| Release tooling      | `tooling/extensions/` — validate, archive, hash, and render catalogue rows                                                    |
| Compiled proof       | `tooling/standalone-smoke.ts` plus focused Bun tests                                                                          |
| Product contract     | this plan, `docs/plans/skills-catalog.md`, `docs/plans/primitive-status.md`, `docs/research/minimal-ziggy-scout.md`, `LOG.md` |

Delete `src/catalog.ts` when no production caller needs the embedded catalogue. Do not leave it as a
second authority.

## 11. Vertical implementation slices

Use these slices in order. Finish, verify, update `LOG.md`, and commit each slice before starting the
next. Do not parallel-edit shared runtime files across slices.

### V1 — Remote catalogue list and show

**Demo:** An injected GitHub catalogue fixture produces stable `extensions list/show` output while a
stray repository package is ignored.

**Adds:** N1, S1, U1, U2.

**Implementation:**

1. Replace catalogue entry schemas with the contract in section 7.1.
2. Add `ExtensionCatalogClient` with `fetchCatalog()` and `downloadAsset(entry)` Effects.
3. Use Effect HTTP only inside the GitHub adapter.
4. Enforce response status and a 1 MiB catalogue-body bound before decoding.
5. Schema-decode the JSON once at the adapter boundary.
6. Change list/show to render catalogue metadata without reading a package manifest.
7. Remove `installed` and physical repository paths from global show output. Show asset version,
   source `github`, declared skills, and logical executable paths.
8. Keep the fixed production URL in one release configuration constant.
9. Tests inject a fake HTTP client or catalogue client. Do not contact GitHub in unit tests.

**Proof:**

- valid catalogue list/show;
- malformed JSON, oversized body, wrong host, duplicate ID, invalid path, and unknown ID fail typed;
- repository directories do not affect output;
- `git diff --check`, focused tests, `bun run check`.

**Commit:** `feat: read approved extensions from GitHub catalog`

### V2 — Immutable asset install into a Profile

**Demo:** `extensions add` downloads one fixture asset, installs it only under a disposable Profile,
provisions its owned automation, then selects it.

**Adds:** N2, N3, N4, N5, S2, S3, S4, S5, S6, U3.

**Implementation:**

1. Replace `installBundled/installGitHub` with one `installApproved` path.
2. Enforce the archive limits from section 7.2.
3. Replace `Bun.spawn(["tar", ...])` with `Bun.Archive`.
4. Inspect archive file names and sizes before extraction.
5. Extract into a Profile-adjacent temporary directory.
6. Reject symlinks and special files after extraction before any publish rename.
7. Reuse `readExtensionPackage` to validate the staged package manifest and declared resources.
8. Verify catalogue metadata agrees with the package manifest.
9. Provision automation definitions without overwriting Profile files.
10. Rename the staged package atomically, then write the selection atomically.
11. Preserve idempotency and collision behavior.

**Proof:**

- successful skill-only, code-only, and skill+code packages;
- wrong checksum, oversized response, too many files, oversized file/tree, wrong top directory,
  traversal, symlink, special file, manifest mismatch, and automation collision preserve Profile
  bytes;
- interruption cleans staging and does not select;
- no persistent download or package cache remains;
- focused tests, `bun run check`.

**Commit:** `feat: install approved extension assets into profiles`

### V3 — Profile-only runtime and offline removal

**Demo:** A selected installed package loads with the catalogue client unavailable. A missing
selected package fails clearly. Removal still works offline.

**Adds:** N6, N8, N9, S4, S5, U4, U7, U9.

**Implementation:**

1. Remove repository fallback from `readSelectedExtensionPackage`.
2. Make runtime selection resolve only `<profile>/extensions/<id>/`.
3. Keep locally created, unlisted Profile packages valid.
4. Remove repository package scanning from doctor and setup.
5. Make deactivation inspect the installed Profile package and pause only owned automation.
6. Change `ExtensionCatalogService.deactivate` so it needs no catalogue or network.
7. Preserve Profile skill and package collision precedence.
8. Update CLI and TUI to use this same lifecycle.

**Proof:**

- selected installed package loads while catalogue download is forced to fail;
- unlisted local package loads;
- physically present repository package is irrelevant;
- missing selected package fails with the repair command;
- remove is offline and preserves package/data;
- TUI add and remove call the same operations once;
- focused real-Pi test, doctor test, `bun run check`.

**Commit:** `refactor: load optional extensions only from profiles`

### V4 — Compile core skills and remove repository-root runtime wiring

**Demo:** `init`, `doctor`, and a minimal Pi runtime work from a compiled artifact outside the
checkout with zero selected optional extensions.

**Adds:** S8 and the core-resource portion of N8/N9.

**Implementation:**

1. Import both core `SKILL.md` files as Bun file assets.
2. Pass their readable embedded paths to Pi in the required order.
3. Remove `pi-packages` from `catalog.json` and optional selection behavior.
4. Reject `pi-packages` as a user-selectable ID with stable guidance that it is built in.
5. Remove production `repositoryRoot` from Pi agent, doctor, setup, and main service signatures.
6. Remove the embedded catalogue module `src/catalog.ts` after the last caller migrates.
7. Keep source-mode tests able to inject fixture package and skill paths where they test filesystem
   validation itself.

**Proof:**

- core skills appear exactly once in a real Pi loader;
- core skill bodies are readable from the compiled binary;
- no selected extension is required for init/doctor/runtime;
- source and compiled modes use the same core skill content;
- `rg` finds no production repository-root resource discovery;
- focused compiled smoke, `bun run check`.

**Commit:** `feat: embed Ziggy core skills in the executable`

### V5 — Effect and core imports in compiled Profile extensions

**Demo:** A compiled Ziggy process loads a disposable Profile extension that imports `effect`, Pi,
TypeBox, a Node built-in, and a relative module. The extension registers a tool and the tool runs.

**Adds:** N12 and completes R4.

**Implementation:**

1. Use `bun patch @earendil-works/pi-coding-agent@0.82.0`.
2. Patch Pi's extension loader to statically import `effect`.
3. Add `effect` to the compiled `VIRTUAL_MODULES` map.
4. Add `effect` to the source-mode Jiti alias map.
5. Commit the Bun patch, `package.json` patch metadata, and `bun.lock` changes.
6. Do not fork Pi APIs or duplicate its extension loader in Ziggy.
7. Add the bare-import allowlist check to release tooling.

**Proof:**

- `bun install --frozen-lockfile` applies the patch in a clean dependency install;
- compiled extension tool using Effect returns the expected result;
- an unapproved bare import fails validation before publication;
- existing bundled extension tests remain green;
- `bun run check`.

**Commit:** `fix: expose Effect to compiled Profile extensions`

### V6 — Remote skill list and copy

**Demo:** `skills list` shows Profile skills plus remote catalogue skill metadata. `skills add`
downloads or reuses the owning package and atomically copies one complete skill tree.

**Adds:** N7, S7, U6.

**Implementation:**

1. Remove `repositorySkillCatalog` and all repository directory scans from `Profiles`.
2. List available skills from catalogue entry metadata.
3. Give extension-owned collisions deterministic precedence by catalogue order and reject ambiguous
   duplicate skill names during catalogue decode.
4. If the owning package is already installed, copy the skill from it.
5. Otherwise, download and validate the package in temporary staging, copy only the skill tree, and
   discard staging without installing or selecting the extension.
6. Preserve explicit user path input and `--force` behavior.
7. Keep core skills out of the installable list.

**Proof:**

- remote skill metadata list;
- installed-package fast path;
- remote staging path;
- supporting references/scripts copy completely;
- collision, missing skill, force replacement, interruption, and offline errors preserve bytes;
- `bun run check`.

**Commit:** `feat: install catalog skills without a checkout`

### V7 — Compiled self-launch and clean-room executable proof

**Demo:** A copied compiled executable runs the supported matrix from a clean directory and renders a
resident service definition that invokes only itself.

**Adds:** N10, S9, U8 and completes R0/R8 except live Squarey installation.

**Implementation:**

1. Add one runtime-mode helper based on `Bun.main`, `process.execPath`, and `/$bunfs` behavior.
2. Use it in self-update and resident service launch resolution.
3. In compiled mode, return `[process.execPath, "serve", profilePath]`.
4. In source mode, return `[process.execPath, Bun.main, "serve", profilePath]`.
5. Add a production build script with Bun compile autoload of dotenv and bunfig disabled.
6. Add `tooling/standalone-smoke.ts`. It must build to a temporary directory, copy only the
   executable to another clean directory, use a temporary `HOME` and `ZIGGY_HOME`, and never resolve
   the repository while running the artifact.
7. Do not use destructive checkout renames in the normal test suite.

**Clean-room command matrix:**

- `version` and `help`;
- `init --minimal`;
- `doctor` on the minimal Profile;
- `extensions list/show` against the live GitHub catalogue after bootstrap;
- `extensions add/remove` against a fixture server before bootstrap and GitHub after bootstrap;
- `skills list/add`;
- real Pi resource load with an Effect-using Profile extension;
- resident definition rendering and a disposable `serve` start/status/interrupt lifecycle;
- scan executable strings and service output for the checkout path and `/opt/homebrew/bin/bun`.

**Proof:** `bun run standalone:smoke`, `bun run check`, `bun test`.

**Commit:** `feat: build Ziggy as a self-contained executable`

### V8 — Publish GitHub assets and catalogue

**Demo:** The public GitHub catalogue lists all approved packages and a clean executable installs one
through its immutable asset.

**Adds:** N11, final S1/S2, U10.

This slice has external effects. Confirm the repository, release name, tag, and asset list before
publishing.

**Implementation:**

1. Add deterministic package validation and archive tooling under `tooling/extensions/`.
2. Build one asset per approved optional extension. Do not publish `pi-packages`.
3. Use a release tag that points to the exact package source commit.
4. Never overwrite an existing release asset. Use a new release key for changed bytes.
5. Upload assets with `gh release create/upload` only after local validation.
6. Calculate SHA-256 from the exact uploaded bytes.
7. Render catalogue rows from validated package manifests and asset identities.
8. Commit and push the final `catalog.json` only after immutable assets exist.
9. Fetch each public asset again and verify its recorded checksum.

**Bootstrap order:**

```text
commit implementation and package sources
-> tag exact source commit
-> build and locally verify assets from that tag
-> push tag and create GitHub release
-> upload immutable assets
-> verify downloaded asset hashes
-> render final catalog.json with release URLs and hashes
-> commit and push catalog.json
-> run live catalogue and install proof
```

**Proof:**

- catalogue row count equals approved optional package count;
- every catalogue ID, version, skill, executable, and package manifest agrees;
- every public asset downloads and matches its checksum;
- live `extensions list/show/add` passes outside the checkout;
- `git diff --check`, `bun run check`, `bun test`, `bun run standalone:smoke`.

**Commit:** `chore: publish the GitHub extension catalog`

### V9 — Install and prove the real Squarey executable

**Demo:** The shell-resolved `ziggy` is the compiled artifact and Squarey works with the checkout
absent from every launch/resource path.

**Implementation:**

1. Build to a new temporary directory.
2. Run the full clean-room proof against that artifact.
3. Record the old `/Users/yesh/commands/ziggy` checksum and file type.
4. Install the new artifact with mode `0755` using an atomic replacement.
5. Preserve `~/.local/bin/ziggy -> /Users/yesh/commands/ziggy`. The symlink is correct.
6. Verify `command -v ziggy`, `readlink`, file type, executable checksum, and version.
7. Run the Squarey matrix below.
8. Do not push if any check fails or if the worktree is dirty after verification.

**Squarey matrix:**

- `ziggy extensions list` from `/private/tmp`;
- `ziggy extensions show self-improvement`;
- `ziggy extensions add /Users/yesh/.ziggy/profiles/squarey self-improvement` is idempotent;
- Squarey's selection, package manifest, and automation hashes are unchanged by the idempotent add;
- `ziggy automations validate /Users/yesh/.ziggy/profiles/squarey`;
- `ziggy doctor /Users/yesh/.ziggy/profiles/squarey` with every row `OK`;
- a fresh Pi resource load resolves Squarey's selected extension code and skills;
- `ziggy serve status /Users/yesh/.ziggy/profiles/squarey`;
- installed executable strings contain neither `/Users/yesh/code/personal/ziggy` nor
  `/opt/homebrew/bin/bun`;
- repository worktree clean; branch contains only reviewed logical commits.

**Proof:** Report installed, committed, tested, pushed, and running state separately.

**Commit:** Documentation/log only if verification changes tracked evidence. The installed binary is
not a repository commit.

## 12. Slice summary

| Slice | Demonstration                             | Main risk retired                                  |
| ----- | ----------------------------------------- | -------------------------------------------------- |
| V1    | Remote metadata-only list/show            | Repository is no longer the catalogue              |
| V2    | Verified asset installs into one Profile  | GitHub bytes safely become Profile code            |
| V3    | Runtime and removal work offline          | Runtime no longer depends on catalogue/checkout    |
| V4    | Minimal compiled Profile has core skills  | Required resources no longer need repository paths |
| V5    | Compiled Profile extension imports Effect | No external `node_modules` for core extension APIs |
| V6    | Remote skill copy works                   | `skills` commands no longer scan checkout          |
| V7    | Clean executable self-launches            | No Bun/source launcher remains                     |
| V8    | Public assets and catalogue work          | Local fixture becomes real GitHub distribution     |
| V9    | Installed Ziggy passes Squarey            | Product artifact is proven in the real Profile     |

## 13. Verification commands

Use repository scripts when the implementation adds them. At minimum, each logical block runs:

```bash
git diff --check
bun run check
bun test
```

The completed milestone also runs:

```bash
bun install --frozen-lockfile
bun run catalog:check
bun run extensions:package --all --check
bun run standalone:smoke
```

Do not claim completion from unit tests alone. The copied artifact and installed Squarey executable
are required proof.

## 14. Error contract

Keep expected failures in typed Effect channels.

| Failure                  | Stable user behavior                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| Catalogue unavailable    | State that GitHub catalogue access failed. Installed runtimes remain usable. |
| Catalogue invalid        | State that the public catalogue failed validation. Do not install anything.  |
| Unknown extension        | `unknown extension '<id>'` from decoded catalogue metadata                   |
| Asset too large          | State the configured download/archive limit and extension ID                 |
| Checksum mismatch        | `extension archive checksum mismatch`; preserve all Profile bytes            |
| Unsafe archive           | State that the archive contains an unsafe entry; do not extract/publish      |
| Package mismatch         | Name the catalogue/package field that disagrees                              |
| Destination collision    | State that Ziggy will not overwrite the existing Profile package             |
| Missing selected package | Name the Profile path and give the exact `extensions add` repair command     |
| Unsupported bare import  | Name the module and the extension package during publish validation          |
| Compiled launch error    | Do not fall back to Bun/source mode; fail with the executable path           |

Never convert these failures into empty lists, silent catalogue fallback, or partially selected
state.

## 15. Logical commit and agent rules

1. Treat each V slice as the default logical commit boundary.
2. A slice can use more than one commit only when a dependency patch or generated release data has
   an independently verifiable boundary.
3. Never commit a partially migrated service signature that breaks source mode.
4. Do not mix cloud work, unrelated docs, gateway changes, or package feature work into these commits.
5. Before staging, list exact files and inspect `git diff --cached --name-status`.
6. After committing, rerun the slice proof from the committed tree.
7. Keep `LOG.md` current for each logical block.
8. Do not push before V8 public bootstrap and V9 Squarey verification are green.
9. Do not overwrite Profile files to make tests pass.
10. If live `origin/main` moves, stop and re-establish the branch/base before publishing assets.

## 16. Rollback and recovery

- Repository rollback uses normal commit reverts. Do not reset the user's branch destructively.
- Failed package installation removes only its temporary staging directory.
- Existing Profile packages and selections remain untouched until atomic publication succeeds.
- The old installed Ziggy checksum is recorded before replacement. Keep the old executable in a
  temporary backup until the new artifact passes the Squarey matrix, then remove it explicitly.
- Do not delete published GitHub assets. Publish a corrected release key and update the catalogue.
- A bad catalogue row is corrected by a new catalogue commit. Already installed packages continue
  to run because runtime is offline and Profile-owned.

## 17. Cloud handoff after local completion

Do not implement this section during V1-V9. It records the boundary that the local design must leave.

The likely cloud shape is:

```text
Worker
  HTTP, authentication, and webhooks
        |
Durable Object per Profile
  identity, turn ownership, alarms, WebSockets, durable coordination
        |
Bun Container
  the same Ziggy executable, Pi, Profile materialization, Linux processes
        |
Durable Object SQLite + R2
  structured state, checkpoints, and artifacts
```

The local milestone gives this later work:

- one executable runtime;
- one remote catalogue contract;
- Profile-contained optional packages;
- offline runtime composition;
- explicit core module imports;
- no source-checkout resource dependency.

Cloud work must later classify extensions by required capability. Mac-only packages such as Apple
Notes, Apple Reminders, iMessage, and Things cannot run inside a Linux container or Durable Object.
They will need a connected local bridge. Do not pretend cloud mode has those capabilities.

## 18. Completion checklist

The milestone is complete only when every item is true:

- [ ] `catalog.json` is public GitHub metadata with immutable asset URLs and checksums.
- [ ] No optional package is compiled into Ziggy or read from the Ziggy checkout at runtime.
- [ ] No production catalogue or runtime path scans repository `extensions/`.
- [ ] `pi-packages` and `extension-authoring` are compiled core skill assets.
- [ ] Pi's compiled extension loader exposes Effect.
- [ ] Installed extensions need no external `node_modules` for approved core imports.
- [ ] Catalogue list/show and install work from a copied executable outside the checkout.
- [ ] Installed Profile runtimes and removal work with GitHub unavailable.
- [ ] `skills list/add`, doctor, setup, TUI, CLI, run, wake, gateway, and resident paths use the new
      ownership model.
- [ ] Compiled resident definitions self-launch the executable.
- [ ] `/Users/yesh/commands/ziggy` is the real standalone Mach-O artifact.
- [ ] The installed artifact contains no source checkout or Homebrew Bun path.
- [ ] Squarey passes the full V9 matrix without Profile-byte drift.
- [ ] `bun install --frozen-lockfile`, `bun run check`, `bun test`, catalogue checks, package checks,
      and standalone smoke all pass.
- [ ] Work is committed in reviewed logical blocks.
- [ ] Public assets, catalogue, commits, and installed artifact are reported separately.
