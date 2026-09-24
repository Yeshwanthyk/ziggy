# Jev / TypeSafe API scout

Research date: 2026-09-17. Sources are the current TypeSafe documentation and the
TypeSafe-maintained SDK repositories. This note separates provider claims from
implementation inferences and from measured proof.

## Decision

Jev is useful as a fast, typed **judgment/routing step** inside a computer-use
loop or other workflow. It is not a screenshot-capable computer-use model: the
official documentation says Jev accepts text only, with state represented as a
string, JSON object, or array; images, audio, and video are unsupported.

For computer use, the viable design is an adapter that turns an accessibility
tree, OCR result, DOM/role/name/value snapshot, and current task text into a
compact textual/structured `state`. Ask Jev to choose among stable element IDs
and a closed set of allowed actions, or to answer safety/confirmation questions.
The executor remains deterministic and owns coordinates, keyboard/mouse calls,
permissions, retries, and post-action verification. This is an inference from
the input and output contracts, not a TypeSafe-documented computer-use
integration.

## API and input contract

The HTTP endpoint is:

```text
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

The request has required `state`, `model`, and `questions` fields. `state` may
be a string, object, or array. `model` can be `jev-latest` (the SDK default) or
a versioned ID such as `jev-1.13.0`. Each question has an ID, `type`, and
`instructions`; Choice and Score also require `criteria`. The question ID is
used to key the response and is not sent to the underlying model.

Jev currently accepts text only. The docs explicitly say that images, audio,
and video are not supported. The structured-object examples can carry related
records and application state, but this does not make arbitrary binary or
screen pixels an accepted modality. For a UI adapter, include only the textual
representation needed for the decision and use stable IDs in the state, for
example `button_id: "submit-payment"`, so a Choice can return an ID rather
than an unconstrained coordinate.

Primary references:

- [System One](https://docs.typesafe.ai/concepts/system-one) (text-only boundary,
  typed answers, no generated explanations)
- [State](https://docs.typesafe.ai/concepts/state) (string/object/array state)
- [API reference](https://docs.typesafe.ai/api) (HTTP endpoint and request/response
  schemas)

## Choice, Score, and Noul

All three can be sent in one request. TypeSafe says questions share the same
state, are evaluated independently/in parallel, and return typed answers under
the supplied IDs.

| Primitive | Use it for | Request schema | Response |
| --- | --- | --- | --- |
| `Choice` | One item from a fixed, unordered set | `type: "choice"`, `instructions`, `criteria: {option: description \| null}` | `choice`, `probabilities` for every option, `confidence` |
| `Score` | A position on an ordered rubric | `type: "score"`, `instructions`, `criteria: [level, ...]` (at least two levels) | `score` (probability-weighted and may be between levels), `legend`, `probabilities`, `confidence` |
| `Noul` | A clearly defined yes/no question | `type: "noul"`, `instructions`, optional `{true, false}` criteria | `noul` from 0 (no) to 1 (yes); no separate confidence |

For a UI loop, a reasonable inferred mapping is `Choice` for the next action or
target (enumerate safe candidates), `Noul` for questions such as “does this
action require confirmation?”, and `Score` for an ordered notion such as
ambiguity or urgency. The model cannot invent a new action safely: the
executor should reject an answer whose option is not in its local action map.

The [primitives guide](https://docs.typesafe.ai/primitives) says to keep each
question atomic and compose independent judgments in application code. The
[API reference](https://docs.typesafe.ai/api) documents exact answer fields and
that Choice probabilities sum to 1. Questions whose answer depends on another
answer require a second request; otherwise batch them together.

## Confidence and limitations

`Choice` and `Score` include a 0–1 `confidence` derived from the returned
probability distribution. TypeSafe describes it as a summary of how peaked the
distribution is and also returns the full distribution so callers can choose a
different statistic. Noul exposes only its yes probability. TypeSafe says its
calibration is measured across groups of predictions and **does not guarantee
that an individual answer is correct**.

Use confidence as a risk gate, not as proof. The provider’s guidance is to act
automatically only at a threshold suitable for the action, ask for confirmation
or review in a middle range, and do not act at low confidence; thresholds must
be tested on the application’s own data and scaled to the consequences of an
error. For consequential computer actions, preserve the existing authorization
policy and post-action state checks even when Jev is confident. A model score
never grants authorization.

The [Confidence page](https://docs.typesafe.ai/confidence) also says its exact
confidence computation is not specified there. Therefore, do not compare a
confidence value across changing model versions or domains without local
validation. Pin a versioned model ID when stable behavior matters: the
`jev-latest` alias can move, while the response reports the version that
answered.

## Latency, batching, limits, and cost

TypeSafe’s product claim is that Jev is built for fast, focused judgments. A
provider-published [parallel-questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions)
reports a 13-question, approximately 54,000-character workload measured over
five repeats: one batched request averaged **$0.000497 and 0.27 s**, while 13
single-question requests averaged **$0.006090 and 2.71 s**—reported as 12.2×
cheaper and 10.0× faster. The cookbook says the calls used `perf_counter`, but
these are TypeSafe’s own environment/results, not an independent benchmark or
a guarantee for a UI loop. It also notes that sequential single-call timing
assumes no concurrency; batching retains the token saving either way.

The current [Models page](https://docs.typesafe.ai/models) lists Jev 1.13
(`jev-1.13.0`) at **$42 per billion input tokens ($0.042/Mtok)**, with output
tokens free, and a stated limit of **250,000 tokens/second and 1,200
requests/minute**. The same page warns that rate limits are adjusted
dynamically and can change without notice; higher limits are available on
custom/enterprise plans. Treat the price and limits as current documentation,
not a durable contract.

The documented request budget is around 32,000 tokens shared by state and
questions (roughly 150,000 English characters), so accessibility snapshots need
compaction and bounded candidate lists. The API returns `401`, `422`, `429`, or
`529` for documented failure classes. `429`/`529` should use exponential
backoff; the official SDKs do this by default and honor `retry-after` when
present.

## SDK availability

There are first-party SDKs for Python and JavaScript/TypeScript, plus the raw
HTTP API for any language:

- Python: `uv add typesafe-sdk` or `pip install typesafe-sdk`; synchronous and
  asynchronous clients, `TypeSafeClient` / `AsyncTypeSafeClient`.
  [Official SDK docs](https://docs.typesafe.ai/sdk/python) and
  [official repository](https://github.com/typesafe-ai/typesafe-sdk-python).
- JavaScript/TypeScript: `npm install @typesafe-ai/sdk`; Node.js 20+; ESM,
  CommonJS, and TypeScript declarations. The official client infers answer
  types from the questions. [Official repository](https://github.com/typesafe-ai/typesafe-sdk-js).
- Raw API: [Quick start](https://docs.typesafe.ai/introduction/quickstart) and
  [API reference](https://docs.typesafe.ai/api).

For Ziggy/Bun, the TypeScript SDK is the natural first integration candidate,
but the repository README explicitly states a Node.js 20+ requirement. Whether
it runs unchanged on Bun, and its actual timeout/retry behavior in Ziggy’s
runtime, should be proven by a small isolated live call; this scout did not
perform that call.

## Good fits beyond computer use

The documented primitives fit classification/routing, policy checks, triage,
rubric scoring, and confidence-gated escalation. The provider’s smart-home
demo pairs TypeSafe for fast routing with an LLM only when free-form text
generation is needed. Jev itself does not generate replies, code, or reasoning
explanations, so it should sit before a generative model or deterministic tool
executor rather than replace either one.

The [agent skill page](https://docs.typesafe.ai/agent-skill) is available for
Codex/Claude Code/other agents and recommends keeping questions and thresholds
in one reviewable place. That is useful operational guidance, but installing a
skill does not add screenshot support or change the API’s text-only contract.

## Decisive limitations and proof gaps

- No screenshot, image, audio, or video input; a separate OCR/accessibility/DOM
  capture layer is required for computer use.
- No free-form response or rationale; answers are constrained judgments. A
  separate LLM or deterministic code must produce explanations and perform
  actions.
- Confidence is not individual correctness and its exact statistic is not
  specified in the public confidence page. Calibrate thresholds on real UI
  tasks and keep a human confirmation path for consequential actions.
- The published latency result is a vendor cookbook benchmark, not proof of
  end-to-end capture + API + action latency on this machine or network.
- Rate limits are explicitly dynamic. The SDKs are documented, but Bun
  compatibility and Ziggy-specific operational behavior still need a live,
  isolated smoke test.
