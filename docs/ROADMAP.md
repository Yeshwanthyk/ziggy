# Ziggy Roadmap — S0 through S7

Ziggy remains private until the user explicitly says to make the repository public. The Apache-2.0 license choice is unchanged. Each stage is built hand-in-hand with AI agents under the authority and through-loop defined in [VERIFICATION.md](VERIFICATION.md): separate Sol medium runs and contexts scout/decompose the work, implement against red deterministic scenarios, and independently verify/review every slice and integrated stage; the implementing run is never the verifying run. S0 establishes infrastructure only; later stages ship incrementally usable behavior.

Binary releases (GitHub Releases, macOS arm64 + Linux x64/arm64, curl install script) and the public announcement remain deferred until **v1**, which ships immediately after S6, unless separately changed. Repository visibility is a separate decision and stays private until explicitly changed by the user.

| Stage | Name       | One-line goal                                                                                      | Plan                                       |
| ----- | ---------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| S0    | Foundation | Bun workspace, tooling, Effect v4 submodule, and contract-test harness exist and pass verification | [s0-foundation.md](plans/s0-foundation.md) |
| S1    | Waist      | The session engine and memory subsystem work headless, against a faux provider                     | [s1-waist.md](plans/s1-waist.md)           |
| S2    | Daemon     | Ziggy runs as a resident per-profile service with a working attach socket                          | [s2-daemon.md](plans/s2-daemon.md)         |
| S3    | Face       | `ziggy init` scaffolds a profile; a real TUI and CLI can talk to a real provider                   | [s3-face.md](plans/s3-face.md)             |
| S4    | Molding    | Ziggy-native Extensions, blueprints, and closed review of Merlin candidates with S4-owned ports    | [s4-molding.md](plans/s4-molding.md)       |
| S5    | Autonomy   | Automations: wake-gates, fresh-session-per-run, broadcast rules, observable as ordinary sessions   | [s5-autonomy.md](plans/s5-autonomy.md)     |
| S6    | Reach      | First gateway (Telegram) proves the dependency-free leaf-client pattern — **v1 release line**      | [s6-reach.md](plans/s6-reach.md)           |
| S7    | Elsewhere  | Cloudflare world adapter, GUI client, more gateways — all post-v1                                  | [s7-elsewhere.md](plans/s7-elsewhere.md)   |

## Current checkpoint

Tracked verification manifests are the status authority. S0 through S3 are `implemented`; S4 is
`pending`. The S4 Extension contract, version/manifest validation, Skill loader, daemon lifecycle,
approval/seal recovery, compiled `defineTool` boundary, 47-row Merlin ledger, HyperFrames
Blueprint, baked-in skill-writing Skill, inert `smart-memory`/`smart-extensions` scaffolds, and the
generic supervised Command boundary are implemented. The ledger currently has two landed,
independently reviewed S4 candidates: `hyperframes` and `skill-creator`.

S4 still has 33 planned S4-owned candidate rows: 14 `skill-only` and 19
`supervised-command`. The callable, daemon-supervised Command boundary now exists; `executor` is
the first command-based canary on the critical path, while Skill-only candidate waves can proceed
in parallel. S4 closes only after the remaining accepted waves and the integrated `verify:s4`,
`verify:all`, and `bun run check` review pass.

## Sequencing rules

1. **No stage starts before the prior stage is done.** That means its acceptance criteria pass, its deterministic verifier and all predecessor gates pass, its evidence is replayable, and its required agentic through-loop is complete. S2 depends on S1's real session engine; S3 depends on S2's real attach socket.
2. **Deterministic gates are cumulative and authoritative.** `verify:sN` includes required predecessor gates; `verify:all` is the local hard correctness gate while the repository is private. Hosted CI remains disabled until the user explicitly restores it near publication. AI verification cannot waive failures and must turn applicable findings into deterministic regression scenarios. See [VERIFICATION.md](VERIFICATION.md).
3. **Every stage plan is self-contained.** An agent picking up `docs/plans/sN-*.md` should need only that file, `AGENTS.md` (vocabulary contract), `docs/CONSTITUTION.md` (invariants), `docs/DECISIONS.md` (locked decisions), `docs/VERIFICATION.md` (verification policy), and `docs/REFERENCES.md` (source repos) to execute — not the full chat history that produced the design.
4. **"Done when" is reproducible, not vibes.** Acceptance criteria require manifest-registered deterministic scenarios, focused and full gates, schema-valid redacted evidence, and verification/review by a separate Sol medium agent in an independent run and context. Manual or live-integration checks may add confidence but never replace deterministic proof.
5. **v1 is S6, not S7.** Cloudflare, GUI, and additional gateways are explicitly post-v1 scope — do not let S6 scope-creep into them.

See [docs/NORTH-STAR.md](NORTH-STAR.md) for the vision, [docs/CONSTITUTION.md](CONSTITUTION.md) for the invariants every stage must uphold, [docs/DECISIONS.md](DECISIONS.md) for the full decision log with rationale, [docs/VERIFICATION.md](VERIFICATION.md) for the cross-stage proof policy, and [docs/REFERENCES.md](REFERENCES.md) for the source repositories every design choice traces back to.
