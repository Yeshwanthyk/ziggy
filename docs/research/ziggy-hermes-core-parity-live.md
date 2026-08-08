# Ziggy–Hermes core parity: live profile, agent, and automation experiment

Date: 2026-08-08

## Verdict

Ziggy already has the smaller and better-aligned core:

`Profile folder → Pi-owned auth/model/session runtime → local tools → visible result`

The live experiment succeeded in both products using the same `openai-codex` ChatGPT/Codex
login, `gpt-5.6-luna`, and high reasoning. Ziggy does **not** need Hermes' custom agent loop,
SQLite session engine, mutable memory system, broad plugin registry, or durable multi-agent fleet
to reach core parity.

The important Ziggy gaps are narrower:

1. Profile specialists are not admitted consistently across faces.
2. specialist automation runs lose Pi session and usage lineage by using in-memory sessions.
3. the new Profile Agent primitive is not yet settled in Ziggy's canonical architecture docs.
4. the CLI cannot inspect or operate several primitives that already exist.
5. the client-neutral session contract is too thin for another face to support steering,
   cancellation, and events without bypassing the application boundary.

“On par with Hermes” should therefore mean **equivalent core outcomes and stronger Ziggy
invariants**, not matching Hermes feature-for-feature.

## Scope and interpretation

Two isolated workspaces were created:

- Ziggy: `/Users/yesh/Documents/personal/dump/ziggy-core-parity`
- Hermes root: `/Users/yesh/Documents/personal/dump/hermes-core-parity`
- Hermes named Profile: `/Users/yesh/Documents/personal/dump/hermes-core-parity/profiles/scout`

The experiment covered local profile creation, model/auth configuration, a base model run,
agents, delegation, scheduled-automation definitions, forced execution, and operator
observability. Messaging gateways and remote delivery were intentionally excluded.

The user's “CLA” wording has no canonical meaning in Hermes' first-party docs. The most likely
intended term in this context is **CLI**. This report evaluates the CLI explicitly and leaves
“CLA” unresolved rather than inventing a Hermes abstraction. See
[Hermes Agent primary surface](./hermes-primary-surface.md#h-08--cla-concept-unresolved-term).

## Method

- Hermes comparator: official `NousResearch/hermes-agent`, installed Hermes Agent v0.20.0 /
  release v2026.8.3. Primary-source claims were checked at commit
  [`b3aa561f`](https://github.com/NousResearch/hermes-agent/tree/b3aa561faffd64f05436e429a6415d175e534ec9).
- Provider/model: `openai-codex` and `gpt-5.6-luna` with high reasoning in both products.
- Authentication: existing local auth files were symlinked into the disposable workspaces rather
  than copying credentials. No token or account identifier was printed or recorded in this
  report.
- Identity: both assistants received the same local-only `SOUL.md` policy.
- Runs: exact-output probes were used so that success was mechanically visible.
- Ziggy was exercised through its public CLI. Where no public command existed, a visible Profile
  file was authored and the absence of the command was recorded as a finding.

The raw workspaces are deliberately retained under `Documents/personal/dump` for inspection.
They contain machine state and local auth symlinks and should not be published.

## Live results

| Capability | Ziggy | Hermes | Result |
| --- | --- | --- | --- |
| Create Profile | `ziggy init <path>` | `hermes profile create scout` | Both succeeded. Ziggy's duplicate init was idempotent with exit 0; Hermes rejected a duplicate with exit 1. |
| Select model | Hand-authored Pi `settings.json` | `hermes config set ...` | Same provider/model/reasoning worked; Ziggy lacks an operator command. |
| Base run | Exact `PROFILE_OK` | Exact `PROFILE_OK` | Both exited 0 using `gpt-5.6-luna`. |
| Persistent named specialist | `agents/evidence-scout.md` and `agents/critic.md` | A separate Hermes Profile is the durable agent unit | Ziggy's visible specialist file is more aligned with its Profile model. |
| Ephemeral delegation | Explicit `@evidence-scout` automation route | Two `delegate_task` children | Both worked. Hermes retained child manifests/logs; Ziggy retained no specialist automation session. |
| Automation definition | Visible Markdown under `automations/` | JSON job under `cron/jobs.json` | Both are inspectable, but Ziggy better preserves human-authored prompt files. |
| Forced automation run | `ziggy wake ... evidence-check` → `# Scout` | `hermes cron run` + `cron tick` → `AUTOMATION_OK` | Both succeeded without a messaging gateway. |
| Run projection | `automations status/runs` | `cron runs` plus output file/SQLite | Both expose completion. Ziggy status intentionally showed zero scanned definitions because no scheduler owner had scanned the folder. |
| Resident scheduling | Scheduler is hosted by `ziggy gateway` | Cron scheduler is hosted by Hermes gateway | Neither fires scheduled work without a resident owner; the experiment intentionally did not start one. |

### Model-run footprint

The same trivial prompt, `Reply with exactly PROFILE_OK and nothing else.`, produced:

| Product | Input | Output | Total |
| --- | ---: | ---: | ---: |
| Ziggy | 992 | 6 | 998 |
| Hermes | 11,488 | 6 | 11,494 |

Hermes used about **11.6×** as many input tokens for this probe. Token accounting can differ by
runtime, so this is not a universal benchmark, but it is strong evidence that Ziggy should
preserve its minimal prompt/tool composition rather than eagerly copying Hermes' broad surface.

Evidence:

- Ziggy transcript:
  `/Users/yesh/Documents/personal/dump/ziggy-core-parity/sessions/2026-08-08T02-19-48-835Z_019fdf2b-5ce3-731b-809b-a1dd627193f6.jsonl`
- Hermes usage:
  `/Users/yesh/Documents/personal/dump/hermes-core-parity/profiles/scout/evidence/profile-usage.json`

## What Ziggy already gets right

### 1. Pi remains the runtime authority

Ziggy composes the published Pi runtime instead of owning another provider loop, tool registry,
session database, model catalog, and auth implementation. That is a major architectural advantage,
not a missing feature. It follows the ownership rules in
[`minimal-ziggy-scout.md`](./minimal-ziggy-scout.md) and
[`pi-sdk-surface.md`](./pi-sdk-surface.md).

### 2. The Profile stays understandable from visible files

Ziggy initialized only the identity needed for the Profile and let the experiment add explicit
`agents/` and `automations/` files. Hermes created a broader mix of visible configuration, cache
files, locks, JSON registries, logs, and SQLite databases. Hermes is still folder-scoped, but it
is not the same “open the folder and grok the assistant” design.

### 3. Named specialists fit inside one Profile

Ziggy's specialist file can name a role and narrow provider, model, thinking level, and tools
without creating another Profile, memory authority, or daemon. Hermes' nearest equivalents are:

- another full Profile for a durable named agent, or
- an anonymous delegated child for ephemeral work.

Ziggy's mechanism is the better fit for bounded Profile-local roles, provided it remains a policy
fragment rather than becoming a second assistant authority.

### 4. Automation safety is stricter

Ziggy's cheap wake gate is a core safety invariant. Hermes has a closely comparable
`{"wakeAgent": false}` pre-run script contract and additionally supports script-only jobs. The
comparison validates Ziggy's gate rather than revealing a need to replace it.

A missing gate should remain a scheduled-execution refusal. Operator commands should label such a
definition `manual-only` or warn that it cannot run on schedule; they should not weaken the gate.

## Gaps that matter

### P0 — Make specialists a client-neutral runtime primitive

The core vision says every face should reach the same client-neutral core. Today specialist
admission is split by face:

- TUI startup discovers Profile agents and installs the specialist affordance in
  [`ziggy-tui-extension.ts`](../../src/adapters/pi/ziggy-tui-extension.ts).
- print/one-shot execution does not expose the same model-guided specialist surface.
- automations recognize a leading `@agent-id` through a separate direct route.

This makes the capability depend on how the user entered Ziggy. Move specialist discovery,
validation, and runtime admission into the common application/runtime composition. Keep only TUI
rendering and interaction in the TUI adapter.

The target invariant is:

> The same valid Profile agent definition resolves to the same policy and executable capability
> from TUI, print, automation, and future faces; a face may render it differently but may not
> redefine it.

### P0 — Persist specialist automation sessions through Pi

Ordinary automation runs create fresh persisted Pi sessions under the Profile. The specialist
branch currently constructs in-memory host and child sessions in
[`pi-agent.ts`](../../src/adapters/pi/pi-agent.ts) and
[`specialist.ts`](../../src/adapters/pi/specialist.ts). The live tagged run completed, but no file
was written under `sessions/automations/`.

That loses the exact evidence Ziggy should delegate to Pi:

- session transcript,
- selected model and thinking level,
- tool calls,
- token/usage accounting,
- parent/child run lineage available from the runtime.

This is more serious than a missing CLI command because it weakens the automation invariant that
every model-backed run receives a fresh observable session. Use Pi's persisted session manager for
explicit specialist runs and keep Ziggy's automation ledger as a projection, not a duplicate
transcript store.

### P0 — Settle and document the Profile Agent primitive

The implementation now supports `agents/<id>.md`, but the canonical primitive/status documents
predate or under-specify it. Record the narrow contract before extending it:

- a Profile Agent is a named, Profile-local execution policy;
- it may narrow role, model, thinking, and tool admission;
- it does not own another Profile, memory store, session engine, scheduler, or auth authority;
- every explicit run gets a Pi session;
- face adapters cannot alter its semantics;
- recursive delegation, durable fleets, and background reconnect handles are out of scope unless a
  concrete operator workflow demands them.

### P1 — Complete the minimum operable CLI spine

The live setup exposed commands that are absent even though the underlying capabilities exist:

1. **Help and version.** `ziggy --help` was interpreted as a Profile name.
2. **Effective model status/select.** The experiment had to hand-author `settings.json`.
3. **Agents list/show/run.** `ziggy agents list` was interpreted as Profile `agents`.
4. **Automations list/validate.** Status is correctly scheduler-owned and therefore cannot replace
   a direct filesystem projection.
5. **Sessions.** List/show/resume/export over Pi-owned JSONL, as already planned.
6. **Doctor.** Validate auth/model, Profile agents, automation definitions, missing wake gates,
   writable runtime paths, and selected Pi packages.

Do not add a broad generic `config set` clone. A narrow model command should call Pi's public
model/settings surfaces and show the effective provider/model/reasoning without making Ziggy the
model-catalog authority.

Do not add CRUD that turns Ziggy into the automation-definition owner. `automations list` and
`validate` should read the Markdown source of truth; an optional scaffold command can create a new
file without hiding it.

### P1 — Name the resident core independently of delivery gateways

Scheduled automations already run inside `ResidentGateway` even when no Telegram, Discord, or
Slack delivery is configured. The public name `ziggy gateway` makes that core scheduling owner
look delivery-specific.

Add a first-class command or alias such as `ziggy serve <profile>` or
`ziggy automations serve <profile>` that reuses the same resident owner. Do not create a second
daemon, scheduler, or authority. A one-shot `automations tick` can wait until an OS-scheduler
integration is actually needed.

### P2 — Finish the client-neutral session operations before adding another face

The current application contract exposes `runOnce`, `openTui`, `openChat`, and `runSpecialist`,
while the chat handle is essentially prompt/dispose. The stated session primitive requires
submit, observe/events, steer, abort, and close.

This is not necessary to prove today's CLI/TUI core, but it becomes necessary before a desktop,
web, editor, or messaging face can implement equivalent behavior without importing Pi or
recreating lifecycle policy outside the application layer.

## Hermes features Ziggy should not copy

| Hermes mechanism | Why not copy it into Ziggy core |
| --- | --- |
| Custom `AIAgent` provider/tool loop | Pi already owns this boundary and is Ziggy's selected runtime. |
| SQLite session authority and FTS sidecar | Pi JSONL is authoritative; add projections only for concrete operator queries. |
| Agent-writable memory and skill mutation by default | Conflicts with Ziggy's visible human-owned Profile policy. |
| Full Profile per named specialist | Too heavy for a role/tool/model policy inside one assistant. |
| Recursive/background subagent trees and Kanban fleet | Introduces another lifecycle and durability system before a demonstrated need. |
| Broad dynamic plugin/provider families | Ziggy should compose explicitly selected Pi packages and local Profile files. |
| JSON cron registry plus separate output authority | Ziggy's Markdown definitions and Pi sessions are clearer authorities. |
| Eagerly loaded broad tool surface | The live base probe showed a substantial context footprint compared with Ziggy. |

Hermes does have useful operator ideas to adapt narrowly: profile/model projection, direct cron
run history, preflight validation, exact child-run evidence, and a clearly named profile CLI.

## Recommended implementation slices

1. **Codify the primitive.** Update the architecture/status docs with the Profile Agent contract
   and cross-face invariant.
2. **Repair runtime composition.** Admit specialists through a shared application/runtime path;
   leave only presentation in each face.
3. **Repair automation lineage.** Give tagged specialist runs fresh persisted Pi sessions and
   focused regressions proving transcript/model/usage persistence.
4. **Fix CLI grammar.** Add `help`, `--help`, `-h`, and `version` while preserving Profile shorthand.
5. **Expose effective model control.** Add narrow status/select commands backed by Pi.
6. **Expose visible primitives.** Add agents list/show/run and automations list/validate, with
   `manual-only`/missing-gate diagnostics.
7. **Finish operator projections.** Implement sessions, then doctor, extending the existing CLI
   plan with agent and gate checks.
8. **Clarify resident execution.** Add a `serve`-style alias over the existing scheduler owner.
9. **Complete session lifecycle only before a new face.** Add events/steer/abort to the
   client-neutral contract when a second non-TUI face makes those operations concrete.

This order fixes invariant violations before adding convenience commands and preserves the
smallest architecture that satisfies the demonstrated workflows.

## Evidence index

### Ziggy

- Profile and absent agents CLI:
  `/Users/yesh/Documents/personal/dump/ziggy-core-parity/evidence/profile-and-agent-cli.txt`
- Duplicate init:
  `/Users/yesh/Documents/personal/dump/ziggy-core-parity/evidence/profile-idempotency.txt`
- Base run:
  `/Users/yesh/Documents/personal/dump/ziggy-core-parity/evidence/profile-run.txt`
- Tagged specialist automation:
  `/Users/yesh/Documents/personal/dump/ziggy-core-parity/evidence/agent-automation-run.txt`
- Automation status/runs:
  `/Users/yesh/Documents/personal/dump/ziggy-core-parity/evidence/automation-observability.txt`

### Hermes

- Profile list/show:
  `/Users/yesh/Documents/personal/dump/hermes-core-parity/profiles/scout/evidence/profile-cli.txt`
- Duplicate create:
  `/Users/yesh/Documents/personal/dump/hermes-core-parity/profiles/scout/evidence/profile-idempotency.txt`
- Base run and usage:
  `/Users/yesh/Documents/personal/dump/hermes-core-parity/profiles/scout/evidence/profile-run.txt`
  and `profile-usage.json`
- Delegation:
  `/Users/yesh/Documents/personal/dump/hermes-core-parity/profiles/scout/evidence/delegation-run.txt`
  and `delegation-usage.json`
- Cron creation/run/history:
  `/Users/yesh/Documents/personal/dump/hermes-core-parity/profiles/scout/evidence/cron-create.txt`,
  `cron-run.txt`, and `cron-runs-corrected.txt`
- Cron output:
  `/Users/yesh/Documents/personal/dump/hermes-core-parity/profiles/scout/cron/output/eed0993ecd32/2026-08-07_22-21-24.md`

For the full first-party Hermes source inventory, see
[Hermes Agent primary surface](./hermes-primary-surface.md).
