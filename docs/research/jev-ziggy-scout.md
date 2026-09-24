# Jev TypeSafe and Ziggy: read-only integration scout

Date: 2026-09-17. This is a source scout, not an implementation proposal that has been
landed. No Jev package, import, provider, or runtime hook is present in this checkout.
The Jev model assumed for this note is the user's description: typed `Choice` options with
probability/confidence, rubric `Score`, and independently evaluated Noul truth in `[0,1]`
over the same state. It must not be treated as a vision or generation system.

## Strongest fit: a remote decision/verifier beside computer-use

Ziggy already has the right evidence boundary. The semantic adapter registers the upstream
computer-use tools and Ziggy's bounded `run_ui_segment` at
[`extensions/computer-use/index.ts:139-169`](../../extensions/computer-use/index.ts#L139-L169).
The segment driver obtains a fresh root and observation, resolves exactly one semantic match,
acts, and waits for the mandatory postcondition at
[`extensions/computer-use/segment.ts:304-438`](../../extensions/computer-use/segment.ts#L304-L438).
The driver returns bounded completion evidence (`stateId`, ref, action count) at
[`extensions/computer-use/segment.ts:444-454`](../../extensions/computer-use/segment.ts#L444-L454),
while the underlying runtime reports `worked`, `didnt`, or `unknown` and keeps immutable
state/epoch evidence (the package architecture describes this at
[`extensions/computer-use/docs/architecture.md:51-55`](../../extensions/computer-use/docs/architecture.md#L51-L55)
and `:101-109`).

The minimal useful Jev slice is therefore a typed adapter that sends an already observed state or
tool result to the remote Jev/Noul API:

* `Choice`: classify candidate next steps or records using fields already present in the
  outline/search result; confidence may recommend proceeding, re-observing, or review.
* `Score`: apply a task-specific rubric to postcondition evidence (role/text presence,
  `worked` outcome, changed successor state) and return a typed advisory score.
* Noul: independently evaluate the same before/after evidence; low truth or disagreement must
  trigger re-observation, escalation, or review. It never authorizes an ambiguous mutation.

This can make computer-use fast by reducing expensive model turns and serial tool chatter, not by
making vision faster: compile a saved workflow into bounded segments and use Jev's remote
classification to decide whether a record needs escalation between segments. The existing
compiler already batches up to 20 compatible steps and marks
manual steps at [`extensions/computer-workflows/src/execution-plan.ts:136-149`](../../extensions/computer-workflows/src/execution-plan.ts#L136-L149)
and [`:154-301`](../../extensions/computer-workflows/src/execution-plan.ts#L154-L301). A first
integration belongs in `extensions/computer-workflows/src/` as a typed remote-client adapter,
injected into the extension entrypoint, rather than in the native helper or provider adapter.
Preserve the existing lease, state IDs, epoch checks, unique-match refusal, postconditions, and
fail-closed unknown outcomes as the execution authority.

The supplied SDE cascade cookbook sharpens the mental model: deterministic schema checks first,
cheap structured extraction/classification second, Jev/Noul per-field flags third, and a strong
model only for flagged records. Field flags localize which record needs attention; they do not
guarantee field-only repair. The escalation gate is `max(flag)` rather than an average, so one
high-confidence bad field is enough to escalate its record. Applied here, “fields” are concrete
checkpoint, target, extracted-item, or delivery claims; a holistic `is this run good?` score is
useful for display but must not hide one red flag. This is a design mapping from the cookbook,
not evidence that Ziggy currently depends on the TypeSafe SDK or `jev-1.12`.

The current replay path deliberately tells the model to issue each segment itself
([`extensions/computer-workflows/index.ts:1249-1295`](../../extensions/computer-workflows/index.ts#L1249-L1295));
that is the clearest proposed call site for a typed Jev decision layer. It must remain a
proposal until a Jev package/API and a policy for when local choice is allowed are specified.

## Additional Ziggy-code uses with real seams

1. **Workflow choice and repair.** `workflow_plan` already produces `segments`, `manual`,
   variables, and a replay rule (`index.ts:1249-1295`), while `workflow_run_finish` persists a
   compact evidence summary (`index.ts:1304-1328`). Jev can choose the next segment or classify
   a failed/unknown segment from this typed evidence; Noul can score whether the checkpoint was
   actually established. It should not rewrite the workflow or replay a consequential action on
   a low-truth/ambiguous result.

2. **Automation notification significance.** The automation runner has a concrete seam after
   the model reply and before fan-out: `printReply`, `resolveTargets`, and per-target
   `deliver` at [`src/application/automations.ts:416-449`](../../src/application/automations.ts#L416-L449),
   with typed terminal/delivery outcomes in `src/domain/automation.ts:181-209`. A local Jev
   `Choice` can classify “notify now / suppress / summarize” from the reply plus run outcome,
   and a `Score` rubric can require delivery or significance evidence. This is a proposal only:
   the current contract always delivers resolved targets and has no significance policy, so
   Jev must not silently alter delivery until a new domain policy is explicit.

3. **Memory candidate scoring.** Memory is admitted into the prompt by
   [`src/adapters/pi/profile-core-inline-extensions.ts:60-93`](../../src/adapters/pi/profile-core-inline-extensions.ts#L60-L93)
   and written through the bounded atomic `memory_write` tool in
   [`src/adapters/pi/pi-agent.ts:740-865`](../../src/adapters/pi/pi-agent.ts#L740-L865). A Jev
   score could rank a proposed fact for durability (specificity, recurrence, user assertion,
   conflict risk) and Noul could independently score whether the same transcript evidence
   supports it. The safe first step is advisory metadata or a review result; it must not become
   a second memory authority or bypass caps/replace-match semantics in `src/domain/memory.ts:191-263`.

4. **Channel triage.** Telegram, Discord, and Slack each have typed admission/normalization and
   per-chat serialized turn seams. Telegram resolves owner/group context before opening a chat
   at [`src/application/gateway.ts:193-228`](../../src/application/gateway.ts#L193-L228);
   Discord rejects non-owner/bot/empty messages in `normalizeDiscordMessage`
   ([`src/application/discord-gateway.ts:211-243`](../../src/application/discord-gateway.ts#L211-L243));
   Slack has `classifySlackMessage`/`normalizeSlackMessage` at
   [`src/application/slack-gateway.ts:333-350`](../../src/application/slack-gateway.ts#L333-L350).
   Jev can choose ignore / queue / answer / request attachment inspection, with Noul scoring
   whether the message is actually addressed to Ziggy. This must run after current owner/bot
   admission and before `agent.openChat`/`handle.prompt`; it cannot weaken authorization,
   context-specific memory admission, cancellation, or per-chat semaphore ownership.

5. **Recall ranking.** Lossless Claw already returns bounded BM25 search results with `rank`,
   snippets, session/role, and active-branch flags at
   [`extensions/lossless-claw/src/store.ts:756-814`](../../extensions/lossless-claw/src/store.ts#L756-L814).
   Jev `Score` can rank candidate memories/sessions for a user query and Noul can independently
   score answer-support truth over the returned snippets. This is a direct extension seam in
   `extensions/lossless-claw/src/store.ts` or its tool adapter, but it remains retrieval/ranking
   metadata: do not promote search results into Profile memory or expose transcript content
   beyond the package's existing bounded tool result.

6. **Structured browser extraction/monitor fields.** The browser-job runner already has typed
   extracted items, stable IDs, per-field selectors, required/optional detail fields, exact
   allowed origins, bounded pagination, and persisted run reports (see
   [`extensions/computer-workflows/src/browser-jobs.ts:225-260`](../../extensions/computer-workflows/src/browser-jobs.ts#L225-L260)
   and `:774-843`). This is the closest literal SDE-cascade seam: parse and schema-check the
   result first, ask Noul one narrowly scoped question per extracted field against the source
   evidence, then escalate only the flagged item/field to a strong model. The existing baseline
   must remain authoritative; a Jev flag can mark a report partial/review-needed but cannot
   silently invent or merge an item.

## Runtime/provider placement and boundaries

Every production runtime is assembled through the Pi adapter: `createProfileRuntime` composes
resources and inline extensions, creates Pi services, then calls
`createAgentSessionFromServices` at [`src/adapters/pi/pi-agent.ts:1202-1346`](../../src/adapters/pi/pi-agent.ts#L1202-L1346).
`ZiggyAgent` delegates to this adapter (`src/application/agent.ts:127-157`), and gateways and
automations call that client-neutral service. This is the right seam for a Jev capability only
if Jev must inspect every provider turn; otherwise keep Jev in the owning extension/application
service above it. Do not add a second agent loop or provider abstraction: the architecture
explicitly assigns loop/provider/session execution to Pi (`docs/research/minimal-ziggy-scout.md:11-15`)
and permits only the Pi adapter to import Pi (`:21-51`).

The profile resource loader admits selected extension factories and skills with Pi discovery
disabled at [`src/adapters/pi/profile-resource-loader.ts:11-52`](../../src/adapters/pi/profile-resource-loader.ts#L11-L52),
and catalog admission is authoritative in `src/adapters/pi/resources.ts:85-137`. A Jev package
should therefore be a selected Profile extension or a Ziggy-owned pure application capability,
with a typed boundary and explicit catalog entry. Nothing here proves Jev is installed, that it
has a compatible TypeScript/Bun API, or that it can evaluate pixels; those are unknowns requiring
separate package/API and latency proof.

## Recommended order

Start with a pure Jev adapter over `run_ui_segment` evidence and the existing workflow compiler;
measure model-turn and wall-clock reduction against the same state/lease tests. Next consider
recall ranking and memory advisory scores. Treat channel triage and automation significance as
policy changes requiring explicit domain schemas and delivery/replay tests. Keep Noul as an
independent evaluator over the same immutable input, and make disagreement a typed stop or
review state rather than a hidden retry.
