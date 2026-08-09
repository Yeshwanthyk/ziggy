# Source and documentation self-discovery in a Ziggy executable

Read-only distribution report. Ziggy was inspected from the live working tree based at
`f33439b922b50d6e0c378fd9e43e9a2e9999dd4e`; Pi facts were checked against the exact
`@earendil-works/pi-coding-agent@0.82.0` installation and the upstream `v0.82.0` commit
`083e61621276bff9f6faefab87ce07fcd98734e2`. Bun behavior is pinned to Bun `1.3.13`
revision `bf2e2cecf` rather than the changing latest documentation.

> **Subsequent product decision:** Ziggy will ship as one runtime-complete executable with no
> required sidecars or startup extraction. The executable will carry a generated static extension
> and skill catalog; exact Ziggy and Pi source will be fetched from verified public release
> coordinates only when the agent explicitly needs implementation facts. The implementation packet
> is `docs/plans/standalone-executable-and-source-lookup.md`. This supersedes the sidecar-first
> recommendation below while retaining the option analysis as research history.

## Executive finding

A compiled module graph is not a source or documentation distribution. Ziggy currently derives a
repository root from `import.meta.dir`, then discovers repository-owned extensions and skills with
ordinary filesystem calls. In a Bun executable, that directory is inside Bun's virtual `$bunfs`,
while unreferenced repository directories are not bundled. A disposable compile of the current
entrypoint ran `--version`, `--help`, and minimal Profile initialization after relocation, but its
repository skill catalog was empty. Refs: `src/main.ts:60-61,121-124,184-210`;
`src/adapters/pi/resources.ts:65-83`; Bun 1.3.13 executable docs
[lines 6-40](https://github.com/oven-sh/bun/blob/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79/docs/bundler/executables.mdx#L6-L40).

Pi has already made the relevant product decision for its own binary: compile the program, then
copy README, changelog, docs, examples, themes, images, HTML-export assets, and a WASM file beside
the executable. In compiled mode Pi resolves package assets from `dirname(process.execPath)`, with
`PI_PACKAGE_DIR` as an override. Its system prompt advertises those physical README/docs/examples
paths to the agent. Refs: Pi v0.82.0
[`package.json:31-39`](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/package.json#L31-L39),
[`src/config.ts:15-23`](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/config.ts#L15-L23),
[`src/config.ts:357-464`](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/config.ts#L357-L464),
[`src/core/system-prompt.ts:74-77,131-138`](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/system-prompt.ts#L74-L138).

**Recommended default:** distribute a versioned runtime bundle containing the Ziggy executable and
an immutable, namespaced knowledge/resource sidecar. Make a true single-file build a second release
shape implemented as an embedded, content-addressed archive that is exposed through a dedicated
lookup tool and extracted when real filesystem paths are required. In both shapes, always carry
Ziggy operational knowledge and exact-version Pi knowledge offline; use package-manager retention
and verified network retrieval only as fallbacks, especially for arbitrary dependencies.

## Three different knowledge obligations

These should not be presented as one promise.

| Scope | Authority and version | What Ziggy should promise |
|---|---|---|
| **Ziggy-owned operational knowledge** | The exact Ziggy release: product policy, CLI behavior, Profile formats, repository-owned skills/extensions, production source, and focused behavioral tests | Always available offline and release-aligned. This is required to understand Ziggy behavior and is under Ziggy's release control. Do not indiscriminately label old research notes as current operational truth. |
| **Pi SDK/API knowledge** | The exact Pi artifact actually bundled into that Ziggy binary, currently `0.82.0`, plus its exact transitive Pi package versions from `bun.lock` | Always provide Pi README/docs/examples/types and an inspectable exact source representation. Configure Pi's own advertised paths to resolve to that copy. Never show docs for “latest Pi” beside a binary using `0.82.0`. |
| **Arbitrary third-party dependency knowledge** | The exact full lock graph, not merely direct semver declarations | Guarantee an inventory, version, integrity, license metadata, and whatever files the exact publication actually contained. Full source/docs are best effort: publishers differ, repository metadata may be absent, and a published tarball may contain only generated JS, declarations, native binaries, or WASM. Never claim universal source availability. |

The lock distinction matters. Ziggy pins `@earendil-works/pi-coding-agent` exactly in
`package.json:16-19`, while Pi's own manifest uses compatible ranges for its Pi packages. The live
`bun.lock:74-82` resolves `pi-agent-core`, `pi-ai`, `pi-coding-agent`, and `pi-tui` all to `0.82.0`
and records SHA-512 integrity. A release manifest must identify the resolved lock graph and content,
not reconstruct it later from range declarations.

## Current distribution facts

### Ziggy

`package.json:2-19` describes a private source package (`"private": true`) whose `bin` points to
`src/main.ts`; it has a development script but no compile, packaging, or release script. npm would
refuse to publish a private package. There is also no `files` allowlist. An
`npm pack --dry-run --json` probe of this working tree enumerated 2,794 files (about 6.25 MB packed
/ 31.05 MB unpacked),
including internal `.pi` data and the vendored Effect checkout, rather than a deliberate release
surface. npm's `files` field defaults to `['*']` when omitted; package metadata, README, LICENSE, and
`main`/`bin` targets have special inclusion rules. Refs: official npm
[`package.json#files`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#files),
[`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack/).

The runtime currently assumes a source checkout. `src/main.ts:60` computes
`path.resolve(import.meta.dir, '..')`; `src/adapters/pi/resources.ts:69-83` then requires
`extensions/pi-packages`, `skills/extension-authoring/SKILL.md`, and selected extension resources
beneath that root. Repository-owned operational material is modest in this checkout: approximately
1.1 MB under `src/`, 1.0 MB under `extensions/`, 44 KB under `skills/`, and 476 KB under `docs/`.
Those numbers make a curated offline Ziggy knowledge pack practical.

### Squarey test case

`/Users/yesh/.ziggy/profiles/squarey` demonstrates both the immediate product gap and why the
current setup gives a misleading distribution proof. When asked to create a daily weather
automation, the agent first tried `ziggy --help` and automation help commands. It then searched the
developer checkout and read `docs/operations/automations.md`, two internal plan documents, and
`src/domain/automation.ts` before creating and validating the Profile definition. Ref:
`/Users/yesh/.ziggy/profiles/squarey/sessions/local/main/2026-08-08T22-18-43-531Z_019fe374-ffcb-743e-933b-4246bba4539f.jsonl`.

That lookup was useful, but basic automation authoring should not require source archaeology. The
release should expose a required, progressively loaded Ziggy operations/automation-authoring skill
with the supported schema and workflow. Exact source remains the fallback when documentation is
missing, ambiguous, or contradicted by observed behavior.

The `ziggy` command used for this test is not the future standalone artifact. It is a 33 KB native
launcher whose embedded strings invoke `/opt/homebrew/bin/bun` with
`/Users/yesh/code/personal/ziggy/src/main.ts`; the installed Squarey launchd service likewise runs
Bun against that source path. The checkout is therefore available only because the launcher and
resident service explicitly depend on it. A direct Bun compile of the current entrypoint can print
version output, but `ziggy extensions list` fails after relocation with
`ENOENT ... /$bunfs/extensions`. The production packaging proof must run from a clean directory or
machine with the development checkout renamed or absent.

### Exact Pi publication

The npm registry tarball for `@earendil-works/pi-coding-agent@0.82.0` is 4,974,873 bytes packed and
13,020,420 bytes unpacked, with 880 files and SRI
`sha512-Qnqgn9zhJFQ2HZ8R4iNuGhyCk93XX6+eUw9i+TjTuo47amzCy93ft3bB6yaUCleCrNO58dJDHYSGNHv/GAPWKg==`.
The exact artifact is
[`pi-coding-agent-0.82.0.tgz`](https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.82.0.tgz),
and the same SRI appears at `bun.lock:78`.

Its `files` allowlist publishes `dist`, `docs`, `examples`, `containerization.md`, `CHANGELOG.md`,
and `npm-shrinkwrap.json` (`node_modules/@earendil-works/pi-coding-agent/package.json:23-30`). An
inventory of the exact tarball found 713 `dist/` files, 35 docs, 128 examples, and no `src/`
directory. This is better than it first appears: all 176 published JavaScript source maps contained
`sourcesContent`, totaling about 1.79 MB of original TypeScript. Thus exact Pi source is present in
an archival but inconvenient form; a release-time knowledge-pack step can either preserve the
maps or deterministically materialize their `sourcesContent` into a read-only source tree.

The local pi-mono checkout at `/Users/yesh/Documents/personal/reference/pi-mono` was also inspected
at `4181f66e6b3ccbef760c2966ecd8b596b926fec6` (`v0.84.1-37-g4181f66e6`). Its current
`packages/coding-agent/package.json:27-40` retains the same publication allowlist and compile-then-
copy-sidecars architecture. Current upstream is useful corroboration, but it must not substitute
for the v0.82.0 artifact that Ziggy actually bundles.

The package metadata says MIT, and the upstream repository root license permits redistribution of
software and documentation provided its copyright and permission notice are included. Refs: Pi
v0.82.0 `packages/coding-agent/package.json:92-97` and upstream `LICENSE:1-21`. The exact npm
tarball has no LICENSE file because the license lives at the monorepo root, not the package root.
A Ziggy distribution that redistributes Pi docs/source must therefore deliberately include that
notice; it should not assume npm packing supplied it.

### Arbitrary dependency publications

Publication content is package-specific. In this install, `effect@4.0.0-beta.99` contains a full
`src/` tree, while `@silvia-odwyer/photon-node@0.3.4` contains generated JS/types and a WASM binary
but no Rust source. Retaining `node_modules` therefore retains *published files*, not necessarily
upstream source. A production-only install from the current lock occupied about 220 MB across 97
top-level package directories in a disposable probe, much larger than a curated Ziggy/Pi pack.
Package-manager retention is useful evidence and a fallback, but it is not a uniform knowledge
contract.

## Bun 1.3.13 executable and asset constraints

Bun 1.3.13 bundles statically imported files/packages and the Bun runtime. Immutable extra files can
be embedded with `import assetPath from './file' with { type: 'file' }`; the import becomes a
`$bunfs/...` path readable by `Bun.file()` and in-process Node filesystem APIs. Directory embedding
at this version requires expanding files into build inputs/imports, which the official docs call a
workaround. `Bun.embeddedFiles` lists embedded non-module assets, and asset names are hashed unless
asset naming is configured. Refs: exact Bun 1.3.13 docs
[lines 669-735](https://github.com/oven-sh/bun/blob/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79/docs/bundler/executables.mdx#L669-L735),
[846-970](https://github.com/oven-sh/bun/blob/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79/docs/bundler/executables.mdx#L846-L970).

Disposable Bun 1.3.13 probes established practical boundaries relevant to Ziggy:

- A compiled entrypoint reported `import.meta.dir === '/$bunfs/root'`, while `process.execPath`
  identified the real executable. Resolving a distribution root from `import.meta.dir` is wrong;
  executable-adjacent assets must start from `dirname(process.execPath)`.
- Explicit `.md`, `.txt`, `.ts`, and `.js` file imports could be read in-process and listed through
  `Bun.embeddedFiles`. Preserving logical directory names required an explicit naming/manifest
  strategy.
- A shell subprocess could not read the same `$bunfs` path that the parent process read. The
  virtual filesystem is therefore insufficient for `bash`, external search tools, editors, native
  loaders, or any child process asked to inspect docs/source.
- Writing an embedded path failed. Embedded knowledge should be treated as immutable; any resource
  needing a writable or ordinary filesystem path must be extracted.
- A minimal arm64 macOS executable was about 63.1 MB. Embedding a 1,000,000-byte probe asset added
  about 988 KB regardless of compressibility, so precompressing a knowledge archive matters. The
  full current Ziggy compile probe was about 73 MB before a knowledge pack.

Bun source defines `$bunfs` as a virtual standalone-module prefix, and compile tests assert virtual
`import.meta` locations. Refs: Bun
[`src/StandaloneModuleGraph.zig:12-24`](https://github.com/oven-sh/bun/blob/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79/src/StandaloneModuleGraph.zig#L12-L24),
[`test/bundler/bundler_compile.test.ts:392-408`](https://github.com/oven-sh/bun/blob/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79/test/bundler/bundler_compile.test.ts#L392-L408).
Computed dynamic imports and extensions are another boundary: only statically linked modules are
hermetic, while opaque imports can require deployment-time `node_modules`. Refs: Bun linker
[`scanImportsAndExports.zig:142-153`](https://github.com/oven-sh/bun/blob/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79/src/bundler/linker_context/scanImportsAndExports.zig#L142-L153) and
[`scanImportsAndExports.zig:658-717`](https://github.com/oven-sh/bun/blob/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79/src/bundler/linker_context/scanImportsAndExports.zig#L658-L717).
Ziggy's repository-owned executable Pi extensions should therefore remain real sidecar files or be
extracted before Pi/Jiti loads them; merely embedding documentation does not solve executable
resource loading.

Other release constraints remain: build one tested artifact per OS/architecture/libc target; ship
matching native/WASM assets; code-sign macOS artifacts; and disable unintended standalone
`.env`/`bunfig.toml` autoload if deterministic startup is desired. Bun 1.3.13 disables runtime
`package.json`/`tsconfig.json` loading by default but leaves `.env` and `bunfig.toml` enabled unless
the build opts out. Ref: Bun docs
[lines 390-469](https://github.com/oven-sh/bun/blob/bf2e2cecf27e800962b1e7f03d66278f9d5d2e79/docs/bundler/executables.mdx#L390-L469).

## Option comparison

| Option | Alignment/reproducibility | Size | Offline and UX | Security/licensing | Upgrade maintenance |
|---|---|---|---|---|---|
| **Bundled sidecar source/docs** | High when executable and manifest are installed atomically under one release ID. Physical paths match Pi and Ziggy's existing discovery model. | Keeps binary smaller; total payload is visible and compresses well in the release archive. | Fully offline; ordinary read/search/bash/editor tools work; easiest for the agent to discover. | Files can be inspected and notices are visible. Must prevent or detect post-install tampering. | Version directories avoid mixed upgrades; installers must clean old versions only when no old process uses them. |
| **Executable-embedded assets plus lookup/extraction** | Strongest coupling: bytes and manifest travel in the same executable. | Enlarges every platform binary; raw embedding is near byte-for-byte, so use a deterministic compressed archive. | Offline. In-process lookup is good, but `$bunfs` is invisible to subprocesses; extraction adds first-run latency and cache state. | Embedded bytes are immutable. Extraction needs traversal checks, hashes, atomic publish, restrictive permissions, and license access. | Build-time file enumeration and extraction format become maintained product code; Bun-version behavior must be regression-tested. |
| **Package-manager source retention** | Good only for exact package/lock installs. Manager-specific global paths and deduplication are not a stable runtime API. | Largest option; a production tree was about 220 MB here. | Offline after install/cache; ordinary tools work. Requires Bun/Node/package-manager machinery and does not fit a bare executable download. | Retains package metadata and whatever notices publishers shipped; install scripts and a mutable dependency tree increase attack surface. | Package managers handle replacement, but Ziggy still needs a stable way to locate the exact tree and prevent version drift. |
| **Network lookup of exact versions** | Can be exact when keyed by package/version/SRI or VCS commit plus an expected archive hash. Never use `latest`, a branch, or an unverified tag. | Small initial artifact; bounded cache later. | Not offline; latency, proxies, credentials, registry/GitHub outages, and unpublishing can block discovery. | Verify SRI/signatures/provenance where available; fetched docs are untrusted reference input and fetched code must not execute. Licenses still apply. | Requires cache format, retry/error UX, source-repository mapping, and provider-specific maintenance. |
| **Hybrid fallback** | Strong for the shipped core and best effort beyond it. | Moderate and controllable. | Core questions work offline; optional deep dependency lookup improves online. Must say clearly which tier answered. | Keeps trust boundary narrow if only exact, verified artifacts enter a read-only cache. | More states to explain, but upgrades are manageable with content-addressed packs. |

Exact npm retrieval is viable for archival artifacts: `npm pack name@version` fetches a named
version, registry metadata provides `dist.integrity`, and npm records SHA-1 plus SHA-512 SRI. A
published name/version cannot later be reused, but a version can become unavailable through
unpublish, so release infrastructure should retain the exact tarballs it depends on rather than
assuming the public network is permanent. Refs: official npm
[`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack/),
[`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish/), and
[unpublish policy](https://docs.npmjs.com/policies/unpublish/).

## Recommended architectures

### 1. Versioned release bundle — recommended near-term

Define “distributed as an executable” as a release directory/archive, not necessarily one file:

```text
ziggy
photon_rs_bg.wasm                         # where Pi 0.82.0 can resolve it
share/ziggy/<ziggy-release>/manifest.json
share/ziggy/<ziggy-release>/ziggy/        # authoritative docs, production src/tests, skills, extensions
share/ziggy/<ziggy-release>/pi/0.82.0/    # README, docs, examples, types/source, package metadata
share/ziggy/<ziggy-release>/licenses/     # Ziggy and complete third-party notices
```

The executable should resolve this root from `process.execPath`, validate `manifest.json`, and pass
explicit physical paths into Ziggy resource discovery. Set/use `PI_PACKAGE_DIR` (or an equivalent
adapter-level path) for the namespaced Pi root so Pi's own system prompt advertises paths that
exist; do not put both Ziggy's and Pi's `README.md`/`docs/` at one ambiguous top level. Keep
executable extensions on this immutable physical shelf.

Provide both agent and operator affordances:

- a small read-only `knowledge_status`, `knowledge_search`, and `knowledge_read` surface with
  `ziggy`, `pi`, and `dependency` namespaces;
- `ziggy knowledge status|path|verify` for humans and diagnostics;
- every result labeled with component, exact version/release, logical path, and content hash;
- a short system-prompt catalog telling the agent that the surface exists, rather than hoping it
  guesses an installation path.

Build the sidecar and executable from one release manifest, install them atomically into a
versioned directory, and never replace a shared sidecar in place while a resident old Ziggy process
may still be running. This shape matches Pi's own tested binary layout, supports shell/editor
inspection, and requires the least new runtime machinery.

### 2. Single-file embedded pack with safe extraction — if one file is a hard requirement

At release time, generate a deterministic knowledge/resource manifest, package the approved files
and notices into a compressed archive, hash it, and import that archive explicitly with Bun's
`type: 'file'`. This avoids depending on Bun 1.3.13's directory workaround and avoids raw
byte-for-byte embedding of thousands of text files.

The in-process knowledge tool may read an embedded index directly for fast list/search/read.
Before Pi or Ziggy needs ordinary paths, atomically extract to a content-addressed location such as
`$XDG_CACHE_HOME/ziggy/assets/<release-hash>` (with platform-appropriate equivalents), then verify
all entries and configure the same physical paths used by architecture 1. Extraction must reject
absolute paths, `..`, links, duplicate/case-colliding names, oversized entries, and unexpected file
types; publish a completed cache only after every hash matches. Fetched or user-edited files must
never shadow this runtime shelf.

This gives a genuine offline one-file download while admitting the practical truth that dynamic
extensions, subprocess search, native assets, and Pi's current path APIs need real files. It costs
more binary size and substantially more lifecycle/security code than the release bundle.

### 3. Core pack plus package-manager/network fallback — recommended supplementary channel

Ship the Ziggy operational pack, Pi 0.82.0 docs/source representation, release manifest, lock
inventory, and notices in every artifact. Then resolve deeper dependency questions in this order:

1. exact files retained by an npm/Bun installation, if their package identity and integrity match
   the release manifest;
2. an existing content-addressed local cache;
3. with explicit network permission, the exact npm tarball from the lock and its recorded SRI;
4. only when the package publication lacks useful source, an exact VCS commit recorded at build
   time and verified against an expected archive hash;
5. otherwise report that source is unavailable, while still exposing package version, types,
   generated code, metadata, and license information.

A package-manager delivery channel can use a small launcher plus exact per-platform executable
packages, but package-manager retention should remain an optimization/fallback, not the sole
self-discovery contract. Cache exact Pi and dependency tarballs in release infrastructure because
public availability is not an offline guarantee.

## Security and trust model

- Treat the release manifest as the binding between executable behavior and knowledge. Record the
  Ziggy commit/tree hash, Bun version/revision/target, full lock hash, every package version/SRI,
  Pi source commit, knowledge archive hash, and license inventory.
- Keep operational files and cached references read-only. Never extract into a Profile, because
  Profiles contain mutable human-owned policy and must not become a runtime-code authority.
- Do not execute downloaded “source.” Network fallback is a documentation/source reader only.
  Executable Pi extensions must come from the signed/verified release pack or explicit existing
  extension installation policy.
- Treat third-party docs/source as untrusted content. Return bounded passages with provenance;
  never append an entire fetched document to the system prompt where it can act as hidden
  instructions.
- Sign platform release artifacts where supported and publish checksums. Verify npm SRI and registry
  signatures/provenance when present, while recognizing that provenance identifies origin and build
  process, not benign behavior.
- Keep old versioned packs available while old resident processes run. A new executable must never
  silently consume a different Pi or Ziggy knowledge pack.

## What should not be done

1. **Do not derive installed resources from `import.meta.dir`.** In a Bun executable it is a virtual
   module path, not the directory containing the downloaded executable.
2. **Do not assume bundling dependencies preserves inspectable source/docs.** It preserves executable
   module code; arbitrary publication files and unreferenced repository directories are excluded.
3. **Do not use latest online docs, a moving branch, or a tag alone** to explain an exact binary.
   Resolve exact package bytes/SRI or an exact commit plus expected hash.
4. **Do not make network availability the only way to understand Ziggy or its pinned Pi SDK.** Core
   self-discovery must work offline.
5. **Do not indiscriminately ship every transitive repository checkout.** It inflates releases,
   broadens licensing obligations, exposes irrelevant/test/secrets-prone material, and still does
   not guarantee that the code matches installed package bytes.
6. **Do not use embedded sourcemaps or binary string extraction as the user-facing API.** They are a
   debugging representation, not a stable catalog. Materialize an indexed source tree or provide a
   bounded lookup tool.
7. **Do not let extracted or fetched files shadow executable extensions or Profile policy.** Separate
   immutable runtime resources, read-only knowledge, network cache, and human-owned Profile state.
8. **Do not call an artifact “single-file and offline” if first use must download a knowledge pack.**
   An embedded pack may extract locally; a network-fetched pack is a different product promise.

## Open decisions

1. Is “executable” satisfied by a signed `.tar.gz`/`.zip`/installer containing one executable and
   sidecars, or is a literal one-file download a hard product requirement?
2. Which Ziggy files are authoritative operational knowledge? A sensible default is production
   source, focused tests, README/operator docs, resource manifests, skills, and current architecture
   decisions—not the whole working repository or every historical research note.
3. Should exact Pi source be materialized from published source maps, copied from the verified
   `v0.82.0` commit, or both? Published maps align to registry bytes; the Git tree is easier to read.
4. Is package-manager installation an official distribution channel, a developer convenience, or
   merely a source-cache fallback?
5. How much arbitrary dependency knowledge is promised offline: inventory/types only, selected
   high-value packages, or a larger curated source pack?
6. What network-consent policy should the agent use for exact artifact lookup, and where should the
   cache live under macOS/Linux/Windows conventions?
7. What signing/provenance standard and third-party-notice generation will gate releases?
8. How are old content-addressed packs garbage-collected without breaking running resident Ziggy
   processes or session reproducibility?

## Recommended decision

Adopt architecture 1 first, with architecture 3 as a bounded fallback. It preserves the existing
filesystem-oriented Ziggy/Pi contracts, matches Pi's own binary release precedent, gives the agent
ordinary searchable paths, keeps exact Ziggy and Pi knowledge offline, and leaves arbitrary
dependency source as an honest best-effort tier. Add architecture 2 only if product distribution
requires a literal one-file artifact; use the same manifest and logical knowledge namespaces so the
agent UX does not vary by install channel.
