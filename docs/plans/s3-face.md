# S3 — Face

## Goal

Give ziggy a real face: a profile-scaffolding command, starter personalities, a rich terminal client, and CLI one-shots — talking to a real daemon over a real provider for the first time. This is the first stage where a human can actually sit down and use ziggy.

## Deliverables

- `ziggy init [path]` — scaffolds a new profile folder:
  - `ziggy.jsonc` (profile config: default provider/model, thinking-level defaults, other top-level settings).
  - `SOUL.md` — the profile's personality/instructions file, seeded from a chosen starter voice template.
  - `memory/` (empty, ready for `MEMORY.md`/`USER.md` to be created on first write).
  - `sessions/` (empty).
  - `extensions/` (empty).
  - `automations/` (empty).
  - `credentials/` — created with `0600`/`0700` permissions for provider auth material.
  - **Non-destructive**: `ziggy init` on a folder that already has a `SOUL.md` (or other profile files) must never clobber them — prompt or no-op instead. (This is a direct lesson from merlin — see `docs/REFERENCES.md`.)
- 3–4 starter voice templates (distinct `SOUL.md` starting points — e.g. a neutral/minimal assistant, a warm personal-assistant tone, a terse engineering-focused tone; exact set is DECIDE-AT-BUILD with the user) selectable via `ziggy init --voice <name>` or an interactive prompt.
- `packages/tui` — rich terminal client built on `pi-tui`, depending **only** on `packages/protocol` (never on `packages/core` — enforce this at the package.json/import-graph level, e.g. via `knip`/dependency-cruiser in CI). Capabilities: streaming render of an in-flight turn, sending a steer message mid-turn, switching between sessions, rendering/responding to approval prompts, replaying history correctly on reconnect (using S2's replay-from-seq).
- CLI one-shots in `packages/ziggy`: `ziggy ask "<prompt>"` (one-shot turn against the main session, print result, exit), `ziggy sessions list`, `ziggy service <install|start|stop|status>` (wraps S2's service commands), `ziggy doctor` (already built in S2, exposed here as the user-facing entry point).
- Provider auth flows surfaced to the user: API-key-via-env-var path documented and checked by `doctor`; OAuth login command(s) (`ziggy auth login <provider>`) wired to whatever `pi-ai` exposes for OAuth providers (Anthropic Pro/Max, `openai-codex-responses` for Codex/ChatGPT Plus/Pro) per `docs/REFERENCES.md`.

## Design (locked decisions binding this stage)

- Rich TUI ships in v1 — not CLI-only (Q10, locked). The TUI is a pure attach client: it renders and steers, it never mutates session/memory state directly outside the protocol (constitution rule 5).
- `tui` depends only on `protocol`, never on `core` — this is a hard package-boundary rule, not a suggestion; violating it defeats the point of the attach-protocol separation (a future gateway or GUI must be able to do exactly what the TUI does using only `protocol`).
- Provider layer ships the full `pi-ai` catalog (Q9, locked) — `ziggy auth login` should not be hand-built per provider; lean on whatever `pi-ai` already provides for credential storage/OAuth flows, adapted to ziggy's own `credentials/` file location if `pi-ai`'s default storage location doesn't fit the per-profile-folder model.
- Non-destructive `ziggy init` is a hard requirement, not a nice-to-have — sourced directly from a merlin lesson-learned.

## Verification growth

Extend `tests/testkit` with fixture-owned Profile trees, scripted terminal rendering/input, simulated
Provider/Auth adapters, and disconnect/reconnect controls. Register non-destructive init and
permission failures, distinct Voice fixtures, forbidden `tui -> core` edges, streaming/steer/
approval/replay behavior, credential redaction, and malformed Provider responses. Evidence includes
Profile diffs, render snapshots, protocol traces, package-graph output, and separate manual live-
Provider smoke records. A separate Sol medium agent in an independent run and context reviews
Client-only mutation, secret leakage, buffered rendering, replay duplication, and any deterministic
test that reaches a live service.

## Acceptance criteria

- [ ] `ziggy init ./my-profile` produces the full directory listed above; running it again on the same folder does not overwrite an edited `SOUL.md`.
- [ ] `ziggy init --voice <name>` (or interactive equivalent) seeds `SOUL.md` from the chosen template. Each of at least 3 Voice templates differs in its stated persona summary, tone directives, and default verbosity section; a scripted diff check confirms those sections are non-identical across templates.
- [ ] `ziggy auth login <provider>` for at least one API-key provider and one OAuth provider succeeds end-to-end and `ziggy doctor` subsequently reports that provider as authenticated.
- [ ] `ziggy ask "hello"` against a real, authenticated provider returns a real model response, with the turn correctly recorded in the session's NDJSON log per S1/S2.
- [ ] The TUI: opens the main session, streams a real response token-by-token (not buffered-then-dumped), successfully steers a running turn, and — after being killed and restarted — replays prior history correctly using S2's reconnect/replay path rather than re-fetching from scratch.
- [ ] `packages/tui`'s `package.json` has zero dependency on `packages/core` (checked in CI, not just by inspection).
- [ ] `ziggy sessions list` shows the main session plus any pinned sessions created during testing.
- [ ] The harness, S3 plan checklist, and scenario/stage manifests include every landed Face behavior and negative/reconnect scenario; `verify:s3` and `verify:all` pass with schema-valid redacted evidence and resolved findings from verification/review by a separate Sol medium agent in an independent run and context. Live Provider/Auth checks remain separate and cannot waive deterministic failures.

## References to consult

- pi-tui (`@earendil-works/pi-tui` — check `docs/REFERENCES.md` / pi-mono `packages/tui`) — differential-rendering, keybindings, native modifier detection to build on rather than reimplement.
- merlin (`/Users/yesh/code/personal/merlin`, reference-only) — specifically whatever lesson documented the profile-init/SOUL.md-clobbering pitfall; cite the exact file in the implementation PR.
- `docs/research/` pi-ai-as-provider-layer report — for `ziggy auth login`'s credential-storage and OAuth-flow integration points.
- `docs/CONSTITUTION.md` rule 5 (clients render, never mutate) — the TUI/core dependency boundary is the concrete enforcement mechanism for this rule.

## Suggested agent workflow

For each slice, follow the `docs/VERIFICATION.md` through-loop: dedicated Sol medium scouting/task-decomposition run and context → red scenario → separate Sol medium implementation run and context → independent Sol medium deterministic verification/evidence/review run and context. The implementing run must not be the verifying run.

1. One codex `exec` (sol-medium) task: `ziggy init` + starter voice templates + non-destructive-write tests.
2. One codex `exec` (sol-medium) task, parallel: `ziggy auth login`/`doctor` provider-auth wiring against `pi-ai`.
3. One codex `exec` (sol-medium) task, after S2 is stable: `packages/tui` skeleton on `pi-tui` — session view, streaming render, steer input, approval prompts.
4. One codex `exec` (sol-medium) task, parallel with 3: CLI one-shots (`ask`, `sessions list`, `service` wrapper).
5. Independent Sol medium verification/review pass in a separate run and context with an explicit check that `packages/tui` has no direct or transitive import path into `packages/core`; convert applicable findings to deterministic regression scenarios.
6. The independent Sol medium verifying run runs and records this manual acceptance checklist: (1) initialize a new Profile interactively and choose a Voice; (2) edit `SOUL.md`, rerun init, and confirm the edit survives; (3) authenticate one API-key Provider and one OAuth Provider; (4) start a real Turn in the TUI and observe incremental streaming; (5) steer the active Turn and confirm the steer affects the next Step; (6) resolve an approval in the TUI; (7) kill and restart the TUI and confirm replay resumes without duplicates; (8) run `ziggy ask` and `ziggy sessions list` against the same daemon.

## Non-goals

- No extensions loaded yet (S4) — the TUI/CLI talk to a daemon with session+memory only.
- No automations (S5).
- No gateways (S6) — TUI/CLI only, local Unix socket only.
- GUI client is out of scope — post-v1 (S7).
