# S7 — Elsewhere (Cloudflare, GUI, more gateways)

Stage owner: post-v1 expansion. This is a sketch, not a build-ready spec — deliberately thinner than S0-S6. Depends on everything before it (in particular the storage/world seam from S1 and the attach protocol from S2 must already be stable). Nothing here should force changes to v1-shipped contracts; if it does, that's a signal S0-S6 under-specified the seam.

## Goal

Prove "local now, Cloudflare later" was actually true: run ziggy's storage/world behind Cloudflare primitives without a rewrite, add a GUI client and a WS-based remote-attach transport, and let additional gateways (Discord, Signal, iMessage) exist either as full leaf packages or as flue-style blueprints, without touching the core loop.

## Deliverables (sketch level)

- A Cloudflare "world" implementation of the storage/filesystem seam (Durable Objects + R2, KV where it fits) that passes the identical behavioral contract-test suite the local filesystem world passes.
- A GUI client (Electron/Tauri/web — DECIDE-AT-BUILD) attaching over the same protocol as the TUI and gateways.
- A WS transport for the attach protocol with bearer-token auth, for remote (non-local-socket) clients — this is the point where "open ports" first become a real v1+ concern, deliberately deferred past v1's socket-only surface (D5).
- Additional gateways: Discord, Signal, iMessage — each either as a `packages/gateway-*` leaf package (if warranted) or as a `blueprints/` markdown guide (if low-traffic/community-maintained is more appropriate).
- `smart-memory` / `smart-extensions` curated extensions fleshed out beyond their S4 scaffolds.
- Possible pi-ai OAuth vendoring for Workers runtime (fetch-based token exchange only — Workers can't run pi-ai's Node-targeted OAuth helpers as-is).
- **DECIDE-LATER — per-Session persona pinning.** Voice means only a starter `SOUL.md` template in v1. If demand emerges, decide later whether Sessions need a distinct persona-pinning concept without overloading Voice.

## Design (decisions carried from earlier stages, plus open questions)

**Contract-tested pluggable backends (flue + eve pattern, locked as a principle, not yet as an implementation).** The storage/world interface is defined once during S0/S1 for the local filesystem; every additional backend (starting with Cloudflare DO/R2) must pass the same behavioral contract-test suite before it's considered viable. This is the concrete mechanism that makes "local now, remote later" credible — it is a testing discipline, not a promise.

**OAuth stays local, tokens are portable (pi-ai lesson).** Login/PKCE flows for Anthropic Pro/Max and OpenAI ChatGPT Plus/Pro run on a local machine (they need a browser redirect); the resulting tokens are just credentials that can be synced/copied to a remote deployment. Cloudflare Workers should not be expected to perform the OAuth dance itself in v1 of this stage — only to consume already-minted tokens, with fetch-based refresh if pi-ai's refresh logic is portable to the Workers runtime (confirm this rather than assuming it).

**DECIDE-AT-BUILD — Cloudflare storage mapping.** Candidate shapes: (a) one Durable Object per profile as the sole writer (mirrors the local one-process-per-profile model closely), backing large blobs (session logs, memory files) in R2 and using DO storage for small/hot state; (b) DO purely as a coordination/lock layer with all actual data in R2. Leans toward (a) for architectural symmetry with the local daemon-owns-the-folder model, but this needs real prototyping against the contract-test suite, not a decision made in the abstract.

**DECIDE-AT-BUILD — GUI stack.** Electron/Tauri (native shell, full filesystem access if running against a local daemon) vs. a pure web app (only viable against a WS-remote-attached daemon, no local-socket option). Likely both matter for different use cases (local power-user GUI vs. remote lightweight web view) but pick one to ship first based on where user demand actually shows up.

**DECIDE-AT-BUILD — WS auth model.** Bearer token is the placeholder assumption; needs a real decision on token issuance/rotation/scoping (per-client? per-device? revocable?) before this is a safe remote-open-port story. Do not ship a WS transport without this resolved — this is the first point in the whole system where a genuinely open network surface exists.

**Gateway packaging choice (Discord/Signal/iMessage).** Not pre-committed to leaf-package-for-all — the S4 blueprints mechanism exists precisely so low-traffic integrations don't need a maintained runtime adapter. Decide per-gateway based on expected usage once there's real signal, rather than building all three speculatively.

## Verification growth

When S7 is scheduled, extend `tests/testkit` with remote-world contract fixtures, deterministic
latency/conflict/failure schedules, authenticated WS peers, GUI protocol drivers, and simulated
Gateway services. Register remote storage retries/conflicts/partial failure, sole-writer behavior,
missing/invalid/revoked WS credentials, reconnect/replay, GUI Client-only mutation, and package-
boundary checks for each additional Gateway. Evidence includes backend contract matrices, fault
schedules, authenticated wire traces, Client render/protocol traces, and replay commands; live
Cloudflare/Gateway checks remain separate. A separate Sol medium agent in an independent run and
context reviews backend semantic drift, open-network data exposure, core/protocol changes, and any
weakening or skipping of inherited contracts.

## Acceptance criteria (directional — firm up when this stage is actually scheduled)

- The Cloudflare world implementation passes 100% of the same contract-test suite the local filesystem world passes, with no test skipped or weakened for the remote backend.
- A GUI client can attach, start a session, send a turn, and receive streamed events using the same attach-protocol client library the TUI uses (proving the protocol package is genuinely transport/UI-agnostic).
- A WS-remote-attached client requires a valid bearer token; an invalid/missing token is rejected before any profile data is exposed.
- At least one additional gateway ships (leaf package or blueprint) without any change to `packages/core` or the attach protocol.
- The harness, S7 plan checklist, and scenario/stage manifests include every landed S7 behavior and negative/concurrency/fault scenario; `verify:s7` and `verify:all` pass with schema-valid redacted evidence and resolved findings from verification/review by a separate Sol medium agent in an independent run and context.

## References to consult

- flue (opensrc: `/Users/yesh/.opensrc/repos/github.com/withastro/flue/main`) and eve (opensrc: `/Users/yesh/.opensrc/repos/github.com/vercel/eve/main`) — contract-tested pluggable backend pattern.
- pi-ai (local: `/Users/yesh/Documents/personal/reference/pi-mono/packages/ai`, npm `@earendil-works/pi-ai`) — OAuth helper implementations to check for Workers-runtime portability.
- codex app-server (opensrc — confirm path) — remote-attach auth patterns, if any, worth comparing against for the WS bearer-token design.
- `docs/plans/s0-foundation.md` (or wherever the storage/world seam is first defined) — the exact interface this stage's Cloudflare implementation must satisfy.
- `docs/plans/s6-reach.md` — the gateway leaf-package pattern this stage's additional gateways follow.

## Suggested agent workflow

This stage should not be worked by agents until S0-S6 are stable and there's real user demand pulling on a specific piece (don't build Cloudflare support speculatively). When it is scheduled, each slice follows the `docs/VERIFICATION.md` through-loop: dedicated Sol medium scouting/task-decomposition run and context → red scenario → separate Sol medium implementation run and context → independent Sol medium deterministic verification/evidence/review run and context. The implementing run must not be the verifying run:

1. Prototype the Cloudflare world against the contract-test suite in isolation (a spike, not a merge-ready PR) to resolve the DECIDE-AT-BUILD storage-mapping question with evidence.
2. WS transport + auth design as its own reviewed-spec slice: a dedicated Sol medium scouting/task-decomposition run and context precedes a separate Sol medium implementation run that authors the spec, then a third, independent Sol medium run and context verifies/reviews it before transport implementation, given it is the first open-network-port surface; applicable findings become deterministic regression scenarios.
3. GUI client as a separate track, parallelizable with the Cloudflare work since both only need the attach protocol to be stable.
4. Additional gateways last, opportunistically, per real demand.

## Non-goals

- Any of this landing before v1 (S6) ships — this stage is explicitly post-v1 per D17.
- Multi-tenant hosted ziggy (one Cloudflare deployment per user's own profile, not a shared multi-tenant service) unless a future decision explicitly revisits this.
- Building all three additional gateways speculatively — ship based on demand, not completeness for its own sake.
