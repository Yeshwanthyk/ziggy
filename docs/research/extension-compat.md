# Profile extension and skill compatibility

Scope: current Ziggy at `2255e48`, Pi `@earendil-works/pi-coding-agent@0.82.0`, and
the named artifacts found under the requested local roots. No exact source checkout of the
published `@martian-engineering/lossless-claw` package was found. No real package source named
`smart-skills` was found.

## Bottom line

Ziggy does not implement an extension installer or compatibility layer. It points Pi directly at
`<profile>/extensions` and `<profile>/skills`, with Pi's global/project discovery disabled
(`src/adapters/pi/pi-agent.ts:369-398`). A copied artifact therefore works only if it already obeys
Pi's file and API contracts.

The local `lossless-claw` and `smart-memory` bundles do not. They use Merlin or legacy-Ziggy
`extension.json` manifests and custom CLIs; none has a root `.ts`, directory `index.ts`, or
`package.json` with `pi.extensions`. `smart-skills` is not an implementation at all: the only exact
artifact is a fixture. Whole bundles copied to `<profile>/extensions` are ignored, not partially
activated.

Whole bundles copied to `<profile>/skills` are different: Pi recursively finds nested `SKILL.md`
files until it reaches each skill root
(`/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/src/core/skills.ts:160-170,187-264`).
The instructions may load, but none of their host-provided tools, CLIs, hooks, automations, or
install-time file copies come with them.

## `lossless-claw`

Verdict: **WON'T-LOAD as an extension; LOADS-DEGRADED as nested skills.**

The published OpenClaw source was not local. OpenClaw documents it as an external context-engine
plugin installed from npm, registering `lcm_grep`, `lcm_describe`, and `lcm_expand_query`
(`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/docs/concepts/active-memory.md:501-537`).
Its defining host seam is OpenClaw's `api.registerContextEngine`, which owns ingest, context
assembly, and compaction
(`/Users/yesh/.opensrc/repos/github.com/openclaw/openclaw/main/docs/plugins/architecture-internals.md:1061-1097`).
Pi's `ExtensionAPI` has tools, commands, hooks, providers, renderers, flags, and shortcuts, but no
context-engine registration seam. The real npm plugin therefore needs an adapter even if its
package happens to contain loadable JavaScript; its absent source prevents a file-shape verdict.

The concrete Merlin copy at
`/Users/yesh/code/personal/merlin/extensions/lossless-claw` has only `extension.json`, Python
`bin/lcm`, CLI JSON, and two skills
(`extension.json:1-55`). Its skills name `cli_lcm_sessions`, `cli_lcm_grep`,
`cli_lcm_expand_query`, and `cli_lcm_describe`
(`skills/lossless-memory/SKILL.md:1-37`), but Ziggy never registers those tools. In the TUI the
skill can be read but cannot perform recall. In run/gateway/wake it is worse: automatic skill use
expects the `read` tool, which the whitelist removes; only explicit `/skill:lossless-memory`
expansion injects its body (`Pi src/core/skills.ts:327-360`;
`Pi src/core/agent-session.ts:1151-1155,1297-1315`).

Even if the Python CLI were invoked manually, it reads `.claw/runtime/sessions/*.jsonl` and writes
`.claw/runtime/index/lcm.db`
(`/Users/yesh/code/personal/merlin/extensions/lossless-claw/bin/lcm:15-27,185-219`).
Ziggy stores Pi sessions under `<profile>/sessions`, including deeper gateway and automation
directories, so this copy indexes the wrong tree. Its consolidation skill also assumes a cron,
Claw memory tools, and `.claw/profile/memory/consolidated.json`
(`skills/memory-consolidation/SKILL.md:8-35`). None is provided by copying the skill.

The legacy copy at `/Users/yesh/code/personal/ziggy-bak/extensions/lossless-claw` also will not
load: `activation.ts` exports `{ activate(api) }` and calls custom `api.effect`,
`api.registerRecall`, `api.isTagged`, and `api.source`, not Pi's default factory contract
(`activation.ts:29-85`).

## `smart-memory`

Verdict: **WON'T-LOAD as an extension; LOADS-DEGRADED as a nested skill.**

No OpenClaw/Pi community source package with this exact name was found. The concrete Merlin copy
at `/Users/yesh/code/personal/merlin/extensions/smart-memory` has a non-Pi manifest, five CLI JSON
definitions, a Python executable, and one skill (`extension.json:1-55`). The skill names
`cli_smart_memory_run` and `cli_smart_memory_apply`
(`skills/smart-memory/SKILL.md:1-18`); copying it into Ziggy does not register either.

Its executable keeps locks, runs, reports, pins, decisions, and backups below
`.claw/runtime/extensions/smart-memory`, calls lossless-claw at the literal path
`.claw/extensions/lossless-claw/bin/lcm`, and directly mutates
`.claw/profile/memory/{core,relevant}.json`
(`/Users/yesh/code/personal/merlin/extensions/smart-memory/bin/smart-memory:21-35,113-152,236-284,352-419`).
Unmodified, that creates a shadow Claw state tree inside the profile rather than updating Ziggy's
`MEMORY.md` or contextual memory files. Adapted to those files, it would become a second writable
Memory authority beside Ziggy's atomic `memory_write` tool
(`src/adapters/pi/pi-agent.ts:164-253`). Either shape breaks the specification's invariant that no
durable fact has two writable authorities
(`docs/research/minimal-ziggy-scout.md:67-72`). Rollback is especially unsafe because this
implementation deletes and reconstructs its whole memory directory.

The Starman skill-only variant avoids direct writes but asks for a tool named `memory`, not
Ziggy's `memory_write`
(`/Users/yesh/code/personal/starman/extensions/smart-memory/skills/smart-memory/SKILL.md:1-12`).
It is therefore guidance-compatible in spirit, not executable as written.

## `smart-skills`

Verdict: **NOT-FOUND-ANALYZED-GENERICALLY.**

No real package was found in any requested root. The only exact directory is
`/Users/yesh/Documents/personal/dump/sm4-smart-skills-with-lossless/extensions/smart-skills`.
Its one-line `extension.json` calls itself an E2E fixture, declares no adapter or permissions, and
points to a six-line “behavior probe” skill (`skills/smart-skills/SKILL.md:1-6`). It has no
entrypoint, tool, hook, UI, command, provider, executable, or persistence behavior. As an
extension it is ignored; under `<profile>/skills` the probe skill loads but does no work.

The only substantive local design reference explicitly says there is no `smart-skills` extension;
the concept maps to separate skill-creator and skill-curator behavior
(`/Users/yesh/code/personal/ziggy-bak/docs/design/merlin-extension-port.md:25-36`). Generically, a
skill manager must write valid `SKILL.md` trees under this exact profile's `skills/` directory.
Writes to `~/.pi/agent/skills`, `.agents/skills`, another profile, or a package store remain
invisible because Ziggy sets `noSkills: true` and admits only `additionalSkillPaths`. In
run/gateway/wake its file-management tools would also be filtered out. A manager that rewrites
human-owned skills without review would conflict with Ziggy's plain-file ownership even in TUI.

## General loader and face behavior

Pi admits a direct `.ts`/`.js` file, a one-level child directory with `index.ts`/`index.js`, or a
child `package.json` whose `pi.extensions` lists existing entrypoints. It does not recurse farther
without that manifest
(`docs/research/pi-sdk-surface.md:318-343`;
`/Users/yesh/Documents/personal/reference/pi-mono/packages/coding-agent/src/core/extensions/loader.ts:561-668`).
Each entry must default-export a Pi extension factory; invalid exports and thrown imports become
load diagnostics, not usable extensions (`loader.ts:403-479`).

Pi loads TypeScript through Jiti 2.7 with Pi/TypeBox packages explicitly aliased in development or
provided as virtual modules in a compiled Bun binary (`loader.ts:47-72,82-137,403-419`). For any
other bare npm import, Jiti/Node resolves from the loaded extension file's module path: package
`node_modules`, then ancestor `node_modules` directories, including `<profile>/node_modules`.
Pi does not install dependencies. Ziggy's repo `node_modules` is not searched merely because
Ziggy launched the profile; it is available only if it is an actual ancestor/resolution path.
This last path ordering is a resolver inference confirmed against the installed Jiti 2.7
implementation; the Pi aliases are the only intentional bridge to Ziggy's own dependencies.

In TUI, Ziggy omits the `tools` allowlist. Pi activates default tools plus every registered
extension/custom tool, and `InteractiveMode` binds real terminal UI
(`src/adapters/pi/pi-agent.ts:545-564`; `Pi src/core/sdk.ts:54-73,245-251`;
`Pi src/core/agent-session.ts:2454-2544`). Tools, loop hooks, commands, shortcuts, dialogs,
widgets, renderers, and TUI-safe UI can work, subject to the extension itself.

In run, gateway, and wake, Ziggy passes `tools: ["memory_write"]`
(`src/adapters/pi/pi-agent.ts:302-343,392-398,505-540`;
`src/application/automations.ts:155-188`). This is a hard allowlist: Pi filters extension and
custom definitions before building both the registry and active set
(`Pi src/core/agent-session.ts:2454-2535`). Extension-registered tools are tool-dead unless named
`memory_write`, and Ziggy's later custom definition wins that name. Non-tool hooks still run.
Slash commands still execute because `AgentSession.prompt()` handles them before the model
(`Pi src/core/agent-session.ts:1105-1128,1267-1293`).

Ziggy binds gateway/wake chats in Pi `"print"` mode without a UI context
(`src/adapters/pi/pi-agent.ts:414-449`). Pi supplies no-op UI: dialogs return
`undefined`/`false`, mutation calls do nothing, `custom()` returns `undefined`, and theme changes
report “UI not available”
(`Pi src/core/extensions/runner.ts:233-264,429-440`). Correctly guarded UI code degrades without
crashing. Code that assumes a selection/result exists, imports terminal globals itself, or ignores
`ctx.hasUI` can still throw; Pi reports extension errors and continues
(`Pi docs/extensions.md:940-946,2860-2875`).

## Ownership and reload lifecycle

Extensions and skills are plain human-owned profile files. Ziggy creates no install record,
enablement record, copy, checksum, or saved configuration for them. It checks for the two
directories while building a runtime, and Pi loads their current contents for that process/session
build (`src/adapters/pi/pi-agent.ts:369-410`).

A changed file is guaranteed fresh after a process boundary: TUI relaunch, the next `ziggy run` or
`ziggy wake` process, or gateway restart. Pi `/reload` also clears the extension cache before
reloading (`Pi src/core/resource-loader.ts:340-343`; `Pi src/core/agent-session.ts:2601-2612`).
Gateway chat handles are retained in a map for the life of the resident process, so existing chats
keep the already-loaded factory until explicit reload or gateway restart
(`src/application/gateway.ts:187-213`). Moreover, Pi's extension factory cache is process-global
per cwd/path (`Pi src/core/extensions/loader.ts:142-163,403-427`), so even a newly opened gateway
chat can reuse stale code. “Next session build” is not a safe hot-reload guarantee inside the same
gateway process.

## Ranked gaps Ziggy should close

1. Decide whether headless faces intentionally ban all profile extension tools. If not, replace
   the `["memory_write"]` allowlist with an explicit policy that can admit reviewed extension tools.
2. Add a profile resource diagnostic command showing loaded, ignored, failed, and tool-filtered
   extensions/skills, including missing npm imports.
3. Add a gateway-safe reload operation that invalidates Pi's process-global extension cache and
   deliberately replaces or reloads all resident chat runtimes.
4. Define one Memory mutation boundary and reject/quarantine extensions or skills that introduce
   shadow memory stores or direct `MEMORY.md` writers.
5. Define a reviewed skill-authoring boundary constrained to `<profile>/skills`; keep global Pi
   stores invisible and prevent silent rewrites of human-owned skill files.
