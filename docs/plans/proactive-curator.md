# Proactive Curator

Squarey already watches finished chats. It waits until 03:00 UTC, stays silent, and then
no-ops if the chats were different. The fix is to learn from each pending foreground chat,
soon after it ends, and to write either a memory fact or a skill-only Profile extension.

Hermes does this in-process after about ten turns. Ziggy already has the right host: Pi
observes, a gated automation reviews. This plan changes the review rules, the queue, the
schedule, and how a new extension gets selected. It does not add a Hermes-style fork, and
it does not prune unused extensions.

## Terms

| Word | Meaning |
| --- | --- |
| **Memory / fact** | A short standing note about the user or how they want Squarey to behave. Written with native `memory_write`, prefixed `[learned]`, into `MEMORY.md` or person/group memory. |
| **Extension** | A skill-only Profile package at `extensions/<id>/` with a `SKILL.md`. It teaches a *kind* of work (reminders, weather, research), not “what we did today.” No `index.ts`. Marked `ziggy.curatorManaged: true`. |
| **Foreground chat** | A finished TUI or gateway session (local/main, Slack, Telegram, Discord). Not automations, not specialist/child agents, not aborted/error chats. |

## Orientation

Keep the observer and the review as two steps. Observation is cheap and local. Review calls a
model only when `curator-ready` exists. After a successful review, pending chats are marked
reviewed so they are not judged again.

A new extension is a normal Profile package. Creating it also selects it in `extensions.json`.
The next new chat calls `discoverPiResources` and sees it. Do not restart Squarey for this.
An already-open thread keeps its old list until that thread is reopened.

Do not archive or hide an extension because it looks unused. Idle time is not proof. Removal
stays out until there is an event log and a real fault.

## Settled decisions

- Review **pending** foreground chats. One substantial chat is enough. A no-op is allowed
  only when nothing durable happened.
- Prefer a concise memory fact when the lesson is about the person or standing taste. Write
  an extension when the lesson is a reusable method. Style and workflow corrections belong
  in the extension that governs that kind of work, not only in memory.
- Name extensions for the kind of work. Put session-specific detail in `references/` under
  that package. Do not mint a new package per incident.
- The automatic path never writes `SOUL.md`, `AGENTS.md`, repository packages, catalogue
  packages, executable packages, or any package that is not `curatorManaged`.
- Do not save environment failures, “X is broken” claims, unresolved dead ends, or one-off
  task narratives.
- Watch every eligible foreground face on that Profile: TUI `sessions/local/main`, Slack,
  Telegram, Discord. Skip `sessions/automations/`, `sessions/agents/`,
  `sessions/specialists/`.
- Arm ready after **one** new pending chat. On `applied` or `no-op` with `clearReady`, move
  pending IDs to reviewed.
- Cron `*/15 * * * *` UTC, same `test -f .runtime/self-improvement/curator-ready` gate.
  Skipped-gate rows are accepted. Do not change scheduler recording.
- Template `broadcast` stays `none`. Delivery skips empty replies. Squarey’s notify target
  is an operator edit of the Profile automation file.
- Adopt is explicit. The automatic path may recommend adopt for an in-play human/catalog
  package. It must not rewrite one. New methods land in a new managed extension until adopt.
- Select on create. No Squarey process restart for skill-only packages.
- No idle prune, archive, or consolidation.

## Scope

In:

- `extensions/self-improvement/**` (skill, automation template, observer, tools, tests)
- skip-empty delivery in `src/application/automations.ts`
- research/spec: drop the recurrence rule
- Squarey Profile automation edit at rollout (install does not overwrite a customized file)

Out:

- in-process review threads
- notify the exact originating Slack thread
- `write_approval` UI (`staged` already must not clear ready)
- Hermes journey, cron suggestions, consolidation, idle archive
- changing skipped-gate persistence
- overwriting customized Profile automation files
- Squarey process restart for skill-only curator packages
- executable `index.ts` on the automatic path

## Target flow

```text
TUI or gateway chat settles (not automation / specialist / failed)
  → observeCompletedForegroundSession
  → pendingSessionIds += path (if new)
  → curator-ready when pending.length >= 1

scheduler (cron */15 UTC)
  → gate: test -f curator-ready
  → miss: skipped-gate, no model
  → hit: fresh sessions/automations/self-improvement-curator
       → review only pending JSONL
       → memory_write and/or write a skill-only extension
       → self_improvement_log applied|no-op + clearReady
       → pending → reviewed
       → if applied and reply non-empty and Profile broadcast ≠ none: one line
```

State lives under `<profile>/.runtime/self-improvement/`. Pi JSONL is the evidence.
The automation Markdown owns schedule, gate, and broadcast.

### State v2

```json
{
  "version": 2,
  "pendingSessionIds": [".../sessions/slack/.../a.jsonl"],
  "reviewedSessionIds": [".../sessions/local/main/b.jsonl"],
  "lastObservedAt": "2026-08-15T12:15:24.009Z"
}
```

Read of v1 `{ completedSessionIds }` copies those IDs into `pendingSessionIds`. Cap 32 per
list. Ready file content stays `"ready\n"`.

## Implementation chunks

### Slice 1 — Review policy

**Behavior.** Each pending foreground chat is a learning chance. It may write a `[learned]`
memory fact, or create/patch a managed skill-only extension for that kind of work. No-op only
for trivia, already-captured facts, or the don't-capture list.

**Files.** `extensions/self-improvement/skills/curator/SKILL.md`,
`extensions/self-improvement/automations/curator.md`,
`docs/research/self-improving-memory-extension.md`.

**Stance.** Be active. Signals: user correction, a real method, an in-play managed extension
that was wrong. Order: patch a managed extension already in play → patch an existing managed
extension for that kind of work → add `references/` under it → create a new managed
extension. Human/catalog packages: recommend adopt, do not edit.

**Depends on.** Nothing. Would have changed Squarey’s 2026-08-15 03:02 no-op.

**Verify.** Skill/spec no longer require recurrence across chats. `bun run check`.

**Risk.** Noisy memory. Mitigate with don't-capture and “one short fact.”

### Slice 2 — Pending queue

**Behavior.** One eligible foreground chat arms `curator-ready`. A successful review consumes
pending IDs. Duplicates and already-reviewed paths do not re-arm. TUI and gateway chats
count. Automations and specialists still do not.

**Files / symbols.** `extensions/self-improvement/src/manager.ts`: `READY_THRESHOLD = 1`,
`CuratorStateValue` v2, `observeCompletedForegroundSession`, `readStatus`, `appendReviewLog`.
`index.ts` status payload. `extensions/self-improvement/test/self-improvement.test.ts`.

**Depends on.** Land before slice 4 so 15-minute runs do not re-read old chats.

**Verify.** One Slack or local/main session arms ready. Duplicate skipped. Automation/error
skipped. `clearReady` moves pending → reviewed. v1 state migrates.

**Risk.** Lost v1 IDs. Mitigate with migrate-on-read.

### Slice 3 — Visible applied, silent no-op

**Behavior.** Empty automation replies are not delivered. On no-op the curator’s final
message is empty. On applied it is one line (`learned: …`).

**Files / symbols.** `src/application/automations.ts` (skip `deliver` when
`reply.trim() === ""`). `test/application/automations.test.ts`. Skill text from slice 1.

**Template.** `broadcast: none`. No new broadcast token.

**Depends on.** Slice 1 for the empty-final-message rule.

**Verify.** Empty reply + a broadcast target → completed, zero deliveries. Non-empty still
delivers.

**Risk.** Models still narrate no-ops. Do not parse `self_improvement_log` from core.

### Slice 4 — 15-minute cadence

**Behavior.** Cron `*/15 * * * *` UTC, same gate. After a TUI or Slack chat finishes, the
next quarter-hour can review it.

**Files.** `extensions/self-improvement/automations/curator.md`. Squarey
`~/.ziggy/profiles/squarey/automations/self-improvement-curator.md` by hand. Any test that
embeds the old frontmatter.

**Depends on.** Slice 2.

**Verify.** Template parses. Missing marker still skips the model.

**Risk.** About 96 skipped-gate rows/day. Accepted.

### Slice 5 — Adopt

**Behavior.** `self_improvement_adopt` marks an existing Profile skill-only package
`curatorManaged`. Later reviews may patch it. Refuses executables, reserved IDs
(`pi-packages`, `extension-authoring`, `ziggy-operations`, `self-improvement`), and
symlinks. Does not rewrite the skill body. Automatic path recommends adopt; it does not
auto-adopt `weather`.

**Files / symbols.** `adoptCuratorExtension` in `manager.ts`. New tool in `index.ts`.

**Depends on.** Slices 1–2.

**Verify.** Skill-only adopt succeeds. Executable package fails. After adopt, replace works.

### Slice 6 — Select on create

**Behavior.** Creating a managed extension also appends its id to `extensions.json` if
missing. The next new chat or automation `openChat` lists it. No Squarey process restart.
An already-open thread waits until that thread is reopened.

**Files / symbols.** `writeCuratorExtension` in `manager.ts`. Atomic JSON rewrite at this
filesystem boundary. Do not import Effect `profile-extensions` into the Pi package.

**Depends on.** Slice 1 (CLI `ziggy extensions add` becomes fallback only).

**Verify.** Create selects. Duplicate select is a no-op. Later `discoverPiResources` includes
the new skill path. No `index.ts` on this path.

**Risk.** Malformed `extensions.json`. Fail the tool; do not clobber.

## Verification matrix

| Slice | Invariant | Proof |
| --- | --- | --- |
| 1 | Recurrence not required; memory vs extension split is explicit | skill/spec |
| 2 | One eligible TUI or gateway chat arms ready; review consumes pending | package tests |
| 2 | Automations/specialists/errors still skipped; v1 migrates | package tests |
| 3 | Empty reply does not deliver | `test/application/automations.test.ts` |
| 4 | Template cron/gate parse; missing marker skips Pi | existing gate tests + fixture |
| 5 | Adopt skill-only only | package tests |
| 6 | Create selects; next `discoverPiResources` sees the path | package tests |
| all | `bun run check`; no SOUL/repo/executable writes | check + replace guards |

Live Squarey proof after 1–4: one real Slack or TUI chat → ready → next 15-minute tick →
memory and/or a new `extensions/<id>/`, or a no-op that does not re-queue those chats.
After 6, a **new** chat lists the extension. Do not restart Squarey to prove that.

## Rollout

1. Land 1–3 in the repo. Squarey can keep 03:00 until 4.
2. Edit Squarey’s `automations/self-improvement-curator.md` cron (and optional broadcast
   target) by hand.
3. Copy the updated `self-improvement` package onto Squarey. New chats pick up selected
   skill-only extensions. Restart only if executable code changed, which this path must not.

## Risks

- The reviewer is still a model. Fences and don't-capture matter more than cadence.
- Skipped-gate volume rises. Do not “fix” that with a model call.
- Template and Squarey automation file can diverge. The Profile file is live.
- An already-open chat handle will not see a brand-new extension until that chat is
  reopened.
- Auto-adopting `weather` would let the loop edit a human-facing package. Slice 5
  recommends only.

## Open decisions

These do not block slices 1–4:

- Squarey’s broadcast target (owner DM, a channel, or stay `none`).
- Whether slice 5 later auto-adopts in-play skill-only packages. Default: recommend only.
- Notify the originating Slack thread. Separate origin work.
- Any removal of extensions. Out until an event log proves a fault.
