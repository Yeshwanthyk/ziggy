# Jev opportunities for Ziggy — September 2026

Research date: **2026-09-18**. Coverage ends on that date, not the end of September. This is research and product direction, not an implementation or a live API evaluation.

Read alongside [the capability and evidence report](jev-capabilities-september-2026.md). Existing September 17 scouts were treated as leads and left unchanged. All feature proposals below are **inferences**, not claims that TypeSafe or Ziggy already ships them.

## Recommendation

Use Jev as an optional, bounded **semantic decision service**, not a new agent loop, chat provider, autonomous computer operator, or security authority.

The larger opportunity is not merely cheaper chat. It is making many small semantic judgments economical: deciding which changes matter, which extracted facts need review, which evidence supports a conclusion, and which failed jobs need attention. A generative model remains responsible for open-ended reasoning, writing, and proposing repairs; deterministic Ziggy code remains responsible for permissions, exact calculations, execution, and durable state.

**Best first product experiment: an evidence review inbox for browser monitoring.** Start in shadow mode, score field-level evidence, and expose useful review decisions without changing delivery or action policies. This exercises a real existing extension boundary and can evolve into genuinely new semantic monitoring. A skill recommender is a smaller alternative if the immediate goal is faster proof with lower data sensitivity.

## What enables this

The [current model documentation](https://docs.typesafe.ai/models) lists `jev-1.13.0`, text-only inputs, $0.042 per million input tokens and free output tokens. The request budget is **64k total**, with a second limit of **32k for state plus the longest question**. Questions share state and can be evaluated in parallel. Rate limits are dynamic; these are observed vendor terms, not a durable capacity commitment.

The [primitives](https://docs.typesafe.ai/primitives) support:

- **Choice:** select from developer-supplied options, with option probabilities and confidence. Include `none`, `insufficient evidence`, or `review` when appropriate.
- **Score:** judge against ordered descriptive levels. This is a rubric expectation, not an exact measured quantity.
- **Noul:** a yes/no probability. It is a question type in Jev, **not a separate independent verifier model**.

Those outputs can power decisions and UI filters directly. They cannot create arbitrary text, discover facts outside the supplied evidence, or turn a missing candidate into a valid answer. Candidate generation and evidence collection are part of the product.

The vendor's [jaggedness page](https://docs.typesafe.ai/model-jaggedness/jev-1.13), reviewed September 17, explicitly warns about counting, arithmetic, date comparisons, indirection, irrelevant context, adversarial input, and inconsistent probability identities across question formulations. Two Jev questions agreeing is not two independent sources proving a fact.

## Ziggy's actual starting point

Ziggy is a local-first, Profile-owned assistant, not an existing multi-tenant SaaS admin console. “Customer-facing” below means the Profile owner and admitted channel users; “admin” means the owner/operator and maintainers. A fleet dashboard would be new product scope.

| Existing asset | Source inspected | Implication |
|---|---|---|
| One Pi-owned loop; Profile policy and composition belong to Ziggy | [Architecture specification](minimal-ziggy-scout.md) | Add a capability or selected extension, not a competing provider/session engine. |
| Catalogued computer workflows, browser tools, recall, notes, reminders, Google and GitHub integrations | [catalog.json](../../catalog.json) | There are plausible evidence sources and action destinations; a catalog entry alone does not establish configured credentials or granted permissions. |
| Workflow compiler emits bounded semantic segments and explicit manual steps | [execution-plan.ts](../../extensions/computer-workflows/src/execution-plan.ts) | Classify evidence around execution; never convert a prohibited/manual step into an allowed action through a score. |
| Automation gate, run outcomes and target delivery | [automations.ts](../../src/application/automations.ts) | Add semantic classification after the deterministic gate. Existing delivery is not silently suppressible. |
| Read-only diagnostic checks | [doctor.ts](../../src/application/doctor.ts) | Semantic failure grouping can supplement exact diagnostics, not replace them. |
| Management operations for models, memory, extensions and automations | [management.ts](../../src/application/ui-gateway/management.ts) | A review surface has an existing application seam, but its UI and new domain policy would still need building. |

## New user-facing capabilities

### 1. Semantic watchlists: “tell me when this matters,” not “when bytes change”

**Experience:** A user watches release notes, a supplier page, a project issue stream, or a document. Ziggy distinguishes a meaningful availability change, breaking change, deadline announcement, or newly relevant opportunity from cosmetic edits.

**Pipeline:** authorized scheduled fetch → deterministic changed-content gate → bounded before/after evidence → Noul questions for specific user interests + Score for relevance → notification/review/digest policy → optional generative explanation with source links.

**Why Jev:** the judgment is small but repeated across many updates; generation is needed only for the handful worth explaining. The primitives and [composite scoring pattern](https://docs.typesafe.ai/patterns/composite-scoring) make the approach plausible, not proven.

**New work:** persisted watch definitions, user-visible significance rules, baseline/change identity and a review queue. Do not add idle model polling. Date ordering and prices are computed in code, not inferred by Jev.

**Success:** relevant-change recall, missed-important-change rate, notifications per useful event, and total spend versus deterministic diffs plus the current model.

### 2. Evidence review inbox

**Experience:** Instead of “job completed,” Ziggy shows extracted records with statuses such as supported, conflicting, missing source, or needs review. The owner opens the exact source excerpt and corrects only questionable records.

**Pipeline:** browser-job output → schema/exact checks → one narrow question per disputed field against its source → per-record escalation → owner or generative repair proposal → deterministic revalidation.

**Why Jev:** the vendor's [SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade) and [citation checking](https://docs.typesafe.ai/cookbooks/citation_check) demonstrate related patterns. They do not establish accuracy on Ziggy's browser data.

**New work:** evidence references, explicit review statuses and correction flow. Missing evidence must remain missing; a high confidence value must not manufacture provenance. One serious field failure cannot be averaged away by several good fields.

**Success:** material-error recall, unnecessary reviews, review time and cost per accepted record. Start here because no automatic action is necessary to demonstrate value.

### 3. Commitment and reminder candidates

**Experience:** On an authorized interaction, Ziggy proposes “You promised to send this Friday; make a reminder?” with the exact supporting message. It can distinguish a request, a tentative plan and an actual commitment.

**Pipeline:** scoped transcript excerpt → commitment Noul → Choice over known people/projects and parsed date candidates → deterministic timezone/calendar resolution → confirmation → existing reminder/calendar tool.

**Why Jev:** [date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook) and [pre-parsed value selection](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook) support bounded extraction. Arbitrary new names or event prose still require parsing or generation.

**New work:** explicit opt-in, duplicate detection, expiry and correction. Negations, jokes, quoted messages and “next Friday” require tests. Never silently create obligations or transfer private-message memory into a group.

### 4. A contradiction-aware personal evidence library

**Experience:** Search results are grouped as supports, contradicts, outdated, or insufficient rather than merely relevant. The user can see that two notes disagree before asking Ziggy for an answer.

**Pipeline:** existing recall/search shortlist → source-scoped relevance and relationship judgments → ranked evidence view → generative answer grounded in selected passages.

**Why Jev:** [RAG passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages), [reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe) and [semantic line search](https://docs.typesafe.ai/cookbooks/semantic_find) are concrete vendor examples.

**New work:** contradiction display and provenance links, not a second memory store. A ranking model cannot recover material omitted by retrieval. Temporal validity must use known timestamps and explicit policy.

### 5. A semantic command palette

**Experience:** A user writes “show the jobs that need me” or “which of my installed tools can help with this?” and gets an appropriate existing command or skill suggestion, including “none fits.”

**Pipeline:** admitted request → shortlist approved commands/selected skills → Choice plus absolute applicability questions → offer a suggestion or route a read-only command; consequential actions retain confirmation.

**Evidence:** TypeSafe's [skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion) reports wrong-skill loads falling from 16.8% to 7.3% over 488 requests with a Hermes roster and Claude Haiku. That is a vendor result using `jev-1.12`, not a Ziggy/Pi or Jev 1.13 result.

**New work:** an optional recommendation surface. Keep catalog admission authoritative and preserve the main model's ability to reject the suggestion. Avoid adding two network calls to every trivial turn without measuring net benefit.

### 6. User-defined review rules without a full agent run

**Experience:** A Profile owner defines a rule such as “flag incoming proposals that lack a concrete next step” or “review drafts that state an unsupported deadline.” Results appear as badges and filters, with the rule visible and editable.

**Pipeline:** a fixed, approved question template plus user rubric → bounded authorized document → typed judgment → review state. A generative model can help draft the rule, but the owner approves it before activation.

**New work:** rule versioning, examples, dry-run previews, rollback and a budget. This is not permission to let arbitrary external documents rewrite policy. Natural-language rules are probabilistic, not equivalent to executable validation.

## New operator/backend capabilities

| Opportunity | Concrete implementation shape | Value and essential limit |
|---|---|---|
| **Exception workbench** | Combine exact automation failure codes with redacted recent evidence; classify expired authorization, changed UI, missing input, ambiguous outcome or transient failure. Show a suggested next diagnostic. | Faster owner intervention. Never reinterpret unknown execution as success or retry a potentially completed payment/send. |
| **Shadow release evaluation** | Run fixed semantic rubrics on an opt-in labelled corpus before changing prompts, skills or model versions; track disagreement and human overrides. | Detect behavioral regressions beyond typechecks. Jev must not be sole judge of a change that uses Jev; retain deterministic checks and blinded human labels. |
| **Memory maintenance proposals** | Identify candidate duplicates, contradictions and low-evidence facts; show atomic proposed edits with source references. | Gives owners a reviewable memory-maintenance tool. Do not auto-merge people or overwrite human-owned Profile files. |
| **Evidence-based quality observability** | Classify completed, consented runs for unsupported completion claims, unresolved user asks or missing evidence. Aggregate labels locally. | Turns unstructured outcomes into inspectable failure categories. This is new telemetry scope, not permission to export all session transcripts. |
| **Feedback-trained prioritization** | Use Jev rubric probabilities as features and, after enough owner labels, train a small downstream ranking model for the review inbox. | Personalization without fine-tuning Jev. The [autoresearch cookbook](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery) demonstrates the feature pattern on wine reviews, not assistant outcomes. Avoid this complexity until fixed rubrics show value. |
| **Selective expensive-model escalation** | A small extractor or deterministic parser proposes candidates; Jev flags uncertain or unsupported fields; a stronger model sees only flagged records. | Lower cost while preserving review quality. Account for errors accepted by the verifier and correlated failures between stages; this is optimization rather than a new feature by itself. |

Administrative scoring should initially be advisory. A detected suspicious passage can trigger review, but the vendor explicitly documents susceptibility to adversarial state. It is not a reliable prompt-injection firewall or DLP/security boundary.

## Prioritization

| Candidate | User value | Integration scope | Error consequence | Recommendation |
|---|---|---|---|---|
| Evidence inbox for one browser job | High, visible trust benefit | Medium | Low in review-only mode | **First product pilot** |
| Skill/command suggestion | Medium | Small–medium | Low if advisory | Fast technical proof alternative |
| Exception workbench | High for active automation users | Medium | Low if advisory | Second pilot |
| Semantic watchlists | High, genuinely new behavior | Medium–large | Missed important updates | Build after inbox quality is known |
| Commitment suggestions | Potentially high | Medium–large | Incorrect obligations/privacy | Opt-in, always confirm first |
| Autonomous workflow repair | High potential | Large | Duplicate/unsafe actions | Defer |
| Universal security gate or autonomous memory rewrites | Misleading value proposition | Large | High | Do not pursue on current evidence |

## Architecture and privacy

```text
User request or passed deterministic wake-gate
  → existing admission, authorization and context isolation
  → collect bounded evidence and deterministic candidate IDs
  → optional Jev decision adapter
  → validate response against the exact question/candidate version
  → application policy: suggest / review / escalate / continue
  → existing Pi generation or deterministic executor
  → existing postconditions and durable outcomes
```

For the first browser pilot, keep ownership in the computer-workflows extension and expose a bounded evaluation operation. Promote to a shared Effect-shaped application capability only if multiple core callers justify it. The existing Pi adapter remains the sole core Pi import boundary; do not add a competing session engine.

Any implementation must load the repository's Effect boundary guidance. Validate external responses once, preserve cancellation, set a total deadline/retry budget, pin the model and question version, cap state size, and use typed unavailable/timeout/invalid-response outcomes. Do not treat missing API results as a negative judgment.

Profile consent must cover which content leaves the machine. Send selected evidence, not `SOUL.md`, entire sessions, credentials, or unrelated private memory. Keep user/group scope fences intact. TypeSafe [states it does not train on customer requests/responses](https://docs.typesafe.ai/models), but no-training is not no-retention; settle account-specific storage, subprocessors, residency and deletion terms before private production traffic. Vendor documentation associates ZDR with enterprise plans.

Keep compact decision metadata with the owning run/report: model, question version, evidence identifier, raw answer, applied policy and user correction. Do not introduce a second writable history or memory authority. Preserve source excerpts only under an explicit bounded retention policy; hashes alone cannot make future audit possible if the source disappears.

Fallback is feature-specific: skip an optional skill suggestion; mark an inbox item unevaluated; preserve baseline notification behavior; stop before a consequential uncertain action. One global fail-open/fail-closed setting is not enough.

## Economics: cheap judgments, not automatically cheap workflows

At the documented input rate, an illustrative **3,000 billed input-token request costs $0.000126**. Ten thousand such requests cost **$1.26**, excluding generation, source fetching, retries, storage, taxes and human review. This is arithmetic from the published price, not measured usage or a quote.

Batch independent questions over the same relevant state where it reduces repeated input. Do not pad every request with the entire Profile. Dependent questions still require another stage, and waiting for Jev can make already-fast deterministic actions slower.

Measure:

`total cost = collection + Jev + escalated generation + retries + human review`

`end-to-end latency = collection + decision stages + execution + verification`

The vendor's “up to” speed/cost comparisons are not whole-product multipliers. The important frontier is **review coverage at an acceptable error rate**, not the cheapest model call.

## A bounded proof before adoption

1. **Choose one real task:** field evidence review on one browser-job shape. Use synthetic or explicitly approved redacted data; no production upload merely to try the SDK.
2. **Create a small labelled set:** about 200–300 records spanning correct, missing, contradictory, changed-layout, injected-text, negated, numeric/date and ambiguous cases. Keep a separate held-out set; never tune thresholds on the test set.
3. **Compare four baselines:** deterministic checks alone; current generative reviewer; Jev alone as reviewer; deterministic checks plus Jev plus escalation. Use the same evidence and record false negatives as well as accuracy.
4. **Choose the operating point:** optimize material-error recall and review burden, not an arbitrary confidence threshold. Slice results by field type and failure class. Abstain on missing evidence. A small pilot does not establish rare-event safety.
5. **Exercise failure handling:** timeout, cancellation, malformed or missing answers, rate limiting, stale candidate IDs, unavailable provider and model-version changes. Verify no mutation or delivery policy changes in shadow mode.
6. **Shadow on opted-in jobs:** retain baseline behavior. Measure p50/p95 added latency, actual billed tokens, escalation rate, accepted-error rate and owner corrections. Confirm Bun compatibility and SDK retry behavior through an isolated authorized smoke test.
7. **Go/no-go:** ship advisory review only if it offers a useful cost/quality or review-time improvement over the baseline. Automatic actions require a separate risk-specific evaluation and explicit policy change.

No universal confidence threshold, SLA, production savings, or safety claim is established by this research. No Jev API calls or code changes were performed.
