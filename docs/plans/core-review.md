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
| `webui` | 13 | `clients/web`, `packages/ui-sdk`, `src/application/ui-gateway*`, `src/adapters/bun/ui-server.ts` | now |
| `headless` | 12 | `ziggy wake`, `extensions update`, the `deliver` lanes in `automations.ts`, `automations status` | after `auto` and `adapter` |

## 0. Pi 0.87.1 upgrade

Status: done; on main (d5bb377).

- Brings the GPT-6 catalog (`gpt-6-luna`, `gpt-6-astra`). Handles the breaking changes
  (`NormalizedBuildSystemPromptOptions`, typebox 1.3.27).

## 1. Correctness fixes

Status: done.

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

Status: done (review/ext).

- M1: codemode is unusable until `codemode.json` exists, and there's no schema hint or skill.
- M2: the interpreter's rejection of loops and `try/catch` isn't described in the tool.
- M3: MCP `isError` content collapses to a generic message.
- The README omits Ziggy's selection flow.

## 3. Domain

Status: done (review/cli).

- `domain/setup.ts` imports `ModelStatus` from `adapters/pi/models`.
- Move the CLI command union and `CliInputInvalid` to faces.
- Dedupe the `SessionTerminalState` literals and remove the redundant `ProfileAgentInvalid` from
  the unions.
- Trim `test/domain/resident-service.test.ts:18-19`.

## 4. Pi adapter

Status: done (review/adapter). Profile model policy moves to the application model-selection service in the cleanup pass.

- Delete the duplicate prompt and memory helpers in `pi-agent.ts:889-985`, which are only called
  from tests, along with their test cases.
- Stop provider error messages from carrying raw cause text.
- Decide where Profile model policy lives (`pi-agent.ts:1133-1210`).
- Fix the vacuous early returns in `test/adapters/pi/models.test.ts:131-140`.

## 5. Extension system and authoring

Status: done (review/adapter). Broken optional packages are skipped and reported; their automations pause. Loading factories once under quarantine is left for the cleanup pass.

- One package diagnostic fails the whole Profile runtime (`assertNoPiResourceDiagnostics`).
  Decided (2026-09-28): skip the broken package, load the rest, and warn loudly in `doctor`, the
  web UI and the agent tool.
- The agent tool drops preflight diagnostics.
- `pi_docs` lacks Ziggy's resource rules.
- Add success doesn't say that a reopen or restart is required.
- Delete `test/adapters/pi/profile-extension-selection.test.ts`.
- `ctx.ui` is headless in every host: `confirm` is `false`, `select` and `input` are `undefined`,
  `hasUI` is `false`. The authoring skill says so (done in `ext`); `pi_docs` should too.

## 6. Automations

Status: done (review/auto).

- Parser totality and a cron occurrence model test.

## 7. Chat gateways

Status: done (review/chat). Merging the Slack and Discord turn schedulers stays deferred.

- Bound the per-chat queue and the WebSocket frame and text sizes.
- Remove the unused `slackHeartbeat` and its test.
- Add a health reducer property test: counts never go negative, and queued ≤ active.
- Merging the Slack and Discord turn schedulers is a candidate for a deeper review.

## 8. UI gateway

Status: done (review/ui).

- Split `ui-gateway.ts` (1,578 lines) and `management.ts` (947 lines) along protocol boundaries.

## 9. Runtime shell

Status: partly done (review/adapter): Profile filesystem, doctor probes and resident platform sit behind application ports. Doctor and resident policy still live partly in adapters; moved to the cleanup pass. The TUI and resident question is settled by 1b.

- Application code imports adapters directly (resident service, profiles, doctor).
- A concurrent `init` should treat EEXIST on `SOUL.md` as `created: false`.

## 10. CLI first run

Status: done (review/cli). Codex OAuth import is on hold for an owner decision.

- The resume hint after a failed non-interactive `init` repeats the same failing command.
- `extensions list <profile>` is rejected, and its usage text omits `update` and `--json`.
- `extensions show` prints "installed" without naming a Profile.
- Consider importing Codex CLI OAuth.

## 11. Runtime interface and preloaded skills

Status: 11a (session writer lease) done (review/adapter). UI adoption at `ui-gateway/sessions.ts` goes to webui round 2. Runtime interface: done (adapter round 3). Preloaded skills audit pending.

- Add a small runtime interface in `src/adapters/pi/`: open, prompt, steer, abort, events, close.
  The resident, UI and chat gateways depend on it, and headless Pi implements it. Pi is the only
  implementation; the interface is there to tighten the boundary, not to make runtimes pluggable.
- `open` takes a per-session writer lease keyed by session id, stored in `.runtime/`, using the
  `BEGIN IMMEDIATE` and stale-pid pattern from `gateway-owner.ts`; `close` releases it. The
  resident, `run --continue`, `run --session`, ACP and stored automation appends
  (`automation-result.ts`) all go through it. A held lease is a plain refusal: "this session is
  open in the resident; use the UI, or start a new session". Today two writers don't crash: Pi
  appends whole lines without a lock and takes the last entry as the leaf, so the session tree
  silently forks and the last writer wins.
- The interface has no presence or broadcast port. Presence is `inspectGatewayOwner`, read by
  faces before they start, never by a runtime.
- Audit the preloaded skills for references to the TUI, slash commands, or local interactive
  flows. Point them at the UI, CLI or resident instead.

## 12. Headless hosts and the resident

Status: pending. Starts after `auto` and `adapter` merge (needs the session lease from 11a).

The resident owns connections and live sessions, never extension execution or definitions.
Extensions, tools, hooks, specialists, `run`, ACP and `wake` load the same Pi runtime with or
without a resident. Chat delivery is direct HTTP from any process. A face picks its lane by
reading the owner lease before it starts; nothing falls back after the fact.

- `deliver`: a `conversation:` target without a registry appends the stored receipt under the
  session lease, instead of failing with `owner-unavailable`. The receipt check keeps it
  idempotent.
- `ziggy wake`: if the resident is running, call its `automation.run` over the UI socket, using
  the projection's port and token, and print the outcome. Otherwise run in-process as today.
- `automations status`: when the resident service isn't installed, print "schedules will not
  fire: run `ziggy serve install <profile>`; `ziggy wake <id>` runs one now". Installing an
  extension that ships automations prints the same.
- `extensions update --restart`: stage, stop the managed resident, apply under the update lock,
  start it again. Without `--restart`, keep the refusal and name the flag.
- The wake migration path's "gateway already running" error should read "resident is starting;
  retry".

## 13. Web UI parity

Status: done (review/webui, round 2). Follow-ups for the cleanup pass: emit the transcript reset inside the session switch (resume/reset race), keep status on model-scope events in the ui-sdk reducer, a scoped mtime-bounded summaries API in the adapter, and model-event and web reset tests.

The web UI is the only interactive face since 1b. It lacks:

- an extension picker: list, enable and disable Profile extensions, with the same preflight and
  "restart needed" message as the CLI and agent tool;
- per-session model and thinking switching, alongside the existing Profile defaults;
- a resume picker for older Pi sessions.

## Decision: the resident is optional for extensions

Status: decided (2026-09-28), from a Fable review of Ziggy, hermes-agent and openclaw.

- No extension surface depends on the resident. There's no service locator, event bus, injection
  API or tiered registration mode, and extensions stay plain Pi extensions.
- Resident-only, by nature: inbound channel sockets, sessions it holds open, the scheduler and
  interactive UI. The resident needs no chat config: with none, it is just the scheduler and
  the web UI, so it is the Profile's background process, not a gateway extensions depend on.
  Everything else runs headless and is tested that way.
- No `ziggy tick`. A timer-driven one-shot scheduler would duplicate the resident, with its own
  launchd and systemd installers, for users who never install the resident.
  `ziggy serve install` covers them.
- When the resident is running, `ziggy wake` hands the run to it. `run --continue` on a session the
  resident holds refuses and points at the UI.
- No durable outbox. All three channels send over HTTP from any process, and conversation
  receipts are idempotent stored appends. hermes and openclaw need queues only for
  gateway-only transports (relay, E2EE, WhatsApp), which Ziggy doesn't have.
- No silent fallback in either direction. openclaw retired its gateway-to-local fallback after
  transcript lock races.
- Not doing: a `ctx.ui` bridge (until an extension needs `notify` in the web UI), hot reload in the
  resident, or a second scheduler outside the resident.

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

## After the streams

Status: pending. Starts when adapter, adapter round 3, webui round 2 and headless have merged.

1. Owner walkthrough: the owner reads the code, guided by a map of modules, control flows and what each stream changed.
2. Baseline: confirm everything works end to end with a scratch Profile (init, run, resident plus web UI, chat gateways, automations, extensions add/skip/remove, wake). Tag the result as the baseline.
3. Cleanup pass from that baseline:
   - break oversized modules into cohesive ones;
   - simplify control flows;
   - remove old code that doesn't line up with Effect v4 idioms (checked against vendor/effect).
