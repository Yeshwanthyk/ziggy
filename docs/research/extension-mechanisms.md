# Extension and plugin mechanisms: Pi, OpenClaw, Hermes Agent, Flue, and Eve

This report is based on the checked-out source trees named in the task. “In-process” means extension-owned code executes in the agent/gateway process and can call host APIs directly. “Subprocess” means the host invokes a separate executable through a narrow command or RPC boundary. “Markdown-only” means the extension mechanism itself contributes instructions; those instructions may tell the agent to use an already-existing shell/tool capability, but loading the extension does not execute extension code.

## Section A — Per-system mechanics

### 1. Pi coding-agent

#### Execution and loading model

Pi extensions are in-process TypeScript/JavaScript modules. An extension default-exports an `ExtensionFactory`, `(pi: ExtensionAPI) => void | Promise<void>`, and the loader invokes that factory with a process-local API object (`packages/coding-agent/src/core/extensions/types.ts`, `ExtensionFactory` and `ExtensionAPI`; `packages/coding-agent/src/core/extensions/loader.ts`, `loadExtensionModule()` and `loadExtension()`). This is not a worker, RPC protocol, or subprocess boundary.

The exact runtime loader is **jiti**, not native dynamic `import()` and not a pre-bundling step. `loader.ts` statically imports `createJiti` from `jiti/static`, constructs a new loader with `moduleCache: false`, then calls `await jiti.import(extensionPath, { default: true })` (`packages/coding-agent/src/core/extensions/loader.ts`, `loadExtensionModule()`). The result must itself be a function. `wrapper.ts` wraps installed extensions to attach source/package metadata but does not change that execution boundary (`packages/coding-agent/src/core/extensions/wrapper.ts`). `runner.ts` retains the loaded handlers and invokes them serially inside Pi's process, with specialized combination rules for mutating events such as context, tool calls, input, and provider requests (`packages/coding-agent/src/core/extensions/runner.ts`, `ExtensionRunner` and its `emit*` methods).

Crucially, this loading **does not depend on Pi running under Node or npm**. The loader explicitly has two resolution modes. In Node/development mode it gives jiti aliases pointing at workspace or installed package files. In a Bun-compiled executable it supplies `virtualModules` and `tryNative: false`; the allowed Pi SDK, AI, TUI, and TypeBox modules are statically imported so Bun includes them in the executable (`packages/coding-agent/src/core/extensions/loader.ts`, `VIRTUAL_MODULES`, `getAliases()`, and `loadExtensionModule()`; `packages/coding-agent/src/config.ts`, `isBunBinary`). Therefore an external `.ts` extension can be transformed from disk by the jiti code embedded in the binary and can import the explicitly virtualized SDK modules. npm is an installation/distribution option, not a runtime prerequisite. An extension's other dependencies still need to be available in its package/module root, which is why package documentation requires non-core dependencies to be bundled with the package (`packages/coding-agent/docs/packages.md`, “Dependencies”).

#### Manifest, reach, lifecycle, distribution, and trust

Pi has no separate extension manifest. A package's `package.json` may contain `pi.extensions`, `pi.skills`, `pi.prompts`, and `pi.themes`; otherwise conventional `extensions/`, `skills/`, `prompts/`, and `themes/` directories are discovered (`packages/coding-agent/src/core/extensions/loader.ts`, `PiManifest` and `readPiManifest()`; `packages/coding-agent/docs/packages.md`, “Package Structure”). The executable code contract is the module's default-exported factory.

The API is broad. Extensions can register event hooks across session, agent, turn, message, tool, input, bash, compaction, and provider request/response lifecycles; register tools, commands, shortcuts, flags, renderers, and providers; execute commands; send or append messages; change active tools, model, and thinking level; and use a shared event bus (`packages/coding-agent/src/core/extensions/types.ts`, `ExtensionAPI`). This is effectively trusted host code. The only meaningful constraints are API-level checks—reserved shortcuts, stale-context invalidation, and the project-trust event—not OS isolation (`runner.ts`, reserved keybindings and `emitProjectTrustEvent()`; `loader.ts`, `createExtensionRuntime()`).

Packages install from npm, git, or local paths with `pi install`; `pi remove`, `pi update`, and `pi list` provide the management story, while settings can enable/disable or explicitly enumerate resources (`packages/coding-agent/docs/packages.md`, “Install and Manage” and “Enable and Disable Resources”). The package remains normal source/resources on disk and Pi loads each package with a separate module root to avoid dependency collisions (`packages.md`, “Dependencies”). There is no manifest-declared ABI/API range or sandbox. Compatibility is source/API compatibility with the Pi packages, conventionally declared as wildcard peer dependencies for core modules (`packages.md`, “Dependencies”).

### 2. OpenClaw

#### Code plugins: execution and loading

OpenClaw plugins are in-process Node modules. Discovery scans bundled, workspace, global, package, and bundle roots, recognizes `.ts`, `.js`, `.mts`, `.cts`, `.mjs`, and `.cjs`, reads `openclaw.plugin.json`, and rejects unsafe candidates whose real path escapes the root, is world-writable, or has suspicious ownership (`src/plugins/discovery.ts`, `EXTENSION_EXTS`, `findCandidateBlockIssue()`, and `discoverOpenClawPlugins()`). Discovery and manifest inspection are deliberately cheaper than runtime activation.

At activation, `loadOpenClawPlugins()` builds a registry and loads selected candidates in the same process (`src/plugins/loader-runtime-load.ts`). The module loader prefers native `require()` for already-compiled JavaScript. If native loading is disabled or cannot safely handle TS/TSX, ESM, or an async-module case, it uses jiti to transform and load the module; SDK aliases make `openclaw/plugin-sdk` resolve to the host's public SDK (`src/plugins/plugin-module-loader-cache.ts`, `loadCreateJitiLoaderFactory()`, `createLazySourceTransformLoader()`, and `createPluginModuleLoader()`; `src/plugins/sdk-alias.ts`). Registration calls the plugin module's `register(api)` function and mutates host registries. There is no worker isolation around ordinary plugins.

This makes the mechanism Node/process-oriented. Its implementation uses `node:module` `createRequire`, `process.argv`, Node package roots, native require, jiti, and package `node_modules` resolution (`src/plugins/plugin-module-loader-cache.ts`; `src/plugins/sdk-alias.ts`; `src/plugins/discovery.ts`). A single-file native executable would have to embed and emulate these facilities or replace the loader.

#### Manifest and API compatibility

Every plugin root has `openclaw.plugin.json`; `id` and `configSchema` are required, and the normalized manifest can also declare name/version/description/kind, activation triggers, setup metadata, skills, provider/channel ownership, static contracts, tool metadata, UI hints, and config contracts (`src/plugins/manifest.ts`, `PluginManifest` and `loadPluginManifest()`). Examples include `extensions/memory-lancedb/openclaw.plugin.json`, which declares command activation, a memory kind, tool contracts, UI hints, and a config schema, and `extensions/lmstudio/openclaw.plugin.json`, which declares provider activation/setup/auth metadata.

There are two distinct version concepts. `openclaw.plugin.json.version` is descriptive package/plugin version metadata. The actual host compatibility gate is optional `package.json#openclaw.compat.pluginApi`, a semver range checked against the host version during discovery/install/update; incompatible plugins are rejected with an upgrade/install-compatible-version diagnostic (`src/plugins/package-compat.ts`, `resolvePackagePluginApiRange()`; `src/plugins/discovery.ts`, `satisfiesPluginApiRange`; `src/plugins/install-shared.ts`). This is a declared compatibility range, not a separately versioned binary ABI. The SDK is source-level TypeScript/JavaScript exports under `packages/plugin-sdk/` and host alias resolution. Omitting the range means no explicit compatibility guarantee.

The registration API is correspondingly large: plugins can add tools, hooks, channels, providers, gateway methods, CLI commands, HTTP routes, services, auth/setup behavior, and other registry-backed capabilities (the public types and registration helpers under `packages/plugin-sdk/`; registry construction in `src/plugins/registry.ts`). Because code runs in-process, it has normal Node authority in addition to whatever facade the SDK documents.

OpenClaw has a relatively developed operator story: package/local discovery, install and update code, activation planning from manifest metadata, list/status/inspect paths, setup registries, doctor contracts, config schemas, and load diagnostics (`src/plugins/install-shared.ts`, `update-source.ts`, `status.ts`, `setup-registry.ts`, and `doctor-contract-registry.ts`). Distribution is principally npm/package roots plus bundled plugins and local/workspace roots (`src/plugins/discovery.ts`). Security is defense in depth around trusted in-process code: path/ownership/world-write checks, hardlink policy, install security scanning, allow/enable policy and provenance warnings, config-schema validation, and transactional rollback of registration side effects (`src/plugins/discovery.ts`; `src/plugins/hardlink-policy.ts`; `src/plugins/install-security-scan.ts`; `src/plugins/loader-runtime-load.ts`). It is not a capability sandbox.

#### Skills are separate

`src/skills/` is not another code-plugin ABI. A skill is a directory containing `SKILL.md`; the loader reads the file through a root-boundary helper, parses frontmatter, requires a name and description, hashes prompt content for a version marker, and produces prompt-facing skill metadata (`src/skills/loading/local-loader.ts`; `src/skills/loading/frontmatter.ts`; `src/skills/loading/skill-contract.ts`). Skills can declare invocation policy, OS/command/env requirements, and install recipes, but loading the skill does not import executable code. The model reads/injects Markdown and may then use existing tools to follow it. Boundary reads and symlink checks limit path escapes (`src/skills/loading/local-loader.ts`; `src/skills/loading/symlink-targets.ts`; `src/skills/security/workspace-audit.test.ts`). Plugin manifests may point at skill roots with `skills`, but code-plugin activation and skill content loading remain separate mechanisms (`src/plugins/manifest.ts`, `PluginManifest.skills`; `src/skills/loading/plugin-skills.ts`).

### 3. Hermes Agent

Hermes exposes three mechanisms whose names overlap in product language but whose runtime contracts are different.

#### Tools

Built-in tools are Python modules imported into the agent process. `tools/registry.py` first AST-scans `tools/*.py` for a top-level `registry.register(...)`, then calls `importlib.import_module()` for matching modules; import-time registration stores schema, handler, toolset, availability check, env requirements, async status, and display metadata in the singleton `ToolRegistry` (`tools/registry.py`, `_module_registers_tools()`, `discover_builtin_tools()`, `ToolEntry`, and `ToolRegistry.register()`). Dispatch invokes the registered Python callable in-process. Individual handlers may themselves start subprocesses—for example terminal/code execution and stdio MCP—but that is tool behavior, not the tool registration boundary (`tools/code_execution_tool.py`; `tools/mcp_tool.py`).

There is no per-tool manifest or independent package contract for built-ins; Python source and the central registry are the contract. Availability probes and toolset aliases help setup/doctor-style visibility, but adding tools adds import/registry surface (`tools/registry.py`, check-function cache and toolset methods). Trust is equivalent to importing Python into Hermes. Collision/override controls live in the registry, especially for plugin-origin handlers (`tools/registry.py`, plugin override policy and `register()`).

#### Skills

Hermes skills are Markdown-only at activation. A skill directory has `SKILL.md` with YAML frontmatter such as `name`, `description`, `version`, `author`, `license`, `platforms`, `prerequisites.commands`, and `metadata.hermes.tags`; its body supplies procedures and command examples (for a representative built-in, `skills/apple-reminders/SKILL.md`). Conditional activation is explicit: `metadata.hermes` can declare `fallback_for_toolsets`, `requires_toolsets`, `fallback_for_tools`, and `requires_tools`; the prompt builder hides a fallback when its primary capability exists and hides a required skill when its tool/toolset is absent (`agent/skill_utils.py`, `extract_skill_conditions()`; `agent/prompt_builder.py`, `_skill_should_show()`). Platform and environment tags are additional offer-time gates, while explicit loads can bypass the environment relevance gate (`agent/skill_utils.py`, `skill_matches_platform*()` and `skill_matches_environment()`; `agent/prompt_builder.py`, skill compatibility check). Profile/platform configuration can separately disable skills (`hermes_cli/skills_config.py`). None of these paths import skill-owned Python. Referenced scripts or shell commands execute only later through existing tools, so the skill itself is content injection.

Distribution spans built-in and optional skill trees plus hub/source installs. Catalog entries carry `trust_level` values `builtin`, `trusted`, or `community`; deduplication prefers the higher trust tier (`tools/skills_hub.py`, `SkillMetadata`, `trust_level_for()`, and `_TRUST_RANK`). Install uses quarantine, a cached security scan, confirmation policy, lock metadata, and an audit log (`hermes_cli/skills_hub.py`, install flow around `scan_skill_cached()`; `tools/skills_guard.py`; `tools/skills_hub.py`, lock and audit helpers). Official optional skills are labeled official/builtin while general URLs, GitHub, ClawHub, and other catalogs default to community unless explicitly trusted (`tools/skills_hub.py`, source classes and `OfficialOptionalSkillsSource`). The scanner catches suspicious content/scripts; it cannot make instructions inherently safe, which the install UI explicitly states (`hermes_cli/skills_hub.py`, scan report and confirmation text).

#### Plugins

Hermes plugins are also in-process Python. Directory plugins require `plugin.yaml` plus `__init__.py` with `register(ctx)`; pip packages may instead expose the `hermes_agent.plugins` entry-point group (`hermes_cli/plugins.py`, module docstring and `ENTRY_POINTS_GROUP`). `PluginManager` scans bundled, `~/.hermes/plugins`, optionally `./.hermes/plugins`, and Python entry points. It loads directory modules with `importlib.util.spec_from_file_location()`, `module_from_spec()`, and `spec.loader.exec_module()`, then calls `register(PluginContext)` (`hermes_cli/plugins.py`, `PluginManager._scan_directory*()`, `_load_directory_plugin()`, and `_scan_entry_points()`). This is not a worker or subprocess boundary.

`plugin.yaml` normalizes into `PluginManifest`: name, version, description, author, required environment, advertised tools/hooks, source/path, kind, and path-derived key. Kinds include standalone, backend, exclusive, platform, and model-provider, with some categories delegated to their own discovery paths (`hermes_cli/plugins.py`, `_VALID_PLUGIN_KINDS`, `PluginManifest`, `_parse_manifest()`, and `_discover_and_load_inner()`). Example manifests under `plugins/image_gen/*/plugin.yaml` declare backend identity and API-key requirements; `plugins/platforms/dingtalk/plugin.yaml` declares a platform and structured required/optional environment variables.

`PluginContext` can register tools, hooks, middleware, commands, skills, auxiliary tasks, gateway platforms, context engines, media/web/browser providers, dashboard auth, and secret sources, invoke tools, inject messages, and access a host-owned LLM facade (`hermes_cli/plugins.py`, `PluginContext`). That breadth produces power and registry sprawl: memory, model providers, context engines, platforms, and general plugins have partially specialized loaders. Project plugins require `HERMES_ENABLE_PROJECT_PLUGINS`; safe mode skips discovery; non-bundled plugins need explicit enablement, and overriding built-in tools requires `plugins.entries.<id>.allow_tool_override: true`, while bundled plugins are trusted for overrides (`hermes_cli/plugins.py`, `discover_and_load()`, `_tool_override_allowed()`). `hermes plugins` list/enable/disable plus env checks provide lifecycle/setup visibility, and pip/user/project/bundled roots provide distribution (`hermes_cli/plugins.py` and its CLI-facing helpers). There is no process sandbox or declared ABI range; Python/API compatibility is implicit.

### 4. Flue

Flue does not have one general post-install plugin loader. Its extension story is compile-time/application composition across tools, skills, packages, sandbox adapters, and Markdown blueprints.

#### Tools and skills

A `ToolDefinition` is a normal object supplied to `createAgent()`, `init()`, `prompt()`, `skill()`, or `task()`: unique name, description, Valibot or raw JSON Schema parameters, and an async `execute` callback (`packages/runtime/src/tool-types.ts`). `defineTool()` validates and freezes it; Valibot parameters are converted to JSON Schema and the callback is wrapped with runtime input validation (`packages/runtime/src/tool.ts`). The callback runs in the host JavaScript process. It may deliberately keep secrets host-side, but it is not isolated from the host.

Skills are imported content, commonly `import triage from './SKILL.md' with { type: 'skill' }`, and composed into an agent definition (`README.md`; `packages/runtime/types/skill-md.d.ts`; `packages/runtime/src/agent-definition.ts`). The Vite import-attribute plugin reads Markdown at build time and emits a JavaScript value; `skill` imports additionally parse/validate skill frontmatter (`packages/cli/src/lib/vite-import-attribute-plugin.ts`; `packages/runtime/src/skill-frontmatter.ts`). Sessions expose an `activate_skill` tool and inject activated skill instructions into model context (`packages/runtime/src/session.ts`, skill assembly and activation). Loading a skill executes no skill-owned code.

There is no shared plugin manifest. A tool's object is its executable declaration, a skill's frontmatter is its content declaration, and an npm integration package uses normal `package.json`. Setup is project-owned: install packages and import/wire definitions in agent source. This is explicit and statically analyzable, but it lacks a central install/enable/doctor registry comparable to OpenClaw or Hermes.

#### Blueprints

`blueprints/*.md` are versioned implementation guides, not packages or runtime abstractions. `flue add`/`flue update` fetch and print the guide so a coding agent edits the consumer project (`blueprints/README.md`; CLI blueprint code under `packages/cli/src/lib/blueprint-index.ts` and the add/update command paths). JSON frontmatter declares `kind`, monotonically increasing `version`, optional aliases, website, and root status. Kinds are sandbox, channel, database, and tooling. Generated-file markers and cumulative upgrade diffs help later updates (`blueprints/README.md`). The result becomes ordinary project code, so trust/review happens as a source change rather than dynamic third-party activation.

#### Host versus sandbox

Flue makes the execution boundary explicit with `SessionEnv`. Model-facing bash and filesystem operations are routed through `SessionEnv.exec/readFile/writeFile/...`; it can wrap just-bash, a local host adapter, or a provider-supplied `SandboxApi` (`packages/runtime/src/sandbox.ts`; `packages/runtime/src/types.ts`; `packages/runtime/src/node/local.ts`). `SandboxApi` is an async filesystem/exec interface for remote providers, adapted by `createSandboxSessionEnv()` with cwd resolution, timeout, and abort semantics (`packages/runtime/src/sandbox.ts`). Thus custom tool callbacks and agent code run in-process, while commands/files can run in an in-memory shell, directly on the local host, or in a remote container/VM depending on the selected sandbox. The boundary is configurable, not intrinsic: `local()` directly binds to host filesystem/shell with a deliberately small default env allowlist (`packages/runtime/src/node/local.ts`; `CHANGELOG.md`, local sandbox/env change).

Flue's trust posture is therefore architectural: schemas validate tool input; secrets can remain in host callbacks; `SessionEnv`/remote sandboxes can isolate model-directed execution; and blueprints produce inspectable app-owned code. It does not sandbox arbitrary imported npm tool callbacks, because those are application code.

### 5. Eve

#### Agent-shaped npm extensions and mounting

An Eve extension is an agent-shaped npm or local package containing tools, connections, skills, instructions, hooks, state, and a root `extension/extension.ts`, but no `agent.ts`, sandbox, schedules, limits, or nested extensions (`docs/extensions.md`; enforcement in `packages/eve/src/discover/discover-agent.ts`). `defineExtension()` declares optional Standard Schema configuration; its returned mount factory binds configuration once (`packages/eve/src/public/definitions/extension.ts`). A consumer mounts it with `agent/extensions/crm.ts`; the filename supplies a namespace, and contributions become `crm__search`, `crm__api`, and so on. Directory mounts permit co-located overrides or disable markers (`docs/extensions.md`, “Mounting” and “Overrides”; `packages/eve/src/compiler/normalize-extension.ts`). Package identity separately scopes durable state so renaming a mount does not orphan it (`packages/eve/src/discover/extensions.ts`, `packageStateNamespace()`).

#### Discover, compile, manifest, and runtime loading

Eve's key design is **discover without executing, compile to static imports**. Discovery walks the agent-shaped filesystem and records source references without importing authored modules (`packages/eve/src/discover/discover-agent.ts`, `discoverAgent()`). For a mount it statically parses supported import/re-export forms to extract the npm specifier, resolves the package from the normal project/package tree, reads its `package.json`, and uses `eve.extension.dist` to find the built extension root (`packages/eve/src/discover/extension-specifier.ts`, `parseExtensionMountSpecifier()`; `packages/eve/src/discover/extensions.ts`, `locateExtensionMountPackage()`). It then discovers that dist tree like an agent subtree.

Compilation normalizes definitions into a compiled agent manifest and writes generated artifacts (`packages/eve/src/compiler/compile-agent.ts`; `normalize-manifest.ts`). The generated module map contains a **static ESM import for every executable authored module** (`packages/eve/src/compiler/module-map.ts`, `createCompiledModuleMapSource()`). The application build then bundles those imports. Runtime therefore consumes a precompiled/bundled graph rather than finding arbitrary new extension code from a profile directory.

`eve extension build` transforms JS/TS into `dist/extension`, copies skills/assets, emits declarations and entrypoints, updates package exports, and writes `dist/extension/_manifest.json` (`docs/extensions.md`, “Publishing”; build implementation under `packages/eve/src/internal/nitro/host/build-extension.ts` and CLI extension-build command). `_manifest.json` contains a fixed kind/format version, the diagnostic Eve build version, and per-capability required contract versions—currently independent version 1 contracts for extension, tool, dynamic tool, connection, hook, skill, dynamic skill, instructions, dynamic instructions, config, and state (`packages/eve/src/compiler/extension-compatibility.ts`). Consumers reject unknown/unsupported capability versions before executing the extension (`packages/eve/src/discover/extensions.ts`, `locateExtensionMount()`). This is stronger and more granular than an undifferentiated package peer range.

Executable contributions ultimately run in the consuming agent process/deployment and under its session limits; skills/instructions are content, while tools/hooks/connections are code (`docs/extensions.md`, “Limits”; compiler normalizers under `packages/eve/src/compiler/normalize-*.ts`). The extension can touch the host surfaces exposed by those definitions and any authority available to its bundled dependencies, but cannot own deployment-wide sandbox/model/limits/schedules.

The setup/distribution story assumes a normal Node package project: `npx eve extension init`, `package.json`, npm publishing/workspaces, `node_modules`, peer/dev/dependencies, TypeScript declaration emission, and a consuming bundler (`docs/extensions.md`; `packages/eve/src/discover/extensions.ts`, package resolution). Native addons must be declared as external dependencies by the consuming agent (`docs/extensions.md`, “Dependencies”). This model fits a compiled deployment artifact, but not hot-installing code into an already-compiled single executable: adding an extension requires rebuilding the consumer. Trust is correspondingly build-time—normal npm supply-chain trust plus source/build review and capability compatibility validation—not runtime isolation.

## Section B — What really needs in-process code

### Capabilities that require a host execution seam

Some capabilities cannot be faithfully represented by Markdown plus “run this CLI” because they must observe, alter, or implement host control flow:

- **Loop and lifecycle hooks:** intercepting context before an LLM call, rewriting a tool call/result, reacting to every token/message/session transition, vetoing compaction, or injecting a message while the loop is resident requires callback/RPC participation at the event boundary. Pi exposes these directly in `ExtensionAPI.on` (`types.ts`); OpenClaw and Hermes register hook callbacks (`packages/plugin-sdk/`; `hermes_cli/plugins.py`, `VALID_HOOKS`); Eve compiles hook modules (`compiler/normalize-hook.ts`).
- **Custom model/provider implementations:** a provider with OAuth refresh, streaming translation, custom headers, catalog refresh, or nonstandard wire protocol needs a runtime adapter. Pi's `registerProvider` can provide `streamSimple` and OAuth (`types.ts`, `ProviderConfig`). Hermes plugins register model/media/web/browser providers (`hermes_cli/plugins.py`, `PluginContext`). OpenClaw plugins own provider/channel/gateway contracts (`src/plugins/manifest.ts`, contracts and provider metadata; plugin SDK). A static default model ID does not need this.
- **Resident gateway/channel adapters and services:** maintaining sockets/webhooks, normalizing inbound events, dispatching gateway routes, and handling acknowledgements require a resident service or a separately supervised daemon with RPC. OpenClaw and Hermes put these adapters in process (`packages/plugin-sdk/`; `hermes_cli/plugins.py`). Flue composes channel code into the app (`blueprints/channel--*.md` and channel packages). Markdown can explain setup but cannot itself receive an inbound event.
- **Host-side secret-bearing structured actions:** a tool callback that must hold credentials away from model-visible shell state benefits from an in-process or broker process facade. Flue explicitly notes custom host tools recover this property for secrets (`packages/runtime/src/tool-types.ts`; `CHANGELOG.md`, commands removal rationale). A subprocess can also satisfy it if the protocol and environment are narrow.
- **Custom rendering, registries, or durable state integration:** Pi renderers and state/session actions, Hermes context engines, and Eve state scoping need direct runtime contracts (`pi .../types.ts`; `hermes_cli/plugins.py`; `eve docs/extensions.md`).

These needs do **not** imply arbitrary dynamic code must share the daemon process. A typed subprocess protocol can serve tools, providers, and gateway adapters. Only latency-sensitive synchronous loop interception and objects that the host library itself requires in memory strongly favor in-process implementation. Even hooks can be RPC if their event schema, timeouts, failure semantics, and ordering are explicit.

### What Markdown skills + CLI tools + a manifest can cover

A declarative package can cover a surprisingly large extension surface:

- procedures, domain guidance, prompt snippets, examples, and decision rules;
- actions expressed as invocations of installed executables through an existing shell/exec tool;
- tool name/description/input schema mapped to a command plus JSON/stdin/stdout protocol;
- provider/model/thinking-level defaults when the provider already exists in core;
- required environment variables, binaries, OS constraints, health probes, and setup/install commands;
- enablement, precedence, version compatibility, permissions requested, and distribution provenance;
- static slash commands that expand to prompts or tool calls.

This is the line demonstrated by OpenClaw skills (`src/skills/loading/*`) and Hermes skills (`SKILL.md`, `skills_config.py`, and `skills_guard.py`): rich workflows need no imported code as long as general tools already provide the needed effects. Flue's attributed Markdown skills make the same distinction (`vite-import-attribute-plugin.ts`; `session.ts`).

### Where each system draws the line, and the cost

**Pi** puts almost every advanced capability into one in-process extension API and packages skills beside it (`loader.ts`, `types.ts`, `packages.md`). This is coherent for authors and unusually compatible with a Bun binary because jiti and SDK virtual modules are embedded. The cost is a very wide trusted API, source-level compatibility burden, and little manifest-level security/setup metadata.

**OpenClaw** has the broadest manifest/registry operator surface. Code plugins own runtime adapters, hooks, tools, routes, and services; skills remain Markdown. Static manifest contracts increasingly let discovery/setup/status operate without importing runtime (`manifest.ts`). The cost is substantial registry and loader machinery: discovery, activation planning, runtime loading, setup, doctor, metadata, compatibility, aliases, and many specialized contracts can overlap (`src/plugins/*`).

**Hermes** draws a clear conceptual line but implements it through three registries: import-time built-in tools, Markdown skills, and in-process Python plugins. The plugin layer then fans out into specialized provider/category loaders (`tools/registry.py`; `hermes_cli/plugins.py`). The cost is duplicated discovery/enablement semantics and “which registry owns this provider?” complexity; the benefit is straightforward Python extensibility and a notably explicit skill trust/scanning lifecycle.

**Flue** treats application code as the extension mechanism. Tools/adapters are imported code, skills are content, and blueprints instruct an agent to generate project-owned integrations. The sandbox boundary is for model-directed filesystem/process effects, not imported callbacks (`runtime/src/sandbox.ts`). This avoids a dynamic registry but shifts install/doctor/version convergence into the project and build workflow. Blueprints reduce framework API growth at the cost of generated-code drift, which their version markers and cumulative diffs explicitly manage (`blueprints/README.md`).

**Eve** draws the line at build time: executable capabilities are npm source compiled into static imports; content is copied and normalized; extensions cannot own deployment policy (`docs/extensions.md`; `discover/*`; `compiler/*`). Namespacing and per-capability compatibility are strong. The cost is that install means package-manager change plus rebuild, and the mechanism assumes a conventional Node project/bundler rather than runtime installation into an immutable executable.

## Section C — Recommendation for Ziggy

### Recommendation in one sentence

Use a **manifest-first, skills-as-Markdown, tools-as-supervised-subprocesses** extension format loaded from the profile directory; keep the daemon's in-process extension surface closed initially, and reserve a small versioned RPC adapter protocol for providers/gateways that cannot be expressed as command tools.

That choice matches Ziggy's Bun-compiled single executable and resident-daemon constraints better than Pi/OpenClaw-style arbitrary TS import or Eve-style rebuild-the-consumer composition. Pi proves external TS can technically be interpreted from a Bun binary (`pi .../loader.ts`), but doing so deliberately embeds a compiler/module resolver and gives extension code daemon authority. Eve avoids runtime interpretation, but its npm/node_modules/build pipeline cannot hot-install into an already-shipped executable (`eve docs/extensions.md`; `discover/extensions.ts`; `compiler/module-map.ts`). Ziggy should keep the profile as the dynamic waist and use process protocols the binary can implement stably.

### Concrete directory layout

```text
<profile>/extensions/<id>/
  extension.json
  skills/
    <skill-id>/
      SKILL.md
      references/
      templates/
      assets/
  tools/
    <tool-id>/
      tool.json
      bin/
        <platform-arch>/tool-executable
      scripts/                 # optional interpreted fallback
  adapters/                    # optional, advanced protocol services
    provider.json
    gateway.json
    bin/<platform-arch>/...
  setup/
    verify                     # package-owned executable/script
    doctor
  state/                       # extension-private durable data, not executable config
  provenance.json              # installer-owned source, digest, signature/checksum
```

The daemon should never search `node_modules` or import `.ts` from this directory. Install materializes a complete, immutable version under a staging path, validates it, then atomically switches `<id>` (or an installer-owned version pointer). State should actually live under `<profile>/runtime/extensions/<id>/` if extension upgrades replace the package directory; the layout above can treat `state/` as a documented logical mount rather than package content.

### Manifest fields

`extension.json` should be strict JSON with unknown fields rejected for the declared format version:

```json
{
  "formatVersion": 1,
  "id": "acme.crm",
  "version": "1.4.0",
  "name": "Acme CRM",
  "description": "CRM search and triage workflows",
  "ziggy": { "requires": ">=0.3 <0.5" },
  "defaults": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "high"
  },
  "skills": [{ "id": "triage", "path": "skills/triage/SKILL.md" }],
  "tools": [{ "id": "search", "path": "tools/search/tool.json" }],
  "adapters": [],
  "setup": {
    "steps": [
      { "id": "credentials", "command": ["setup/verify", "--configure"], "interactive": true }
    ],
    "doctor": ["setup/doctor", "--json"]
  },
  "requires": {
    "env": ["ACME_API_KEY"],
    "commands": [],
    "os": ["darwin", "linux"]
  },
  "permissions": {
    "network": ["api.acme.example:443"],
    "filesystem": ["extension-state:read-write"],
    "secrets": ["ACME_API_KEY"]
  },
  "distribution": {
    "source": "github:acme/ziggy-crm",
    "license": "MIT"
  }
}
```

Defaults are preferences, not provider implementations. Resolution order should be explicit: invocation override > profile override > enabled extension default > Ziggy core default. Reject ambiguous defaults from multiple enabled extensions unless the profile selects a winner; silently using load order repeats the collision problems visible in broad registries.

Each `tool.json` should declare `protocolVersion`, name/description, JSON Schema input/output, command vector, working-directory policy, timeout, concurrency, env allowlist, and whether the process is one-shot or persistent. Never interpolate model arguments into a shell string: send a JSON request on stdin and receive JSON Lines or length-framed responses on stdout. A persistent mode amortizes startup for expensive tools without granting daemon memory access.

### Execution boundary

**Markdown-only:** `SKILL.md`, references, templates, prompt commands, setup explanations, and static model/provider/thinking defaults. Parse frontmatter and content with root-confined reads, following the boundary discipline used by OpenClaw (`src/skills/loading/local-loader.ts`). Treat referenced scripts as executable package content only when invoked through a declared tool/setup step.

**Subprocess:** all ordinary tools, setup/install steps, doctor probes, and initially all custom provider/gateway adapters. The daemon owns spawning, cwd, environment filtering, deadlines, cancellation, output limits, structured errors, logging, and restart policy. This borrows the useful isolation seam of Flue's `SessionEnv` (`packages/runtime/src/sandbox.ts`) while making it the extension boundary rather than merely the model shell boundary. Adapter processes use a small Effect-modeled protocol over stdio or a profile-local Unix socket, with handshake fields `protocol`, `extensionId`, `capabilities`, and `instanceId`.

**In-process:** only Ziggy core and declarative registrations parsed by Ziggy. Do not load third-party TypeScript into the daemon in v1. If later evidence shows a loop hook cannot tolerate RPC latency, add a small, separately versioned hook protocol first. Only consider embedded JS after measuring that protocol, and then use capability-limited isolates rather than host-realm dynamic import. A resident daemon raises the blast radius of memory leaks, global mutation, dependency conflicts, and credential access compared with a short-lived CLI.

Provider and gateway adapters should be long-lived supervised subprocesses, not shell-per-request tools. They can maintain connections and streaming state, while the daemon retains authoritative session state and applies backpressure. Version event and request schemas independently, as Eve versions capabilities independently (`packages/eve/src/compiler/extension-compatibility.ts`), instead of promising one giant SDK ABI.

### Install, setup, doctor, and distribution

Support `ziggy extension install <git-url|archive|path>`, `enable`, `disable`, `remove`, `update`, `list`, `inspect`, `setup`, and `doctor`. Installation should:

1. fetch into quarantine;
2. reject traversal/symlink escapes, world-writable executable paths, and undeclared files that affect execution, borrowing OpenClaw's discovery checks (`src/plugins/discovery.ts`);
3. verify checksums/signatures when available and record provenance;
4. parse manifests and schemas without executing package code;
5. show requested permissions and setup commands;
6. require approval for executable content or widened permissions;
7. run setup in a constrained subprocess with an explicit env/secret grant;
8. run `doctor --json` and only then atomically enable.

Distribution should be GitHub/archive-first and self-contained, with prebuilt executables per supported platform/architecture. npm may be one transport, but the installed artifact must not depend on npm, Node, a TypeScript compiler, or `node_modules`. For script-only tools, Ziggy should invoke an explicitly declared external interpreter and doctor should report it missing; it should never assume the Bun executable can resolve arbitrary package imports.

Hermes's skill quarantine/scanner/trust tiers are the strongest precedent here (`hermes_cli/skills_hub.py`; `tools/skills_guard.py`; `tools/skills_hub.py`). Adopt `builtin`, `verified`, and `community` provenance labels, but do not mistake scanning for isolation. Open-source/community packages remain untrusted executables. The durable security boundary is a narrow subprocess environment plus OS sandboxing where available.

### Why this is minimal

This design has one package manifest, one Markdown skill format, one command/RPC execution substrate, and one lifecycle. Tools and skills are bundled together without forcing two separately installed product concepts. Provider/model/thinking pins remain declarative. Setup and doctor are first-class but execute through the same supervised process machinery as tools. Advanced adapters reuse that machinery in persistent mode.

It avoids the observed costs of the reference systems: Pi's daemon-wide code authority and source loader, OpenClaw's many overlapping registries, Hermes's parallel category loaders, Flue's reliance on generated project code for lifecycle, and Eve's rebuild-only npm composition. Most importantly, it treats the Bun executable constraint as an architectural boundary rather than a packaging inconvenience: the binary owns stable protocols and policy; extensions own content and replaceable processes on disk.
