# S5 — Autonomy (Automations)

Stage owner: Automations. Depends on S2 (Daemon, for the scheduler and loopback HTTP listener living inside the resident process) and S4 (Molding, Automations pin Skills/Extensions). Feeds S6 (Reach) the Broadcast-rules delivery target.

## Goal

Let a profile define scheduled or webhook-triggered work that runs the agent loop autonomously, at effectively $0 idle token cost, without an always-on heartbeat. Every run is a fresh, isolated session; results are delivered per explicit broadcast rules; there is no separate cron dashboard or infrastructure — runs are ordinary session files.

## Deliverables

- `<profile>/automations/<id>.md` file format: YAML frontmatter + prompt body. These are human-owned moldable files: the owner edits them directly on disk, the daemon hot-reloads them, and the daemon never writes them except through an explicit command.
- Frontmatter schema: required `version`, `trigger` (`schedule: "<cron>"` or `webhook: { name, token }`), `wakeGate` (shell command), `provider`/`model`/`thinkingLevel` pins, `skills` list, `broadcast` rules. Human-owned markdown is otherwise exempt from schema stamps; Automation frontmatter is the explicit exception.
- Wake-gate execution semantics: run the gate command BEFORE constructing any agent/prompt; only an explicit `{"wakeAgent": false}` as the last line of stdout (parsed as JSON) skips the run — anything else (including gate failure/non-JSON output) is treated as "proceed," so gates fail open toward running, not silently swallowing triggers.
- `no_agent` Automation type: its body is a script invocation and the agent loop is never touched. Every execution is still an ordinary Run with a fresh Session file recording the trigger, script invocation, output, and outcome, with zero model calls.
- Scheduler inside the daemon using Effect's `Schedule.cron` (or equivalent), one fiber per profile, loaded at daemon start from `automations/*.md`, hot-reloadable on file change.
- Webhook ingress: a daemon-owned HTTP listener bound to `127.0.0.1` only, started only while at least one enabled webhook-triggered Automation exists. Each Automation receives `/hooks/<name>` and requires its configured per-hook token. Remote exposure is the owner's tunnel or reverse proxy.
- Broadcast delivery: a run's result (or failure) is routed per `broadcast` rules to one or more targets — a gateway (e.g. Telegram chat), a session (append + notify subscribers), or silent (log only).
- `ziggy automations list|runs|run <id> --now` CLI, and a TUI view listing automations + recent runs.

## Design (locked decisions)

**No heartbeat — wake-gates instead.** This is the direct implementation of the token-frugality principle (constitution invariant 7: no LLM call without a user message, a triggered automation, or an explicit tool need). Adopted from hermes-agent's `cron/scheduler.py::_parse_wake_gate`: the gate script is a genuine pre-agent-construction check, so a skip really is $0 spent, not a cheap-but-nonzero model call to decide whether to proceed.

**Fresh session per run (D9, locked over my initial "continuing session" recommendation).** Every automation run gets its own new session, with no carried context from the previous run of the same automation. Any state that must persist across runs (e.g. "have I already notified about X") goes through the Memory primitive explicitly — never through session continuity. This keeps automation runs auditable in isolation and avoids unbounded context growth on frequently-firing automations.

**Broadcast rules (D9, explicit addition beyond the original vision).** An Automation's `broadcast` frontmatter says where results go — this was called out by name as a requirement ("Automations need broadcast rules too") because without it, a scheduled Run's output has nowhere defined to land. Broadcast targets reuse the same delivery path Gateways use for outbound messages (see S6), so there is one delivery mechanism, not two.

**`no_agent` still produces an ordinary Run.** Skipping the agent loop means zero model calls, not zero audit evidence. Each `no_agent` execution creates a fresh Session and appends the trigger, script invocation, captured output, and terminal outcome. The fresh-Session-per-Run contract has no exception.

**Webhook ingress (D9).** The daemon binds its HTTP listener to `127.0.0.1` only and only when at least one webhook-triggered Automation is enabled. Requests go to `/hooks/<name>` and must present that hook's token. Ziggy never exposes this listener remotely; the owner supplies any tunnel or reverse proxy.

**No separate cron infrastructure.** Explicitly rejecting openclaw's model of a distinct cron subsystem/dashboard: an Automation Run is a Session like any other, so `ziggy session list`/the TUI/replay all work on Runs for free. `ziggy automations runs` is a filtered view over Sessions tagged with their originating Automation, not a parallel data store.

**Example automation file:**

```markdown
---
version: 1
trigger:
  schedule: "0 9 * * *"
wakeGate: "./automations/scripts/check-inbox-nonempty.sh"
provider: anthropic
model: claude-5-sonnet
thinkingLevel: low
skills: [triage-inbox]
broadcast:
  - target: gateway:telegram:owner
    on: result
  - target: session:log
    on: always
---

Check the inbox queue and summarize anything that needs my attention today.
```

## Verification growth

Extend `tests/testkit` with a virtual clock/scheduler, subprocess and model-call counters, loopback
HTTP peers, file-watch controls, and fake Broadcast targets. Register wake-gate skip/proceed/
malformed/failure/timeout outcomes, duplicate trigger races, hot-reload during a trigger, webhook
path/token/address rejection, fresh-Session isolation, `no_agent` zero-call behavior, and partial
Broadcast failure. Evidence includes trigger/gate timelines, bind address, model-call counts,
Session envelopes, delivery receipts, and replay commands. A separate Sol medium agent in an
independent run and context reviews hidden heartbeat or model calls, missing Run evidence after a
proceeding trigger, duplicate Runs, non-loopback ingress, and parallel authority.

## Acceptance criteria

- A schedule-triggered automation with a wake-gate that returns `{"wakeAgent": false}` produces zero session creation and zero model call — verify via a counter/log assertion, not just "it didn't error."
- A schedule-triggered automation whose gate proceeds creates a new session distinct from any prior run of the same automation; inspecting two consecutive runs' session files shows no shared context.
- A `no_agent` Automation executes its script, creates a fresh Session containing the trigger, script invocation, output, and outcome, and makes zero model calls (assert both the Session contents and untouched agent-loop path via instrumentation).
- With no enabled webhook-triggered Automation, no HTTP listener exists. Enabling one starts a listener on `127.0.0.1`; the correct `/hooks/<name>` plus token fires it, while a missing/wrong token or another path is rejected.
- Broadcast rules with two targets (a gateway and a session) both receive the run's result; a `broadcast: silent` (or equivalent) automation produces no external delivery, only a session file.
- Editing/adding an `automations/*.md` file while the daemon is running is picked up without a daemon restart.
- `ziggy automations runs <id>` lists that automation's historical runs purely as a filtered session query.
- The harness, S5 plan checklist, and scenario/stage manifests include every landed Automation behavior and negative/concurrency/fault scenario; `verify:s5` and `verify:all` pass with schema-valid redacted evidence and resolved findings from verification/review by a separate Sol medium agent in an independent run and context.

## References to consult

- hermes-agent (opensrc: `/Users/yesh/.opensrc/repos/github.com/NousResearch/hermes-agent/main`), specifically `cron/scheduler.py::_parse_wake_gate` and its `no_agent` execution mode — primary source for the wake-gate mechanism and its exact stdout-JSON-line contract. Ziggy adds its own ordinary-Run Session audit contract.
- `docs/research/` per-turn context research notes (if present under a session/memory research doc) for why fresh-session-per-run keeps prompt-cache and context-growth behavior predictable.
- Effect `Schedule` module docs (`docs/research/effect-v4-status.md` and `vendor/effect` submodule, `ai-docs/src/`) for the cron scheduling primitive to build the fiber on.
- openclaw (opensrc: `/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main`) — reference for what NOT to build (separate cron dashboard/infrastructure); useful as a negative example only.

## Suggested agent workflow

For each slice, follow the `docs/VERIFICATION.md` through-loop: dedicated Sol medium scouting/task-decomposition run and context → red scenario → separate Sol medium implementation run and context → independent Sol medium deterministic verification/evidence/review run and context. The implementing run must not be the verifying run.

1. Frontmatter schema + `.md` parser (`packages/core`) — mechanical, codex sol/medium.
2. Wake-gate subprocess runner with the exact stdout-last-line-JSON contract, including the fail-open behavior on gate error/timeout — needs a clear spec from this doc, then implementation delegation; write tests for fail-open cases explicitly since silent-skip bugs here directly violate the frugality invariant.
3. Scheduler fiber (Effect `Schedule.cron`) wired to daemon startup + hot-reload on file change.
4. Daemon-owned loopback HTTP webhook listener with per-hook path-token authentication, conditional startup, and tests proving it never binds a non-loopback address.
5. Broadcast delivery — build against a stub gateway target first (a local "log" target) so S5 doesn't hard-depend on S6 landing first; wire the real Telegram target in S6.
6. `ziggy automations` CLI + TUI view.

## Non-goals

- A general-purpose queue or distributed task system — Automations are single-Profile, single-daemon.
- Retry/backoff policies beyond what the wake-gate script itself chooses to implement — v1 automations are fire-once per trigger.
- Cross-automation dependencies/DAGs (automation A triggering automation B) — out of scope until a real use case demands it.
