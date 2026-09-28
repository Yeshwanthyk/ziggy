# Core review

A section-by-section tightening pass over the core, based on the 2026-09-28 review. That review used
Luna-high scouts for structure, Effect, stateful and property/fuzz lenses, plus a live run with a
Codex OAuth test Profile. Findings and evidence are on the review page, and the raw scout reports
stay out of the tree.

Each section lands as its own commit with `bun run check`, focused tests only for real invariants,
and a `LOG.md` entry. Update the status line here as each section closes.

Out of scope: `extensions/computer-use`. It will be replaced by `../pi-computer-use`.

## Workstreams

Parallel sessions split the work by file ownership. Each stream works in `../ziggy-<stream>` on
branch `review/<stream>`, cut from main.

Every stream applies all the review lenses to the files it owns:

- structure review;
- Effect idioms, checked against `vendor/effect`;
- stateful lifecycle;
- property and fuzz tests with `fast-check`, only where there's a real invariant;
- test pruning.

Only the integrator session edits `LOG.md`, this file, `package.json` and `bun.lock`. A stream
returns its log entry and status lines in its final message. Streams rebase on main before handing
back, and the integrator merges one stream at a time with `bun run check`.

| Stream | Sections | Owns | Starts |
| --- | --- | --- | --- |
| `tui` | 1b | TUI files in `src/adapters/pi/`, the `openTui` path in `pi-agent.ts`, the `Tui` path in `main.ts`, the spec | now |
| `ui` | 1 (command cache), 8 | `src/application/ui-gateway.ts`, `management.ts`, the UI server and web UI | now |
| `chat` | 1 (Slack health), 7 | Slack and Discord gateways, `domain/*-health.ts` | now |
| `auto` | 1 (fingerprint), 6 | automations application and domain code | now |
| `ext` | 2, 5 (authoring), 11b | `extensions/codemode`, preloaded skills, `pi_docs` | now |
| `adapter` | 4, 5 (diagnostics), 9, 11a | the rest of `src/adapters/pi/`, the runtime interface, resident service | after `tui` |
| `cli` | 3, 10 | domain setup, `src/faces/cli`, the CLI parts of `main.ts` | after `tui` |

## 0. Pi 0.87.1 upgrade

Status: done; on main (d5bb377).

- Brings the GPT-6 catalog (`gpt-6-luna`, `gpt-6-astra`). Handles the breaking changes
  (`NormalizedBuildSystemPromptOptions`, typebox 1.3.27).

## 1. Correctness fixes

Status: pending.

- UI gateway command cache (`src/application/ui-gateway.ts:1531`). A defect in `run` never completes
  the `Deferred`, so retries hang. The whole run is uninterruptible, and FIFO eviction can drop
  in-flight slots.
- Slack health: a cancelled queued turn never decrements `queuedTurnCount`. Discord does it
  correctly.
- Automations: a claimed run executes the re-read definition without comparing its fingerprint to
  the claim's `scheduleFingerprint`.
- The TUI `/extensions` picker bug is resolved by removing the TUI (section 1b).

## 1b. Remove the TUI

Status: done (review/tui). Web UI gaps remain: extension picker, per-session model/thinking
switching, older-session resume picker.

Ziggy drops its local TUI. The web UI and UI SDK, served by the resident gateway, become the
interactive faces, alongside `run`, ACP, the CLI and chat gateways. A session can be viewed only
through the resident. We accept that.

- Delete `ziggy-tui-extension.ts`, `tui-themes.ts`, `automation-tui.ts`,
  `extension-multi-select.ts`, the `openTui` path in `pi-agent.ts`, the `Tui` command in `main.ts`,
  and their tests (about 2.3k src lines and 0.9k test lines).
- Drop the `pi-tui` dependency, the `PI_PACKAGE_DIR` environment hack, and the compiled TUI asset
  embedding.
- Default `ziggy <profile>` to starting or attaching to the resident and printing the UI URL.
- Check that the UI covers what the TUI did: model and thinking selection, extensions, automations,
  and session resume.
- Update the spec (`docs/research/minimal-ziggy-scout.md`), which lists the TUI as a Pi-owned face.
- Resolves the TUI picker bug, the TUI-versus-resident lease race, and the TUI bypassing the
  resident.

## 2. Codemode setup

Status: pending.

- M1: codemode is unusable until `codemode.json` exists, and there's no schema hint or skill.
- M2: the interpreter's rejection of loops and `try/catch` isn't described in the tool.
- M3: MCP `isError` content collapses to a generic message.
- The README omits Ziggy's selection flow.

## 3. Domain

Status: pending.

- `domain/setup.ts` imports `ModelStatus` from `adapters/pi/models`.
- Move the CLI command union and `CliInputInvalid` to faces.
- Dedupe the `SessionTerminalState` literals and remove the redundant `ProfileAgentInvalid` from
  the unions.
- Trim `test/domain/resident-service.test.ts:18-19`.

## 4. Pi adapter

Status: pending.

- Delete the duplicate prompt and memory helpers in `pi-agent.ts:889-985`, which are only called
  from tests, along with their test cases.
- Stop provider error messages from carrying raw cause text.
- Decide where Profile model policy lives (`pi-agent.ts:1133-1210`).
- Fix the vacuous early returns in `test/adapters/pi/models.test.ts:131-140`.

## 5. Extension system and authoring

Status: pending. Needs a decision on the broken-extension policy.

- One package diagnostic fails the whole Profile runtime (`assertNoPiResourceDiagnostics`).
- The agent tool drops preflight diagnostics.
- `pi_docs` lacks Ziggy's resource rules.
- Add success doesn't say that a reopen or restart is required.
- Delete `test/adapters/pi/profile-extension-selection.test.ts`.

## 6. Automations

Status: pending (the fingerprint recheck is in section 1).

- Parser totality and a cron occurrence model test.

## 7. Chat gateways

Status: pending.

- Bound the per-chat queue and the WebSocket frame and text sizes.
- Remove the unused `slackHeartbeat` and its test.
- Add a health reducer property test: counts never go negative, and queued ≤ active.
- Merging the Slack and Discord turn schedulers is a candidate for a deeper review.

## 8. UI gateway

Status: pending.

- Split `ui-gateway.ts` (1,578 lines) and `management.ts` (947 lines) along protocol boundaries.

## 9. Runtime shell

Status: pending. The TUI and resident question is settled by 1b.

- Application code imports adapters directly (resident service, profiles, doctor).
- A concurrent `init` should treat EEXIST on `SOUL.md` as `created: false`.

## 10. CLI first run

Status: pending.

- The resume hint after a failed non-interactive `init` repeats the same failing command.
- `extensions list <profile>` is rejected, and its usage text omits `update` and `--json`.
- `extensions show` prints "installed" without naming a Profile.
- Consider importing Codex CLI OAuth.

## 11. Runtime interface and preloaded skills

Status: pending.

- Add a small runtime interface in `src/adapters/pi/`: open, prompt, steer, abort, events, close.
  The resident, UI and chat gateways depend on it, and headless Pi implements it. Pi is the only
  implementation; the interface is there to tighten the boundary, not to make runtimes pluggable.
- Audit the preloaded skills for references to the TUI, slash commands, or local interactive
  flows. Point them at the UI, CLI or resident instead.

## Decision: keep Pi, don't own the core

Status: decided (2026-09-28).

- Pi stays the only agent loop, running headless once the TUI is gone (1b). Ziggy doesn't fork,
  port or own the loop, sessions, compaction or the extension runner.
- Owning the core costs tens of thousands of lines, plus mirroring every Pi release by hand. Two
  projects show this:
  - PiG is a Go port with a Node extension host. Its extension API parity is still partial.
  - openclaw internalized a Pi fork and renamed the extension SDK, so Pi extensions no longer load
    unchanged.
- No Codex app-server or Claude SDK runtime. Keep it tight.
- Extensions stay plain Pi extensions. Anything written for Pi works, so there's no tiered
  extension contract.
- Pi upgrades go through the adapter seam. 0.84.1 → 0.87.1 took about an hour.
