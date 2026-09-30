**Verdict:** the plan is right about most of the ceremony it removes. It is wrong on four points: D1 as written, embedded-only required packages, dropping the extension-selection lock, and moving session listing onto `parseSessionEntries` with no cache. It also loses three interleaving tests that the e2e proofs cannot reproduce.

## 1. D1 writer lease shrink — the plan loses the lease on real sessions

- **Fresh ids are only safe until their first turn.**
  - Pi's `newSession`/`fork` create the new file in the same directory (`agent-session-runtime.js:153-158, 202-205`).
  - `run -c` continues the most recent file in `sessions/local/main` (`pi-agent.ts:273-282`, via `continueRecent` at `session-manager.js:1354`).
  - So: web `/new`, chat once, then `ziggy run -c`. The CLI continues the fresh file, which under D1(c) has no lease. That gives two writers with different in-memory leaves, so the transcript branches silently.
  - Today `a4946ad2` moves the lease onto the new id, so `run -c` is refused. P5 only checks the original main file, so it would pass while this breaks.
  - The same hole exists for `run --session <id>` against a live ACP session, an automation session or a Slack-thread session.
- **`withFileLock` is the wrong shape.** Memory needs a short critical section. A session needs a lease held for the whole life of the handle (LOG.md:1111: "hold it for the handle's lifetime"). A lock taken only at open does nothing against a resident handle that lives for hours.
- **"No transitions" contradicts "lock before `switchSession`".**
  - A lease held for the handle's lifetime must release the old id when it switches. If it doesn't, the old lease leaks.
  - Worse, resuming back to that old id opens a new SQLite connection (`session-lease.ts:90`) and gets `SQLITE_BUSY` against its own process.
  - Some transfer logic is the minimum. What can go is the reservation, cancel, pending-release and poison state machine (`session-lease.ts:217-322`).
- **Dropping `.owner` breaks P5.** P5 requires the refusal to name the holder's pid (LOG.md:1146 "CLI session refusals name the holding process"). When the holder is ACP or `run` rather than the resident, `.owner` is the only place that pid exists. The picker's "held" state (`e9191de3`, LOG.md:1135) is also wrong for any session on a fresh id that another process holds.
- **Crash safety:** it holds only if the helper stays on SQLite `BEGIN IMMEDIATE`, where the lock dies with the process. A generic lockfile brings back stale-lock recovery, which was already rejected once (LOG.md:50 → :60).
- **Keep:** a lease of about 100 lines: `acquire` (scoped), `isHeld`, and `.owner`. The handle holds one current lease.
  - On switch: acquire the target, run Pi's switch, then release the old lease.
  - On new/fork: acquire the new id after rebind, then release the old one.
  - No reservation, no poison, no `pendingReleases`.
- **Plan holds for:**
  - leases on specialist children and `runSpecialist` roots;
  - the poison flag;
  - the 10 lease-only `runPromise` bridges;
  - the package-lock stacking in `pi-agent.ts:1319/1480`.

## 2. Registry Opening/Closing fence — plan holds, but only after amending D1

The fence can go only if every live handle holds the lease from before Pi loads the transcript until dispose finishes. That must include ids created by `/new` and `/fork`. Under D1(c) as written, a stored append to such a session while its handle is opening or closing writes concurrently with it.

There is also an existing race that P9 does not cover:
- Resume does not take `statePermit` (`ui-gateway/sessions.ts:496-505`).
- So delivery can find handle H on session X, H then resumes elsewhere, and the live append fails as `destination-missing` with `retriable: false` (`pi-agent.ts:945-950`).
- Fix: map that case to retriable, or fall through to the stored append.

## 3. Extensions

- **Preflight, the runtime lease and the GitHub path:** plan holds.
- **Embedded-only required packages: the plan loses the operations skill's reference files.**
  - `ziggy-operations/SKILL.md:14-23` links to nine `references/*.md` files by relative path.
  - The embeds are flattened to `fileNNN.embed` (`src/generated/builtin-files.ts:357-366`; LOG.md:291 notes that `$bunfs` flattens to hashed names and that `copyFileSync` can't read it).
  - So those relative links cannot resolve from the embedded skill, in source mode or compiled. Making real files available for relative paths is `b7fcb01f`'s reason for copying.
  - **Keep:** materialize required packages once per Ziggy version into a cache directory. This is the area's own fallback; make it the primary path. It still deletes per-Profile receipts, refresh and doctor copy classification, plus the `.embed` override hack.
- **Both SQLite locks: the plan loses concurrent-edit safety for `extensions.json`.**
  - Selection is edited from separate processes: the in-process `profile_extensions` tool inside the resident (LOG:407), the web picker, and CLI `extensions add`.
  - A "lock-free atomic write" is last-writer-wins. Automation provisioning races the same way.
  - **Keep:** the shared lock helper around `add`/`remove` only, not around opens or preflight.
- **Rollback journals: the plan loses crash safety on update.**
  - `rename(2)` cannot replace a non-empty directory, so "copy to `<id>.new`, then rename" is really two renames.
  - A crash between them leaves `<id>` missing. `resources.ts:100-103` then fails every open with `missingSelected`.
  - **Keep:** about 10 lines of recovery. If `<id>` is absent and `<id>.old` exists, restore it. Add that crash case to P13.

## 4. Memory

- **Symlink parent-directory walks:** plan holds. Channel faces run with full tools, including `bash`; the only tool restriction in `src` is on specialists (`specialist.ts:330-340`).
- **Backups → single `.prev`:** mostly holds. The caveat is that `memory_write` is reachable from untrusted Slack, Discord and Telegram groups. Two bad writes, for example after a prompt injection, cannot be undone from one `.prev`. Cheap middle ground: keep N plain copies (one `writeFile` each, prune by count, no hardlinks), and update `docs/operations/memory.md:47`.

## 5. History cursor, sessions cache, choreography tests

- **sha256 cursor: plan holds, and the change is a fix.** The digest covers the whole file, so any append to a live session makes older cursors stale (`session-history.ts:246, :274`). Store the entry id at the cursor index rather than only a size guard.
- **mtime cache and the `parseSessionEntries` rebuild: plan loses, and the need is measured.**
  - Squarey has 316 transcripts totalling 1.1 GB. The largest, a Slack thread, is 376 MB.
  - `parseSessionEntries(content)` needs the whole file as one string and silently skips malformed lines (`session-manager.js:91-99`). That undoes the streaming read added in `747ccbe2`, and it contradicts "strict show" (D10).
  - **Keep:** the streaming line scan (`scanTranscriptLines`) plus the cache, or bounded head/tail reads. Borrow Pi's entry types for decoding only.
- **Choreography tests: P8 cannot replace them.**
  - `ui-gateway.test.ts:2046, :2131, :2189` pin three windows: during a resume, interrupting a resume, and a prompt arriving during a resume. A real resume makes no provider call, so the fixture provider cannot hold it open, and no socket drop lands deterministically inside it.
  - The area's proof "a prompt during resume fails with `SessionBusy`" (area 1 §8, e2e proof 3) contradicts `:2189` and `6d5d5c12`, which queue the prompt until after the reset. That is an unannounced change to a face contract.
  - **Keep:** all three tests, pointed at `chat-handle.ts` with a blocking fake runtime, since that is where the ordering will live.

## 6. Harness viability

- **The 10 s budget is plausible.**
  - In-process real Pi is cheap: `pi-agent.test.ts`, 27 tests in 0.73 s (measured).
  - A CLI subprocess cold start is about 0.27 s (measured on `help`). Around 40 subprocesses spread across parallel files fits on this 12-core machine.
- **Deterministic only for turn-shaped races.** Gating the SSE stream holds a turn open, which covers P6 (drop mid-turn) and P9 (live busy).
- **Not deterministic for** the open, resume, dispose and lease-acquire windows. P17's two-process race is probabilistic: a useful smoke test, not a proof.
- **Not testable:** P13 `--restart`, because it needs a launchd-managed resident.

## Where the plan is right and the current design can't be defended

- Removing reservations and poison from the lease; removing leases on specialists and children.
- Keeping only three serialization layers instead of eight; dropping the gateway `WeakMap` semaphore and `resetTranscript`.
- Removing the four-way extension loads, preflight on every open, and the 2 s mutex held across it.
- Removing the generation fence and the GitHub catalog.
- A single agent-policy validator; the bug fixes (A02, A05, ACP `set_model`, `profile_extensions` passing agent validation).
- The sha256 cursor, and dropping memory symlink walks.
- Required `ChatHandle` members, and one shared test fake.

## Amendments to the plan

1. Rewrite D1(c) as a lease held for the handle's lifetime, kept separate from the critical-section `withFileLock` even though both use the same SQLite primitive. Lease every handle id, including ids after `/new` and `/fork`. Keep minimal transfer logic and `.owner`.
2. Add a proof: web `/new` plus one turn, then `run -c` is refused and names the pid. Add another: `run --session <live ACP id>` is refused.
3. Required packages: materialize per Ziggy version into a cache directory, not embedded-only. Add a proof that the model can read `ziggy-operations/references/*.md`.
4. Keep the shared lock around extension `add`/`remove`. Add `.old` recovery to update and a crash case to P13.
5. `Sessions` stays streaming; keep the cache, or a bounded summary read, given Squarey's 376 MB transcript. Keep `show` strict.
6. Keep `ui-gateway.test.ts:2046, :2131, :2189` as handle-level tests. Decide explicitly whether a prompt during resume queues or fails with `SessionBusy`.
7. Make a live-append session-id mismatch retriable (`pi-agent.ts:945-950`).
8. Memory: keep N plain backups or document git; not a single `.prev` alone.

Nothing was edited. The only checks I ran were the measurements above: the CLI start time, the `pi-agent.test.ts` run, and file sizes under `~/.ziggy/profiles/squarey/sessions`.