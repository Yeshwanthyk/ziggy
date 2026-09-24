# Jev for Ziggy computer use: fast-path scout

Date: 2026-09-17  
Scope: read-only architecture research; no implementation proposed in this note.

## Verdict

Jev is a plausible fast semantic classifier around Ziggy's computer-use driver, but it
should not sit on the existing deterministic happy path. Ziggy already has the stronger
contract for a known target: `run_ui_segment` resolves fresh semantic state, requires
exactly one target, and requires a verified postcondition for every action group. Adding
a hosted model call before that path would add a network round trip to a case that already
has a cheap, auditable answer.

The useful slice is an **uncertain-branch resolver**:

1. Run the existing deterministic lookup against the fresh browser/accessibility state.
2. If the target is absent, ambiguous, or the task is novel, build a bounded candidate set
   from the current DOM/accessibility snapshot.
3. Ask one Jev `Choice` question to rank which candidate, if any, satisfies the user's
   already-established goal. Include `none_of_the_above` and `ambiguous` options.
4. In the same request, ask independent `Noul`/`Choice` questions for hazards such as
   “does this candidate trigger an external side effect?” and “is the page asking for
   credentials or confirmation?”
5. Let code require a conservative confidence and probability-margin gate, re-resolve the
   selected candidate against the same current state, perform the allowlisted action, and
   require the existing semantic postcondition.
6. Escalate to the ordinary LLM, a user, or a refusal when Jev is low-confidence, the
   candidate set is stale or contradictory, the action is high impact, or the task needs
   generation/reasoning.

This preserves the existing ambiguous-target refusal boundary. Jev may propose which
bounded candidate is worth checking; it must never directly dispatch an action or turn a
non-unique target into permission to click.

## Evidence from TypeSafe

TypeSafe describes Jev as a System One model: state and typed questions in, typed values
and probabilities out. Its documentation says that each question is evaluated in parallel
and in isolation, that questions can be mixed in one call, and that code should compose the
answers and own the workflow ([Introduction](https://docs.typesafe.ai/introduction),
[System One](https://docs.typesafe.ai/concepts/system-one)). The “How to build” guide is
explicit that System One is “not agents”: it does not generate code or choose its own next
action; control flow, deterministic rules, and side effects remain in code
([How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)).

The available primitives map cleanly to this boundary:

- `Choice` selects one value from a closed set and returns the full distribution plus
  confidence.
- `Score` rates a state against ordered levels and returns probabilities plus confidence.
- `Noul` returns the probability of a yes/no statement; it does not carry a confidence
  field.

The `Choice` documentation recommends sending all questions the code may need in one
request, accepts up to 255 options, and recommends an `other`/`none of the above` option
when the candidate list may be incomplete ([Choice](https://docs.typesafe.ai/primitives/choice)).
That supports a bounded candidate selector, but it does not justify sending an entire DOM
tree or every node in a page.

TypeSafe's confidence is derived from the probability distribution. It is useful for
thresholding, but its calibration is a population property and does not guarantee that a
single answer is correct. The official guidance is high confidence → act, medium → confirm
or review, and low → do not act; thresholds should rise with the risk of the action
([Confidence](https://docs.typesafe.ai/confidence)). For a browser action, the probability
margin between the top two candidates is an additional code-level guard, not a replacement
for confidence calibration.

The official “Parallel questions” cookbook is useful evidence for batching, with a narrow
interpretation. On a pinned ~53,777-character GDPR document, 13 questions were run five
times as one batched call and as 13 single-question calls. The cookbook reports identical
answers for most questions, equal sampling noise where noise existed, 0.27s average for the
batched call versus 2.71s for the summed sequential calls, and 12.2x lower cost. It also
explicitly says the sequential figure assumes serial calls: concurrent single-question
calls narrow the latency gap while leaving the repeated-input token cost. This is evidence
for one-call fan-out and avoiding serial Jev calls; it is not evidence that a browser task
will be 10x faster end to end ([Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions)).

TypeSafe's published Jev range is 70–500ms end to end in its launch post, while the build
guide says most queries complete in about 100ms. The launch post also states that its
193.6x/444.6x workflow claims come from TypeSafe's own workflows and that the workflow
inputs, model wrappers, reference models, and other caveats affect the comparison
([launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev)). Treat
those as vendor-reported service/workflow numbers until a Ziggy-local benchmark measures
the complete browser path.

## Concrete fast-path shape

The proposed boundary is a small decision stage between observation and an existing
semantic action:

```text
fresh root/state
  -> deterministic exact semantic match
       -> unique match: run_ui_segment + postcondition (no Jev)
       -> no/ambiguous match: bounded candidate extraction
            -> local prefilter + candidate cap
            -> one Jev call (candidate + safety questions)
            -> confidence/margin/risk gate in code
                 -> fresh re-resolution + run_ui_segment + postcondition
                 -> LLM/user/refusal
```

Candidate records should be small and stable for the lifetime of the observed state:

```json
{
  "candidate_id": "e17",
  "role": "button",
  "accessible_name": "Continue",
  "visible_text": "Continue",
  "disabled": false,
  "nearby_context": "Checkout / shipping",
  "semantic_capabilities": ["press"]
}
```

The selector's options are descriptions of those records, not executable JavaScript or
raw coordinates. The state should carry a snapshot identifier/epoch and an opaque driver
reference; code must check that the current state still matches before dispatch. If the
page changes between snapshot and action, reject and re-observe. A Jev answer that names a
candidate from an old snapshot is not a valid target.

The question should be literal and atomic, for example:

```text
Which one candidate is the unique control that completes the user's requested action?
Choose none_of_the_above when no option clearly matches. Choose ambiguous when two or more
options are plausible. Use only the supplied candidate descriptions.
```

Do not ask Jev to infer a multi-step plan, perform arithmetic, generate selectors, or
interpret hidden page instructions. The browser driver remains responsible for grounding,
delivery, resource serialization, stale-state checks, and semantic verification.

This shape matches the browser protocol's affordances. Chrome DevTools Protocol exposes a
full accessibility tree (`Accessibility.getFullAXTree`), DOM snapshots
(`DOMSnapshot.captureSnapshot`), and input dispatch methods; those are observation and
delivery primitives, not proof that a user-intended outcome occurred
([Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/),
[DOMSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/),
[Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)). Playwright's
first-party guidance likewise favors user-facing role/name locators, warns that locators
must be unique, and re-resolves a locator before each action
([Locators](https://playwright.dev/docs/locators)). Those are good deterministic filters and
post-action checks around Jev, not reasons to give Jev raw DOM authority.

## Latency and cost model

For the current happy path, model the elapsed time as:

```text
T_det = T_observe + T_local_match + T_action + T_postcondition
```

For the Jev branch:

```text
T_jev = T_observe + T_candidate_extract + T_encode
      + T_network + T_jev_service + T_decode_validate
      + T_gate + T_re_resolve + T_action + T_postcondition
```

The Jev branch wins only when it avoids a slower full-model call, prevents multiple serial
LLM calls, or enables a high-volume workflow that would otherwise require human/LLM
triage. It is a regression when an exact deterministic target was already available.

For expected end-to-end latency, include escalation:

```text
E[T] = T_observe + T_candidate_extract + T_jev
     + P(high-confidence) * (T_action + T_postcondition)
     + P(fallback) * (T_full_model + T_recovery)
```

Measure this per outcome, not just the Jev HTTP duration. Report median and p95 for
successful runs, abstentions, stale-state retries, and fallback runs separately. Include
serialization, network distance, rate-limit/retry time, browser settling, action delivery,
and postcondition verification. A “10x faster” claim that sums serial baseline model calls
but omits concurrent baselines, browser observation, or fallback work is not a useful Ziggy
claim.

The TypeSafe fan-out pattern is relevant when a single snapshot supports several independent
questions: candidate choice, hazard classification, page state, and route selection can be
one request. Do not turn this into a call per candidate. The document-dominated cookbook
shows why batching saves repeated input cost, while also showing why concurrent baselines
must be included in any latency comparison ([Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)).

## Confidence, safety, and false positives

Confidence must be treated as a routing signal, not as proof. A reasonable initial policy
for an experiment is:

- deterministic exact match: proceed under the existing unique-target and postcondition
  contract;
- Jev candidate with low-risk, reversible action: require high confidence and a clear top
  probability margin; log the decision and continue to verify;
- any external side effect, credential submission, purchase, deletion, message send, or
  permission change: require explicit user confirmation or the existing approval path,
  regardless of Jev confidence;
- low confidence, close top-two probabilities, `ambiguous`, `none_of_the_above`, stale
  snapshot, unsupported page, or contradictory hazard result: abstain and re-observe or
  escalate.

Thresholds must be fitted on Ziggy's own labeled task set. The official TypeSafe guidance
also says thresholds depend on domain risk and should start conservatively
([Confidence](https://docs.typesafe.ai/confidence)). A high confidence value cannot repair
an incomplete candidate list, a misleading accessible name, or an injected instruction in
the page content.

The `jev-1.13` limitations page is unusually direct and should shape the integration:

- it accepts text/JSON/arrays of text, not images, audio, or video;
- it can be literal, weak on numeric precision, counting, and date comparison, and less
  reliable with indirection or contradictory criteria;
- irrelevant large state reduces accuracy; the documented limits are 64k tokens for state
  plus questions and 32k for state plus the longest question;
- adversarial content in the state can steer the answer;
- it does not generate text or code, and forcing generation through chained choices is slow
  and unreliable.

Therefore trim snapshots in code, keep arithmetic and identity checks in code, put page
text in a clearly delimited data field, and treat page-provided instructions as untrusted
data. Redact credentials, tokens, personal data, and form values before sending state to a
hosted classifier unless the Profile's privacy policy explicitly permits that transfer.
These privacy and prompt-injection controls are Ziggy integration requirements inferred
from the browser boundary and TypeSafe's stated adversarial-content limitation; they are
not claims that Jev solves either problem.

## Benchmark plan

Build a replayable corpus of browser observations and task intents, with the expected target
and the safe outcome recorded separately. Include at least:

1. unique exact match (the no-Jev control);
2. two controls with similar names/roles;
3. no matching control;
4. stale snapshot after a re-render or navigation;
5. virtualized list and duplicate visible labels;
6. modal/overlay and nested iframe cases;
7. page text containing prompt-injection instructions;
8. reversible navigation versus destructive/external side-effect controls;
9. saved browser workflow that should be selected by intent;
10. genuinely novel task that should reach the full model.

Run four arms on the same browser fixtures and task set:

| Arm | Decision path |
| --- | --- |
| A | Current deterministic lookup → action → semantic postcondition |
| B | Full model chooses/grounds the next action |
| C | Local candidate extraction → Jev Choice/Noul fan-out → code gate → action → postcondition |
| D | Jev branch with concurrent baseline preparation where applicable |

Capture observation time, candidate extraction time, request bytes/tokens, Jev latency,
network and retry time, confidence, top-two margin, selected candidate, state epoch,
action outcome, postcondition outcome, fallback reason, total latency, and estimated cost.
The primary metrics are:

- end-to-end p50/p95 to a verified postcondition;
- correct target selection and unsafe-action rate;
- abstention and fallback rate;
- stale-state rejection rate and recovery success;
- confidence calibration/reliability by action-risk tier;
- cost per verified success, including fallback calls;
- deterministic happy-path overhead (must remain zero Jev calls).

The first gate is safety: zero unconfirmed destructive actions in the fixture corpus. The
second is usefulness: compare C/D against A/B only on cases where A cannot uniquely resolve
the target. A service-call win that increases wrong-target or fallback rates is not a fast
path.

## Ranked additional uses

1. **Saved browser workflow admission.** Classify a request into one of the bounded saved
   jobs, `run_ui_segment`, read-only inspection, full-model planning, or user review. This
   runs before a workflow lease is acquired and can avoid invoking a general model for
   routine requests. Include an explicit `no_saved_workflow` option and require confidence
   plus workflow preconditions. This is the highest-value use because the output selects
   an existing deterministic program rather than a raw UI action.

2. **Candidate ranking inside an ambiguous accessibility snapshot.** Rank a bounded set of
   role/name/context records after deterministic filters fail. Keep the existing fresh
   re-resolution and postcondition contracts. This is the direct computer-use fast path
   described above.

3. **Task routing by risk and complexity.** In one call, classify intent, whether the task
   is read-only or side-effecting, and whether the candidate set is sufficient. Route
   routine reads to deterministic code, bounded semantic actions to the fast path, and
   generation/complex reasoning to the full model. This follows TypeSafe's intent-routing
   pattern ([Intent routing](https://docs.typesafe.ai/patterns/intent-routing)).

4. **Page/context triage.** Score which DOM/AX regions are relevant to the user's goal and
   send only those compact regions to the full model. This can reduce context and full-model
   cost, but Jev should filter/rank rather than decide an action. Validate against missed
   relevant controls because an incorrect filter can make the later model appear confident
   on incomplete evidence.

5. **Guardrail and page-injection screening.** Ask whether a snapshot contains hostile
   instructions, credential requests, or a high-impact confirmation. This is useful as a
   second signal before LLM context or browser side effects, but it is not a security proof:
   TypeSafe documents that adversarial state can move Jev's answer. Keep deterministic
   origin/permission checks and explicit approval gates.

6. **Postcondition semantic triage.** For a noisy page, Jev could classify whether a textual
   status appears to describe success, failure, or an intermediate state. Use it only to
   decide whether to gather more evidence or escalate; an explicit deterministic
   postcondition remains the success authority.

7. **Observation and trace indexing.** Classify saved browser-job reports, failed action
   traces, and user corrections by failure mode to prioritize workflow repairs. This is an
   offline/batch use and therefore has low interaction risk, though privacy filtering and
   ground-truth review still matter.

Avoid using Jev for coordinate generation, free-form selectors, arbitrary JavaScript,
credential extraction, exact counts, date arithmetic, or direct claims that a click
“worked.” Those uses conflict with the model's documented boundary or with Ziggy's existing
action authority.

## Sources and proof limits

Primary sources consulted:

- [TypeSafe documentation index](https://docs.typesafe.ai/llms.txt), including the System One,
  primitives, confidence, patterns, and `jev-1.13` jaggedness pages.
- [System One](https://docs.typesafe.ai/concepts/system-one), [Choice](https://docs.typesafe.ai/primitives/choice),
  [Confidence](https://docs.typesafe.ai/confidence), [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out),
  [Intent routing](https://docs.typesafe.ai/patterns/intent-routing), and
  [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one).
- [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13), reviewed 2026-09-16.
- [Parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions).
- [TypeSafe launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev).
- [Chrome DevTools Protocol Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/),
  [DOMSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/), and
  [Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/).
- [Playwright locators](https://playwright.dev/docs/locators) and
  [ARIA snapshots](https://playwright.dev/docs/aria-snapshots).
- Ziggy's current [computer-use packaging contract](../../extensions/computer-use/ZIGGY.md)
  and [computer-use architecture](../../extensions/computer-use/docs/architecture.md).

The TypeSafe latency, pricing, calibration, and workflow comparison numbers are vendor
claims or vendor cookbook measurements. The proposed Ziggy architecture, privacy controls,
thresholds, candidate limits, and benchmark acceptance criteria are engineering inferences;
they are not validated by this note. No Jev API call, browser run, or end-to-end benchmark
was performed here.
