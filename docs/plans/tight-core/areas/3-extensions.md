## Extensions: catalog, selection, admission, loading, update, and the agent-facing extension tool

**TL;DR.** Primitive 5 needs four things: decode `extensions.json`, resolve IDs to Profile or bundled folders, copy the files, and hand the paths to Pi. The code that does this is about 5.6k lines of src and 3.9k lines of tests, spread over roughly 20 files. More than half of it is machinery added after incidents:
- a full Pi preflight in a temp agentDir on every runtime open
- a prepare/activate split with a generation fence
- rollback journals for selection and automations
- two SQLite locks plus a runtime lease
- a GitHub catalog path that has no catalog entries

I recommend rebuilding it as one owner, `core/extensions.ts` (about 350–450 lines). It would keep one piece of policy that earned its place: skipping a broken optional package with a warning. The update and picker code moves into a separate `extension-manager` module that only faces use. I disagree with Fable on one point: the `profile_extensions` tool should stay in core, shrunk.

Effort: L for the core rebuild, M for the manager split, S to delete the GitHub path.

### 1. Files

Fan-in is direct src/test importers, from `scratchpad/fanin.txt`. Rows marked * were counted by grep because they are not in fanin.txt.

| File | Lines | Fan-in (src/test) | Role |
|---|---|---|---|
| /Users/yesh/code/personal/ziggy/src/application/profile-extensions.ts | 1272 | 2/5* | `ProfileExtensions` service: list/show/add/remove/setSelected/validate/prepareRuntime/activateRuntime, rollback, automation pause/provision |
| /Users/yesh/code/personal/ziggy/src/adapters/fs/profile-extensions.ts | 711 | 5/2 | Manifest schema, `readExtensionPackage` (re-parses the `pi` manifest), shelf scan, selection read/snapshot/restore/replace, generation hash |
| /Users/yesh/code/personal/ziggy/src/domain/profile-extension.ts | 195 | 19/13 | Listing types, 9-method `ProfileExtensionsApi`, Preflight/Lock services, Rollback/Preflight/Lock errors |
| /Users/yesh/code/personal/ziggy/src/domain/extension-catalog.ts | 93 | 10/6 | Catalog schema (bundled \| github union), catalog errors, unrelated `ZiggyUpdateUnavailable` |
| /Users/yesh/code/personal/ziggy/src/catalog.ts | 56 | 6/2 | Built-in catalog, `REQUIRED_BUNDLED_EXTENSION_IDS`, `BUNDLED_SKILLS` from generated metadata |
| /Users/yesh/code/personal/ziggy/src/adapters/pi/resources.ts | 150 | 5/3 | `composePiResources`: selected IDs to extension and skill paths, with embedded fallback for required packages |
| /Users/yesh/code/personal/ziggy/src/adapters/pi/profile-resource-loader.ts | 53 | 2/2 | Pi loader options (all `no*: true`), with a `skillsOverride` hack for `.embed` paths |
| /Users/yesh/code/personal/ziggy/src/adapters/pi/profile-core-inline-extensions.ts | 182 | 2/2 | Ziggy inline Pi extensions (memory prompt, etc.) |
| /Users/yesh/code/personal/ziggy/src/adapters/pi/profile-extension-preflight.ts | 314 | 6/4 | Full Pi build in `mkdtemp` agentDir, partition, rebuild; also `inspectPiPackageHealth` (a further load) |
| /Users/yesh/code/personal/ziggy/src/adapters/pi/profile-extension-diagnostics.ts | 223 | 3/2 | Pi diagnostics projection, own command-conflict check, realpath partition by package |
| /Users/yesh/code/personal/ziggy/src/adapters/pi/profile-extension-tool.ts | 798 | 1/1 | `profile_extensions` Pi tool (list/add/remove/validate) with bounded result projection |
| /Users/yesh/code/personal/ziggy/src/adapters/bun/profile-extension-lock.ts | 318 | 2/3 | Hardened SQLite `BEGIN IMMEDIATE` mutex (2 s timeout); exports `openProfileLockDatabase` |
| /Users/yesh/code/personal/ziggy/src/adapters/bun/profile-runtime-lock.ts | 85 | 3/1 | Reader lease vs `BEGIN EXCLUSIVE` update lock |
| /Users/yesh/code/personal/ziggy/src/adapters/pi/profile-runtime-lease.ts | 131 | 2/1 | Wraps every runtime open; refuses while an update journal is pending; patches `dispose` |
| /Users/yesh/code/personal/ziggy/src/application/extension-update.ts | 373 | 2/2* | `refreshRequiredExtensions`, `makeExtensionUpdate` (8 injectables, `--restart` orchestration) |
| /Users/yesh/code/personal/ziggy/src/adapters/fs/extension-update.ts | 469 | 4/2 | Receipts, journals, `hashTree`, recovery, `classifyBundledCopy` |
| /Users/yesh/code/personal/ziggy/src/domain/extension-update.ts | 31 | 2/0 | Update error/receipt types |
| /Users/yesh/code/personal/ziggy/src/adapters/fs/extension-installer.ts | 611 | 3/0 | `publishEmbeddedTree`, `publishSource`, GitHub install, `systemTarExtractor` |
| /Users/yesh/code/personal/ziggy/src/adapters/github/extension-catalog.ts | 62 | 4/4 | `ExtensionArchiveClient` HTTP download (dead: no github catalog entries) |
| /Users/yesh/code/personal/ziggy/src/application/extension-manager.ts | 115 | 3/1* | Interactive picker to `setSelected` |
| /Users/yesh/code/personal/ziggy/src/adapters/terminal/extension-manager-interaction.ts | 87 | 1/0* | Terminal prompt for the picker |
| /Users/yesh/code/personal/ziggy/src/faces/extensions-cli.ts | 517 | 1/1* | CLI renderers (consumer) |
| /Users/yesh/code/personal/ziggy/src/adapters/pi/doctor-checks.ts (≈240–290) | 402 | 1/1* | `resourcesCheck`: package health load + `validate` (preflight) + `classifyBundledCopy` |

### 2. What this area is for

Spec primitive 5 (`/Users/yesh/code/personal/ziggy/docs/research/minimal-ziggy-scout.md:81`, recipe step 4 at :28, CLI at :66–70) requires the following:
- A Profile names extensions in `extensions.json`. Missing, invalid or unapproved IDs fail closed.
- Approval comes from generated catalog metadata. A package on the Profile's own shelf with the same ID wins.
- The three required bundled packages (`pi-packages`, `extension-authoring`, `ziggy-operations`) are always present.
- Packages load from Profile folders.
- Selection writes are atomic, and a selection applies only to newly opened runtimes.
- `extensions update <profile> <id> [--adopt]` replaces a stopped Profile's managed bundled copy.

What must hold for the owner:
- Choosing a package is one file write.
- Opening a runtime loads exactly the approved set.
- A broken package is visible, never silent.

### 3. How it got this shape / the mistakes

Timeline:
- **07755dc6 (2026-08-11): catalog and curator.** The GitHub entry type was added here. `catalog.json` has 21 entries, all `"source": "bundled"`, so the GitHub branch never ran. `docs/research/extension-compat.md` explicitly says "no ... remote fetcher", and the code contradicts that.
- **b7fcb01f (08-15): copy selected packages onto the Profile.** Legitimate: helper scripts resolve paths via `import.meta.dirname` and need real files.
- **a5431050 (08-16): transactional lifecycle, SQLite mutex, rollback (LOG:405).** This responded to the Squarey computer-use incident in `docs/plans/profile-extension-lifecycle.md`, which had four real defects. Slices 1–3 shipped. Slice 4 shipped as catalog-pinned GitHub entries instead of URL import, and nothing uses it. Slice 5 (generation rollover) was never built, so restart is still required (LOG:122). Even so, the prepare/activate generation fence meant for it exists (`application/profile-extensions.ts:1164–1246`).
- **LOG:407: the `profile_extensions` tool.** Legitimate. Incident defect 3: Slack under launchd has no `ziggy` on PATH, so the agent could not run the CLI.
- **b18753bf (09-17): bundled update.** Then the 09-28 cluster:
  - 71953667: stage and restart around a locked apply
  - 2fa499d7: journal recovery
  - bf438483: refresh required packages by content hash
  - 00372189: quarantine only selected packages
  - 761b46c6 and a3af06cb: pause quarantined or orphaned automations

  LOG:129 records a real owner decision: "skip broken extension packages and warn loudly". LOG:132 admits a leftover: extension factories load more than once under quarantine.
- **LOG 2026-09-28 "Plan: extensions run without the resident"** made the resident optional. That is why `profile-runtime-lease.ts` and the reader/update lock exist: `extensions update` must not swap folders under a live `ziggy run`. The motivation is real. The mechanism is heavy.

Recurring mistake patterns:
1. **Incident, then a new mechanism, never a subtraction.** Each defect added a module (preflight, lock, journal, lease, quarantine pause) rather than questioning the step before it. Example: required packages are skills-only and already have an embedded fallback (`resources.ts:114–120`). They were copied anyway, and that copying created receipts, `refreshRequiredExtensions` (`main.ts:708`) and the doctor's `classifyBundledCopy`.
2. **Duplicating Pi.** `readExtensionPackage` re-parses the `pi` manifest that Pi parses again, because Ziggy passes the package directory (`resources.ts:124`). The diagnostics module re-implements conflict detection.
3. **Validation run at every layer.** A single runtime open loads extension modules up to four times:
   - preflight (`profile-extension-preflight.ts`)
   - the preflight's quarantine rebuild
   - the real build (`pi-agent.ts:415–675`)
   - the real build's rebuild

   `list` in the tool and doctor each add another load (`inspectPiPackageHealth`, `profile-extension-preflight.ts:231–295`).
4. **Locks held across slow work.** `prepareRuntime` holds the 2 s SQLite mutex while running a full Pi preflight (`application/profile-extensions.ts:1164–1186`). This is a plausible contention failure for a second opener.
5. **Speculative generality.** The GitHub catalog, archive client and tar extractor are about 700 lines with zero production entries. `ProfileExtensionKind` includes `"remote"`.

### 4. Reach today

**Task A: change the `extensions.json` format** (for example, add per-package config):
- `adapters/fs/profile-extensions.ts`: selection schema at :25, reserved/duplicate checks at :439–455, replace/snapshot/restore, generation at :573
- `application/profile-extensions.ts:243–270`: duplicate decode and reserved checks
- `domain/profile-extension.ts:9`: `ProfileExtensionId`
- the ID schema in the `adapters/fs/extension-update.ts` store
- `profile-extension-tool.ts`: TypeBox ID schema
- `application/extension-manager.ts` (`setSelected`)

That is 6 src files plus about 4 test files: `profile-extensions.test.ts`, `fs/profile-extensions.test.ts`, `extension-manager.test.ts` and `profile-extension-tool.test.ts`. **About 10 files.**

**Task B: add a new required bundled package:**
- `catalog.json` plus the generated metadata `required` flag. I did not verify where the generator sets it.
- The package's skills embedding (`BUNDLED_SKILLS`).
- The spec's list of required IDs (`minimal-ziggy-scout.md:28`).

The code paths react automatically, but each has to be understood: `refreshRequiredExtensions`, the doctor's `classifyBundledCopy`, `materializationIds` (`application/profile-extensions.ts:820`), the embedded fallback in `resources.ts` and the `.embed` skill-override hack. **3 data/docs edits, with about 5 code paths that must be read to be sure.**

**Task C: change how a broken optional package is handled:**
- `profile-extension-diagnostics.ts` (partition)
- `profile-extension-preflight.ts` (rebuild)
- `pi-agent.ts:415–675` (rebuild, `skippedPackages`, automation message)
- `application/profile-extensions.ts` (quarantine pause at ≈229–619, `activateRuntime`)
- `domain/profile-extension.ts` (errors)
- `profile-extension-tool.ts` (stage/code map)
- `ui-gateway/management-extensions.ts` (health)

Plus tests: `profile-extensions.test.ts:509` (currently failing per the audit), preflight, diagnostics and `pi-agent.test`. **About 11 files.**

Contracts that leak outward:
- `ProfileExtensionsApi` and its error union (`domain/profile-extension.ts:118–195`) are imported by 19 src files, including:
  - `resident-gateway.ts:341`
  - `ui-gateway/types.ts`
  - `ui-gateway/management-extensions.ts`
  - `doctor.ts`
  - `profile-runtime-lock.ts`
  - `profile-runtime-lease.ts`
- 13 test files import the same contracts.
- `ExtensionHealth` is wired at `composition.ts:99`.
- `main.ts:324` reaches into `readSelectedExtensionPackage` directly.

### 5. What Pi already provides

All paths are under `/Users/yesh/code/personal/ziggy/node_modules/@earendil-works/pi-coding-agent/dist/core/`.

| Pi capability | Location | Ziggy today | Verdict |
|---|---|---|---|
| Loader options: `additionalExtensionPaths`, `additionalSkillPaths`, `extensionFactories`, `no*`, `*Override` | `resource-loader.d.ts:70–121` | Used correctly in `profile-resource-loader.ts` | Keep |
| A package directory as an extension path resolves via `resolveExtensionSources` → `collectPackageResources`, which reads the `pi` manifest (extensions and skills) | `resource-loader.js:363–420`; `package-manager.js:1067–1090`, `1848–1880` | `readExtensionPackage` (`fs/profile-extensions.ts`) parses the manifest again | Duplicate. Keep only the escape/symlink policy, `ziggy.automations`, and description/kind for listings |
| Missing extension/skill paths reported as errors and diagnostics | `resource-loader.js:363–420` | Also checked by Ziggy before load | Partly duplicate |
| Per-extension error isolation: a failed module goes to `errors` and the rest still load | `extensions/loader.js:533–557` | Preflight plus rebuild to drop the broken package | The rebuild is needed only to drop the broken package's *skills* too. Otherwise Pi already isolates it |
| Conflict diagnostics for tools and flags (everything stays loaded) | `resource-loader.js:544–585`, `965–1002` | Own command-conflict detection in `profile-extension-diagnostics.ts` | Genuine but small addition, since Pi misses command conflicts |
| `session.reload()` re-runs `_resourceLoader.reload()` with the options fixed at construction | `agent-session.d.ts:725`; `agent-session.js` ~2875 | Not used; restart required | Consistent with spec (new runtimes only) |
| `getExtensions().errors` | resource loader | Consumed through partition | Keep as the single source of truth |

Genuine Ziggy policy that Pi does not provide:
- catalog approval
- Profile-shelf precedence
- required packages
- the copy-to-Profile step
- the path-escape policy
- the `ziggy.automations` manifest key (only `extensions/self-improvement` uses it)

### 6. Target shape

There are two modules.

**`src/core/extensions.ts`** (about 350–450 lines, one owner, one lock-free atomic write):

```ts
// selection file: decode + atomic write (temp + rename), byte-exact restore on failed add
readSelection(profile): Effect<ReadonlyArray<ExtensionId>, ProfileExtensionInvalid>
// ID -> Profile shelf, else approved bundled; required IDs always included (embedded, never copied)
resolve(profile, ids): Effect<ReadonlyArray<ResolvedPackage>, ProfileExtensionInvalid | Unapproved>
// the single function the runtime uses
loaderOptions(profile): Effect<{ options: ResourceLoaderOptions; packages: ResolvedPackage[] }, ...>
// after Pi builds services once: attribute errors to optional packages by root;
// if any, rebuild once without them and return warnings (LOG:129 decision)
admitDiagnostics(loaded, packages): { skipped: ReadonlyArray<{ id; message }> } | fatal error
add(target, id) / remove(target, id): copy (if bundled/optional), one real-Pi check of the candidate set, write selection
list(profile?): listing from generated metadata + shelf
```

What it no longer does:
- preflight on runtime open
- the prepare/activate split and generation fence
- a rollback journal (the only rollback is restoring selection bytes on a failed `add`)
- the SQLite mutex
- the GitHub path
- copying required packages
- health double-loads

Automation provisioning for `ziggy.automations` becomes a single step after a successful `add` or `remove`. It is idempotent and reconciles automations tagged with owner `extension:<id>` against the currently selected set. It is not a journal.

**`src/application/extension-manager.ts`** (only faces use it):
- the `update`/`--adopt`/`--restart` flow for **optional** bundled copies
- the interactive picker
- doctor copy classification

`update` refuses while the gateway owner reports the resident is live. It copies into `<id>.new` and then renames. This replaces the receipts journal, the recovery code and the runtime lease.

Face shim: keep the exported name `ProfileExtensionsApi` for `list/show/listForProfile/add/remove/setSelected/validate`, where `validate` means "build loader options and load once". `extensions-cli.ts` and `ui-gateway/management-extensions.ts` then compile unchanged. Drop `prepareRuntime`/`activateRuntime` from the API; `pi-agent.ts` calls `loaderOptions` and `admitDiagnostics` directly.

Reach afterwards:

| Task | After |
|---|---|
| A: change `extensions.json` format | `core/extensions.ts` plus its test, and the tool's input schema only if the ID shape changes. **2–3 files** |
| B: add a required bundled package | `catalog.json` flag plus the spec line. No copy, refresh or receipt paths react. **2 files** |
| C: change broken-package handling | `admitDiagnostics` plus one e2e test. **2 files** |

### 7. Keep / rebuild / delete

| File | Action | Reason |
|---|---|---|
| src/application/profile-extensions.ts | Rebuild → `core/extensions.ts` | 1272 lines of lock/rollback/generation around a decode-resolve-write job |
| src/adapters/fs/profile-extensions.ts | Rebuild (fold into core) | Keep atomic write, O_NOFOLLOW, byte restore and escape checks; drop the manifest re-parse and the duplicated reserved checks (:439–455) |
| src/domain/profile-extension.ts | Rebuild | Keep ID, listing types and `Invalid`/`Unapproved`/`LoadFailed`; delete `RollbackFailed`, `LockFailed`, `RuntimePreparation`, the Preflight/Lock services, `"remote"` kind |
| src/domain/extension-catalog.ts | Rebuild (shrink) | Drop the github union member and archive errors; move `ZiggyUpdateUnavailable` to its owner |
| src/catalog.ts | Keep | Pure generated-metadata decode |
| src/adapters/pi/resources.ts | Rebuild (fold into core) | Its composition logic is the core; `discoverPiResources` goes with it |
| src/adapters/pi/profile-resource-loader.ts | Keep | Correct Pi idiom. The `.embed` skill-override hack stays only while embedded skills use that suffix |
| src/adapters/pi/profile-core-inline-extensions.ts | Keep | Right Pi idiom |
| src/adapters/pi/profile-extension-preflight.ts | Delete | Replaced by one real load in `add` and `admitDiagnostics` at open |
| src/adapters/pi/profile-extension-diagnostics.ts | Rebuild (≈80 lines in core) | Keep partition by package root and command-conflict check; drop the bounded-projection layers |
| src/adapters/pi/profile-extension-tool.ts | Rebuild (≈150 lines, core) | Keep list/add/remove; throw on error per Pi convention; drop aliases (:794–798) and the health double-load |
| src/adapters/bun/profile-extension-lock.ts | Delete | The atomic rename of `extensions.json` is sufficient |
| src/adapters/bun/profile-runtime-lock.ts | Delete | Replaced by the gateway-owner check plus stage-and-rename in `update` |
| src/adapters/pi/profile-runtime-lease.ts | Delete | Same; the residual race with a concurrent `ziggy run` is accepted (decision 2) |
| src/application/extension-update.ts | Rebuild → `extension-manager.ts` | Keep adopt/modified checks and stopped-Profile replace; drop the 8 injectables and the resident orchestration matrix |
| src/adapters/fs/extension-update.ts | Rebuild (shrink) | Keep `hashTree` for adopt/modified detection; delete journals, recovery and required receipts |
| src/domain/extension-update.ts | Keep, merge | Small; fold into the manager |
| src/adapters/fs/extension-installer.ts | Rebuild (shrink) | Keep `publishEmbeddedTree`; delete `installGitHub`, `publishSource`'s remote branch and `systemTarExtractor` |
| src/adapters/github/extension-catalog.ts | Delete | Zero github entries; contradicts `extension-compat.md` |
| src/application/extension-manager.ts + src/adapters/terminal/extension-manager-interaction.ts | Keep, move under the manager | Face-only picker |
| src/faces/extensions-cli.ts | Keep (consumer) | Compiles through the shim; remove `main.ts:324`'s direct fs reach |
| src/adapters/pi/doctor-checks.ts (extension part) | Rebuild | Doctor runs `loaderOptions` plus one load and reports skipped/fatal; drop `classifyBundledCopy` for required packages |

### 8. Tests

**KEEP** (real invariants; re-point them at the new owner):
- `test/adapters/pi/resources.test.ts:451`: the full bundled catalog copies and loads through real Pi.
- `test/adapters/pi/resources.test.ts:287`: the upstream package name is independent of the shelf ID (the Squarey regression).
- The `resources.test.ts` case where a Profile-owned package wins a collision.
- `test/application/profile-extensions.test.ts:283`, `:339`, `:774`: selection bytes preserved, atomic write, absent-file restore.
- Fail-closed cases in `profile-extensions.test.ts` for unapproved, missing and invalid IDs.
- The tool test that runs with an empty PATH, the reason the tool exists.
- `test/adapters/pi/profile-core-inline-extensions.test.ts` (70 lines).
- `test/adapters/fs/profile-extensions.test.ts`: symlink/escape rejection cases only.

**DELETE:**
- `test/adapters/bun/profile-extension-lock.test.ts` (308 lines; lock hardening permutations at :37–160).
- `test/adapters/bun/profile-runtime-lock.test.ts` (221 lines).
- `test/adapters/pi/profile-extension-preflight.test.ts` (423 lines; tests removed machinery).
- `test/application/profile-extensions.test.ts:653–774`: multi-package rollback permutations.
- `test/application/profile-extensions.test.ts:509`: the audit reports it currently failing on a model-selection mismatch; it tests quarantine through fakes.
- `test/application/extension-update.test.ts:213–346`: resident orchestration permutations over a no-op `withLock: (_path, use) => use`, a stub archive and stub residents.
- `test/application/required-extension-refresh.test.ts` (63 lines; the feature is removed).
- `test/application/extension-manager.test.ts` (113 lines; picker trivia over fakes).
- `test/faces/extensions-cli.test.ts`: rendering-string trivia. Keep at most one snapshot per command.
- `test/adapters/pi/profile-extension-diagnostics.test.ts`: fold its partition cases into the e2e below.
- The `pi-agent.test.ts` rollback and lease-release branches, as the audit cites at `:1098`.

**End-to-end proofs needed** (real tmp Profile and real Pi with a scripted `openai-completions` fixture provider; this matches Fable's `fixtureProvider`/`tmpProfile`):
1. An `extensions.json` with an unapproved ID fails the open with a typed error. A missing file means the required packages only.
2. `add` of a package whose extension throws at import is rejected, and the selection bytes are unchanged.
3. A selected optional package broken on disk after admission: the open succeeds, the package's tools and skills are absent, the warning is returned, and the doctor reports it.
4. `add` a package with a tool, then open a new runtime: a scripted turn calls the tool and it runs.
5. A Profile-owned package with the same ID as a bundled one: its skill text appears in the request system prompt.
6. `extensions update <p> <id>` against a stopped Profile replaces the copy. With a live gateway owner it refuses. `--adopt` on a modified copy works.
7. `profile_extensions` add via a scripted tool call with `PATH=""` succeeds and the selection file changes.

### 9. Decisions for the owner

1. **Keep "skip broken optional package, warn loudly" (LOG:129) or go fully fail-closed?**
   - Fable's position: fail closed (`tight-core-fable-review.md:188`), which is simpler.
   - Against that: LOG:129 was an explicit owner call after a real outage mode, where one bad optional package took down Slack.
   - **Recommend keeping it** as about 80 lines (`admitDiagnostics`: partition by root, rebuild once). This is a single rebuild instead of today's four loads. Drop the quarantine automation-pause journal. Instead, `self-improvement-curator` provisioning checks at schedule time whether its owner package loaded.
2. **Required packages: embedded-only, or copied?**
   - For embedded-only: all three are skills-only (`pi.skills: ["./skills"]`), and the embedded fallback already works (`resources.ts:114–120`).
   - Against: b7fcb01f's reason for copying (real files for `import.meta.dirname`) applies only to code packages. The embedded path currently needs the `.embed` skill-override hack.
   - **Recommend embedded-only**, which deletes required refresh, required receipts and doctor classification. If the `.embed` hack proves fragile, materialize the required packages into a Ziggy cache directory once per Ziggy version rather than into each Profile.
3. **Does `extensions update` need to be safe against a concurrent `ziggy run`?**
   - This is what the 09-28 "extensions run without the resident" plan bought with the runtime lease.
   - **Recommend** a stage-and-rename update that refuses only when the gateway owner is live. The residual race is that a `ziggy run` started mid-rename sees either the old or the new directory. Pi reads the files at load time, so the result is at worst a load error, which becomes a warning under decision 1. That is acceptable for a manual command.
   - If the owner rejects this, keep one `flock` on `<profile>/.runtime/update.lock` (about 40 lines), not two SQLite databases.
4. **The GitHub catalog.**
   - It has zero entries, and `extension-compat.md` says no remote fetcher.
   - **Recommend deleting it now** (S). If remote packages come back, they re-enter as a Profile-shelf copy made by a face command.

### 10. Where I disagree with the Fable review or the audit

- **Fable: "the `profile-extension-tool` becomes a bundled package that shells out to `ziggy extensions add/remove`" (`tight-core-fable-review.md:47`, `:120`, `:189`).** I disagree. The tool exists because of incident defect 3: under launchd Slack there is no `ziggy` on PATH (LOG:407, `profile-extension-lifecycle.md`). Shelling out brings that defect back. The tool needs in-process access to the core owner. Keep it in core, shrunk from 798 to about 150 lines.
- **Fable: "no ... quarantine" and fail closed at open (`:119`, `:188`).** I partly disagree. It skips the owner's LOG:129 decision, although Fable does name the 80-line opt-in. I recommend that opt-in as the default (decision 1).
- **Fable: delete the runtime lease and lock (`:41`, `:112`).** I agree on deletion, but Fable misses why they exist. The LOG 2026-09-28 "extensions run without the resident" plan made a resident-free `ziggy run` a supported concurrent reader, so "update refuses if the resident is running" alone does not cover it. The replacement must be argued as "stage-and-rename makes the race benign" (decision 3), not "no concurrent reader exists".
- **Fable keeps `domain/extension-catalog.ts` as-is (`:96`).** I disagree. It carries the dead github union and an unrelated `ZiggyUpdateUnavailable`, so shrink it.
- **Fable does not address required-package copying, receipts or refresh.** The biggest reach reduction for task B comes from not copying required packages at all. Neither review raises it.
- **Audit: "extension selection, ... generation binding, optional quarantine and exact rollback are necessary policy" (`tight-core-alignment-audit.md:225`).** I disagree on generation binding and exact multi-package rollback:
  - The generation fence exists only because prepare and activate were split for slice 5, which was never built.
  - Rollback breadth serves automations of exactly one package.

  Quarantine I keep, but simplified.
- **Audit A08 (`:120–128`): make preflight loader invalidation robust.** This is moot, because preflight is deleted.
- **Audit ratings "Retain" for `profile-extension-lock.ts` (`:285`), `application/profile-extensions.ts` (`:284`) and `profile-extension-tool.ts` (`:273`).** I disagree on all three, per section 7. The audit's scope excluded "installers/update internals" (`:15`), which is where much of the reach lives.
- **Audit fixture finding at `profile-extensions.test.ts:509`.** I agree it is a contract mismatch, but it tests quarantine through a fake runtime. Delete it and replace it with e2e proof 3 rather than repairing the fixture.

I did not verify where the catalog generator sets the `required` flag (task B), or which fakes each remaining test uses beyond those cited.