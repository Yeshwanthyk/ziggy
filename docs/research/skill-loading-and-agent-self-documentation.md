# Ziggy skills and agent self-documentation

Research date: 2026-09-16. Scope: current checkout, pinned Pi 0.84.1, and the isolated `dump/browser-workflows` Profile. Two Luna Max subagents investigated loading and writing quality; the parent traced code/documentation access. The original assessment below is preserved as historical context; the implementation follow-up records the current result.

## Implementation follow-up — 2026-09-16

The five self-documentation gaps identified below are now implemented. Normal Profile sessions expose pinned `pi_docs` and `ziggy_help`; CLI and tool help share one authority. Specialist allowlists still apply. Operations routing covers the supported command surface, extension authoring uses Profile-local admission checks, and generated operations references are synchronized from `docs/operations` with drift detection.

Sol Medium implemented the changes; Astra Medium independently verified them with no remaining findings. Repository checks and all 701 core tests passed. A real no-provider Profile session executed both docs tools and proved progressive skill disclosure and linked-reference access. The development standalone build passed its isolated smoke test with checkout access denied; a separate compiled probe verified three required skills and six canonical operations references.

Ziggy retains its replacement identity prompt. Runtime npm code is executed normally, not dumped into context. Live model selection of skills remains untested without provider authentication. The existing test Profile received the updated required skill packages; the installed binary was not replaced.

## Original audit verdict

Keep Ziggy's replacement system prompt. Ziggy should own its identity, Profile policy, and operational guidance. Its skill loading already uses Pi's progressive-disclosure machinery. The unfinished part is the replacement's self-documentation: reliable paths to current Ziggy operations and pinned Pi extension APIs, with instructions that actually apply inside a Profile.

Loading all of Ziggy's or Pi's npm source into model context is unnecessary. Execute the runtime code normally; expose selected tools and compact skill descriptions; read task-specific instructions, API docs, examples, or source only when needed.

## What is loaded

- Ziggy composes a custom prompt from its [Profile AGENTS template](../../src/adapters/pi/AGENTS.md) and `SOUL.md`; it does not use the repository's developer AGENTS file as the assistant's operational prompt. See [profile-prompt.ts](../../src/adapters/pi/profile-prompt.ts).
- Selected Profile packages contribute executable extension paths and declared skill paths. The required `pi-packages`, `extension-authoring`, and `ziggy-operations` packages also contribute skills. Required on-disk Profile copies take precedence over embedded copies. See [resources.ts](../../src/adapters/pi/resources.ts:104).
- Default Pi discovery of global/project extensions, skills, prompt templates, themes, and context files is disabled. Ziggy explicitly supplies its own resource paths. `noSkills: true` therefore does not mean no skills: `additionalSkillPaths` supplies them. See [profile-resource-loader.ts](../../src/adapters/pi/profile-resource-loader.ts:17).
- The pinned Pi implementation appends skill names, descriptions, and file locations to even a custom system prompt, provided the read tool is available. It tells the model to read the full skill on a matching task. `disable-model-invocation` skills are excluded from that automatic description list. See installed [system-prompt.js](../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:13) and [skills.js](../../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js:257).
- Repository `.agents/skills` and a user's external writing-for-agents installation are developer guidance, not automatically selected Profile skills. A skill intended for Ziggy must be shipped through a selected or required package's declared `pi.skills` path.

## Pi code versus agent-accessible documentation

The checkout depends on the published `@earendil-works/pi-coding-agent@0.84.1`; that code executes the agent loop and skill machinery. Ziggy's own [package.json](../../package.json:1) is currently private and exposes its source entrypoint locally. This is not evidence that a published Ziggy npm package is fetched into a Profile.

Selected extension code is physically present under the Profile shelf and executes through Pi. Skills are instructions; they do not by themselves register tools. The agent's normal file tools can read those package files when needed. Ziggy's core source is neither automatically injected into model context nor provided through a normal `source_lookup` capability.

There is an important distinction between embedded docs and callable docs:

1. Pi's default system prompt includes README/docs/examples pointers. Its custom-prompt branch does not include that default block. Ziggy intentionally supplies a custom prompt. See [Pi system-prompt.js](../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:13).
2. Ziggy implements an offline [pi_docs tool](../../src/adapters/pi/pi-docs.ts:193), backed by 31 pinned documents.
3. Normal Profile composition does not register it: [core inline extensions](../../src/adapters/pi/profile-core-inline-extensions.ts:167) and [custom tools](../../src/adapters/pi/pi-agent.ts:1200) omit it. An existing [test explicitly preserves its absence](../../test/adapters/pi/pi-docs.test.ts:265).
4. `doctor`'s `pi_docs` success checks that embedded documents exist, not that a running agent has a docs tool. See [doctor.ts](../../src/application/doctor.ts:248).

This is a gap relative to an assistant that should reliably author Pi extensions on its own, not a reason to restore Pi's full default identity prompt. Expose a deliberate, pinned documentation route in Ziggy's replacement.

## Writing-for-agents assessment

The required skills have a good foundation: short descriptions, a small always-loaded router, task-specific reference files, and relative references colocated with their owning skill. The [operations skill](../../extensions/ziggy-operations/skills/ziggy-operations/SKILL.md) is already organized around automations, memory, resident serve, and channel setup.

The following gaps need attention:

- **Reachable API reference:** extension-authoring explains `pi.registerTool` and package manifests but has no working runtime pointer to the pinned SDK/API documentation or examples. The unused docs tool compounds this gap.
- **Profile-appropriate proof:** [extension-authoring's proof steps](../../extensions/extension-authoring/skills/extension-authoring/SKILL.md:96) ask the agent to run `bun run check` and `bun test`. A Profile is not necessarily the Ziggy development repository or even a package with those scripts. Verification should use package-local checks when declared, in-process admission/preflight, and a disposable runtime test.
- **Concrete help discovery:** [operations](../../extensions/ziggy-operations/skills/ziggy-operations/SKILL.md:8) says to use "loaded help", but the custom prompt contains no complete CLI help block or specific help lookup tool. Make the help route explicit and version-matched rather than relying on shell PATH assumptions.
- **Coverage:** operations is useful for its documented branches but is not a complete self-operation guide for all current CLI families. Profile/model/auth, specialists, session inspection, ACP, and update behavior need explicit routing where the agent is expected to handle them.
- **One authority:** third-party package adoption instructions are repeated across operations, pi-packages, and extension-authoring. Keep the procedure in one skill and use concise contextual pointers elsewhere.
- **Observed documentation drift:** [the public Slack guide](../operations/slack.md:49) documents task-specific tool statuses and `busyMessageMode` steering/queue behavior, while [the bundled runtime reference](../../extensions/ziggy-operations/skills/ziggy-operations/references/slack.md:49) retains the older tool-name/status and queue description. Generating the catalog faithfully packages that older reference; it does not reconcile the two authorities. Use one source for both surfaces.
- **Specialist capability boundary:** specialists inherit skill paths but use explicit tool allowlists and do not receive the parent `profile_extensions` tool. The inherited authoring/package instructions should tell a specialist when to hand admission back to its parent. See [specialist.ts](../../src/adapters/pi/specialist.ts:263).
- **Optional-skill sprawl:** the [qmd skill](../../extensions/qmd/skills/qmd/SKILL.md) is a 422-line inline manual. It is a candidate for a small task router with disclosed references and version-matched executable help; this is lower priority than fixing Ziggy's own self-operation path.

## Recommended next slice

1. Keep the custom Ziggy prompt and Pi's existing skill loader.
2. Provide one supported, offline, version-matched documentation/help route. Reusing the existing `pi_docs` implementation is a small option for Pi APIs; add Ziggy help/reference discovery from existing authorities rather than a separate handwritten command registry.
3. Give extension-authoring a strong pointer to that API reference and correct its verification instructions for Profile-local packages.
4. Fill the operational router's missing supported branches; move repeated adoption rules into one authority.
5. Prove the actual session contract: expected descriptions appear, bodies are not eagerly inserted, relative references resolve, docs lookup is callable, and a minimal skill/extension can be admitted and used from an isolated Profile.

## Verification and limits

The current `dump/browser-workflows` doctor output confirms the selected Luna/max model, two executable Profile packages, and four skill roots. It reports the 31 embedded Pi documents as present. Model authentication is absent, so this assessment does not claim an authenticated model chose the right skill or successfully authored a new extension. Current source behavior is the authority; older standalone planning documents contain superseded catalog/skill-loading descriptions.

The loading scout also constructed a no-model Pi session using the actual Profile resources and Ziggy's resource-loader options. It observed two extension modules, 27 extension tools, four visible skills, and zero resource diagnostics. The skills were `computer-workflows`, `extension-authoring`, `pi-packages`, and `ziggy-operations`. The prompt contained their descriptions and absolute locations, not their bodies. The probe supplied a placeholder identity prompt and omitted core inline factories to avoid copying human-owned SOUL content; production joining and parent-only tools were checked separately in source. It proves loading and prompt assembly, not autonomous model selection.

All six operations reference files exist and are included in generated package metadata. Normal production preparation materializes required packages as well as selected ones ([profile-extensions.ts](../../src/application/profile-extensions.ts:677)); the named Profile has physical sibling reference files. The raw embedded fallback also exists, but this audit did not run a freshly compiled standalone executable to prove its relative-reference behavior. Do not generalize source-file inclusion into that stronger claim.

The `ziggy skills list` command is retired and points to extension commands; it is not a valid way to prove the model's skill inventory. See [CLI parsing](../../src/faces/cli.ts:265).
