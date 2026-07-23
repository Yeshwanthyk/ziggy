# S7 — Elsewhere (Cloudflare, GUI, deferred Gateways)

Stage owner: post-v1 expansion. Depends on S0–S6, especially the semantic World seam and stable
attach protocol. Nothing here may widen the core loop to accommodate a remote backend or Gateway.

## Goal

Prove "local now, Cloudflare later" against the existing contracts, add a GUI and authenticated
remote attach, and deliver the three remaining deferred Merlin transport candidates as
dependency-free leaf Gateway packages.

## Deliverables

- A Cloudflare World implementation that passes the same semantic contract suite as the local
  implementation.
- A GUI Client using the shared attach-protocol client surface.
- An authenticated WebSocket transport for remote attach.
- Three planned leaf Gateway packages: `imsg`, `telephony`, and `wacli`.
  Each depends only on `packages/protocol`, owns no core loop behavior, and mutates Profile state
  only through daemon protocol methods.
- **DECIDE-LATER — per-Session persona pinning.** Voice remains only a starter `SOUL.md` template
  unless a later decision introduces a distinct concept.

Blueprints are not an alternative packaging path. A Gateway either ships as a real leaf package
with deterministic protocol/identity/reconnect coverage or remains planned.

## Design constraints

**World parity.** Remote storage preserves the same Session, Memory, atomicity, and failure
semantics as local storage. A Cloudflare prototype may choose Durable Objects, R2, or KV only after
the contract suite proves the mapping.

**Remote attach is a transport, not a second protocol.** WebSocket framing and authentication wrap
the existing attach protocol. Token issuance, rotation, revocation, and scope must be decided and
tested before an open network listener ships.

**Gateways are leaf Clients.** The three deferred candidates follow the Telegram dependency
direction proven in S6. They do not import `packages/core`, write Profile files, embed a competing
Session loop, or fall back to documentation-only integration artifacts.

**Parallel delivery.** The GUI, World adapter, and individual Gateway packages may proceed in
parallel once their shared protocol contracts are stable. The three Gateways do not gate one
another, but every planned row remains open until its own implementation and review land.

## Verification growth

Add remote-World contract fixtures, authenticated WebSocket peers, GUI protocol drivers, and a
simulated service boundary for each Gateway. Register backend retry/conflict/partial-failure,
sole-writer behavior, credential rejection/revocation, reconnect/replay, Client-only mutation, and
package-boundary scenarios. Each Gateway gets deterministic identity, resume/stream separation,
reconnect, delivery, and failure coverage before live service checks.

## Acceptance criteria

- The Cloudflare World passes the unchanged semantic World contract suite.
- A GUI Client starts/resumes a Session and streams a Turn through the shared protocol surface.
- Remote attach rejects missing, invalid, expired, or revoked credentials before Profile data is
  exposed.
- Each of the three planned Gateway candidates ships as a dependency-free leaf package without a
  core or attach-protocol change made solely for that Gateway.
- `verify:s7` and `verify:all` pass with schema-valid evidence and independent review.

## Implementation order

1. Prototype and lock the Cloudflare World mapping through contract tests.
2. Specify and verify WebSocket authentication before implementing the transport.
3. Build the GUI against the shared Client surface.
4. Implement the three Gateway packages in parallel where files are disjoint; verify each
   independently, then run the integrated S7 gate.

## Non-goals

- Any S7 deliverable blocking the S6 v1 release.
- Multi-tenant hosted Ziggy.
- Blueprint or Extension substitutes for a Gateway.
- Gateway-specific core loop hooks, direct Profile writes, or protocol forks.
