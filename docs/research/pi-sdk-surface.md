# Pi coding-agent SDK surface

Read-only source report for `@earendil-works/pi-coding-agent`, reference tree
`/Users/yesh/Documents/personal/reference/pi-mono`, package snapshot
`8eef62ed3ea62d646a7fad92fa583fc8d71fec17`. Paths below are relative to
`packages/coding-agent` unless absolute paths are shown.

## 1. Root exports relevant to embedding

`src/index.ts` exports the following embedding surface:
```ts
createAgentSessionServices(options: CreateAgentSessionServicesOptions): Promise<AgentSessionServices>
createAgentSessionFromServices(options: CreateAgentSessionFromServicesOptions): Promise<CreateAgentSessionResult>
createAgentSessionRuntime(
  createRuntime: CreateAgentSessionRuntimeFactory,
  options: { cwd: string; agentDir: string; sessionManager: SessionManager; sessionStartEvent?: SessionStartEvent },
): Promise<AgentSessionRuntime>
```
Refs: `src/index.ts:194-221`; implementations and declarations:
`src/core/agent-session-services.ts:37-79,134-136,200-202`,
`src/core/agent-session-runtime.ts:35-41,411-428`.
Other root exports:
```ts
class AgentSessionRuntime
class SessionManager
class DefaultResourceLoader
class SettingsManager
class ModelRuntime
class InteractiveMode
runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number>
runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never>
```
The class declarations are re-exported at `src/index.ts:169-182,193-221,242-256,329-344`.
`ModelRuntime` has this construction API:
```ts
static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime>
```
Refs: `src/core/model-runtime.ts:58-70,93-94,133-172`.

## 2. Service/session factory options

The exact services options type is:
```ts
export interface CreateAgentSessionServicesOptions {
  cwd: string;
  agentDir?: string;
  settingsManager?: SettingsManager;
  modelRuntime?: ModelRuntime;
  extensionFlagValues?: Map<string, boolean | string>;
  resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
  resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
}
```
Ref: `src/core/agent-session-services.ts:37-45`. `cwd` is required and both `cwd`
and `agentDir` are resolved to absolute paths (`:134-151`). If no `modelRuntime`
is supplied, the factory creates `ModelRuntime` with `authPath: join(agentDir,
"auth.json")` and `modelsPath: join(agentDir, "models.json")` (`:137-145`).
If no settings manager is supplied it uses `SettingsManager.create(cwd, agentDir)`.
There is no `sessionManager` or raw `auth` property in this options type. Session
manager injection happens in the next factory:
```ts
export interface CreateAgentSessionFromServicesOptions {
  services: AgentSessionServices;
  sessionManager: SessionManager;
  sessionStartEvent?: SessionStartEvent;
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
  tools?: string[];
  excludeTools?: CreateAgentSessionOptions["excludeTools"];
  noTools?: CreateAgentSessionOptions["noTools"];
  customTools?: ToolDefinition[];
}
```
Ref: `src/core/agent-session-services.ts:53-64`. It passes the service-owned
`modelRuntime`, `settingsManager`, and `resourceLoader`, plus the supplied session
manager and session options, to `createAgentSession` (`:200-218`).
The runtime factory and initial runtime options are:
```ts
export type CreateAgentSessionRuntimeFactory = (options: {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  sessionStartEvent?: SessionStartEvent;
  projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;
createAgentSessionRuntime(
  createRuntime: CreateAgentSessionRuntimeFactory,
  options: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: SessionStartEvent;
  },
): Promise<AgentSessionRuntime>
```
Refs: `src/core/agent-session-runtime.ts:23-41,411-428`. A factory result must
include the normal `CreateAgentSessionResult` fields plus `services` and
`diagnostics` (`:23-26`); the supplied factory is retained for later replacement
flows (`:405-409`).

## 3. SessionManager

Exact factories:
```ts
static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager
static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions): SessionManager
```
Refs: `src/core/session-manager.ts:1514-1522,1567-1570`. `create(cwd,
sessionDir)` persists JSONL sessions in the explicit `sessionDir`; when omitted,
the default is `~/.pi/agent/sessions/<encoded-cwd>/` (or the equivalent under the
configured agent directory when the caller computes it). `getSessionDir()` exposes
the normalized directory (`:995-1005`). The SDK's default composition passes
`getDefaultSessionDir(cwd, agentDir)` to `SessionManager.create` when an explicit
`agentDir` was given (`src/core/sdk.ts:169-182`), and `getDefaultSessionDir` builds
`join(agentDir, "sessions", safePath)` (`src/core/session-manager.ts:472-488`).
For a custom directory, pass it directly:
```ts
const sessions = SessionManager.create(cwd, "/var/lib/my-wrapper/sessions");
```
For non-persistent operation use `SessionManager.inMemory(cwd)`; it passes an empty
session directory and `persist = false` (`:1567-1569`).

The pinned `0.82.0` package also exposes read-only metadata listing APIs:

```ts
static list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>
static listAll(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>
```

`SessionInfo` contains `path`, `id`, `cwd`, optional name/parent path, `created`,
`modified`, and `messageCount`, plus transcript-derived `firstMessage` and
`allMessagesText`. A Ziggy operator projection must map only the metadata fields and
must never expose those two transcript fields.

Both methods inspect only direct `.jsonl` children for a custom directory and silently
omit files for which Pi cannot build metadata. `list(cwd, customDirectory)` additionally
filters by the normalized header `cwd`, so it can hide an otherwise Pi-readable old,
imported, or alternate-path-spelling session. Use `listAll(customDirectory)` for
Profile inventory. Pi intentionally skips malformed non-header lines, so Ziggy must
not claim stricter JSONL validation. Recursive inventory should discover leaf
directories without following directory symlinks, refuse symlinked `.jsonl` files
before invoking Pi for that leaf, call `listAll` for each safe leaf, and compare
regular discovered paths with returned paths to detect metadata omissions. Refs:
pinned source [`SessionInfo`](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L174-L188),
[tolerant line parsing](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L498-L524),
[metadata construction and error omission](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L687-L764),
[direct-directory listing](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L811-L840),
and [`list`/`listAll` behavior](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L1631-L1708).

## 4. DefaultResourceLoader

Exact options type:
```ts
export interface DefaultResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  settingsManager?: SettingsManager;
  eventBus?: EventBus;
  additionalExtensionPaths?: string[];
  additionalSkillPaths?: string[];
  additionalPromptTemplatePaths?: string[];
  additionalThemePaths?: string[];
  extensionFactories?: InlineExtension[];
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
  skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
    skills: Skill[]; diagnostics: ResourceDiagnostic[];
  };
  promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
    prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[];
  };
  themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
    themes: Theme[]; diagnostics: ResourceDiagnostic[];
  };
  agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
    agentsFiles: Array<{ path: string; content: string }>;
  };
  systemPromptOverride?: (base: string | undefined) => string | undefined;
  appendSystemPromptOverride?: (base: string[]) => string[];
}
```
Ref: `src/core/resource-loader.ts:122-157`. The constructor signature is
`constructor(options: DefaultResourceLoaderOptions)`. Construct with
`new DefaultResourceLoader(options)` and call `await loader.reload()`; constructor
resolves `cwd`/`agentDir`, defaults settings to `SettingsManager.create(cwd,
agentDir)`, and creates a private event bus unless one is passed
(`:214-242`).
`systemPrompt` is either literal prompt text or a path: `resolvePromptInput` checks
whether the string exists, reads it as UTF-8 if so, and otherwise keeps the string
as literal content (`:50-65`). With no explicit value, the loader discovers trusted
`<cwd>/.pi/SYSTEM.md` first, then `<agentDir>/SYSTEM.md`; `APPEND_SYSTEM.md` follows
the same rule (`:966-992`).
`noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`, and `noContextFiles`
disable their default discovery paths. Explicit CLI/additional paths are still
merged in the corresponding reload path; for extensions and skills this behavior
is visible at `src/core/resource-loader.ts:400-428`, and for prompts/themes at
`:431-460`. Admit explicit resources with `additionalExtensionPaths` and
`additionalSkillPaths` (or `additionalPromptTemplatePaths` /
`additionalThemePaths`); inline code extensions use `extensionFactories`.

## 5. AgentSessionRuntime and session operations

`AgentSessionRuntime` itself owns the replaceable session and service set. Its
public signatures are:
```ts
get services(): AgentSessionServices
get session(): AgentSession
get cwd(): string
get diagnostics(): readonly AgentSessionRuntimeDiagnostic[]
get modelFallbackMessage(): string | undefined
setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void
setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void
async switchSession(
  sessionPath: string,
  options?: {
    cwdOverride?: string;
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
  },
): Promise<{ cancelled: boolean }>
async newSession(options?: {
  parentSession?: string;
  setup?: (sessionManager: SessionManager) => Promise<void>;
  withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}): Promise<{ cancelled: boolean }>
async fork(
  entryId: string,
  options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
): Promise<{ cancelled: boolean; selectedText?: string }>
async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>
async dispose(): Promise<void>
```
Refs: `src/core/agent-session-runtime.ts:74-131,193-221,223-257,259-349,358-402`.
Initial start is `createAgentSessionRuntime(...)`, not a `runtime.start()` method.
`switchSession` is the resume operation; `newSession`, `fork`, and
`importFromJsonl` tear down the old session, create/apply the replacement, then
invoke the optional rebind callback.
Prompting, steering, abort, and event subscription are on the current
`runtime.session`, not methods on `AgentSessionRuntime`:
```ts
prompt(text: string, options?: PromptOptions): Promise<void>
steer(text: string, images?: ImageContent[]): Promise<void>
followUp(text: string, images?: ImageContent[]): Promise<void>
abort(): Promise<void>
subscribe(listener: AgentSessionEventListener): () => void
dispose(): void
```
Refs: `src/core/agent-session.ts:800-810,837-845,1114-1114,1335-1346,1355-1366,1540-1546`.
The primary exported event types are `AgentSessionEvent` and
`AgentSessionEventListener` (`src/core/agent-session.ts:138-184`). The union adds
`agent_settled`, `queue_update`, compaction/retry events, `entry_appended`,
`session_info_changed`, `thinking_level_changed`, and `bash_execution_update` to
the core agent events. Root exports also expose extension lifecycle event types
including `SessionStartEvent`, `SessionShutdownEvent`, `SessionEvent`,
`SessionBeforeSwitchEvent`, `SessionBeforeForkEvent`, `SessionBeforeCompactEvent`,
and `SessionBeforeTreeEvent` (`src/index.ts:53-149`).

## 6. InteractiveMode, print mode, and RPC mode

Exact interactive options and construction/run signatures:
```ts
export interface InteractiveModeOptions {
  migratedProviders?: string[];
  modelFallbackMessage?: string;
  autoTrustOnReloadCwd?: string;
  initialMessage?: string;
  initialImages?: ImageContent[];
  initialMessages?: string[];
  verbose?: boolean;
}
constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions = {})
async run(): Promise<void>
```
Refs: `src/modes/interactive/interactive-mode.ts:298-316,443-489,823-828`.
The constructor creates `TUI(new ProcessTerminal(), ...)`, creates its own
`KeybindingsManager` with `KeybindingsManager.create()`, and calls the global
`setKeybindings(...)` (`:454-467`). Initialize the exported theme first:
```ts
initTheme(themeName?: string, enableWatcher: boolean = false): void
```
Refs: `src/modes/interactive/theme/theme.ts:799-815,834-848` and
`src/index.ts:384-394`. `theme` is a globalThis-backed proxy and throws until
`initTheme()` has run (`theme.ts:803-809`).
Print mode:
```ts
export interface PrintModeOptions {
  mode: "text" | "json";
  messages?: string[];
  initialMessage?: string;
  initialImages?: ImageContent[];
}
runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number>
```
Refs: `src/modes/print-mode.ts:14-32`. It binds extensions, subscribes to the
current session, prompts `initialMessage` and each `messages[]` item, writes text
or JSON to process stdout, installs signal handlers, and always disposes the
runtime (`:40-69,103-158`). RPC is similarly process-bound:
```ts
runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never>
```
Ref: `src/modes/rpc/rpc-mode.ts:49-55`.

## 7. Auth, models, and settings storage

Relative to `agentDir`, the global files are:
```text
<agentDir>/auth.json
<agentDir>/models.json
<agentDir>/settings.json
<cwd>/.pi/settings.json       # project settings, merged over global settings
```
Refs: `src/config.ts:510-541`; `src/core/settings-manager.ts:188-197`.
Construct pointed stores explicitly:
```ts
const auth = AuthStorage.create("/custom/agent/auth.json");
const models = await ModelRuntime.create({
  authPath: "/custom/agent/auth.json",
  modelsPath: "/custom/agent/models.json",
  modelsStorePath: "/custom/agent/models-store.json",
});
const settings = SettingsManager.create("/custom/cwd", "/custom/agent");
const registry = new ModelRegistry(models);
```
`AuthStorage.create(authPath?: string)` uses `FileAuthStorageBackend` and defaults
to `<agentDir>/auth.json` (`src/core/auth-storage.ts:28-33,171-192`). `AuthStorage`
is not a root export; `src/index.ts:26` exports only `readStoredCredential` from
that module. For a published-wrapper integration, inject a `CredentialStore`
through `ModelRuntime.create({ credentials })` instead.
`ModelRuntime.create` accepts `credentials`, `authPath`, `modelsPath`,
`modelsStore`, and `modelsStorePath`; it loads `models.json` with `ModelConfig`
and defaults the dynamic catalog store to sibling `models-store.json`
(`src/core/model-runtime.ts:58-70,133-142`). `ModelRegistry` is a facade over an
already-created `ModelRuntime`, not a path-based constructor
(`src/core/model-registry.ts:20-29`). `SettingsManager.create` reads global
`<agentDir>/settings.json` and project `<cwd>/.pi/settings.json`
(`src/core/settings-manager.ts:188-197,308-316`).

## 8. Skills and extensions discovery/contracts

Default skill directories are `<agentDir>/skills` and `<cwd>/.pi/skills`; trusted
`.agents/skills` directories are also considered: `~/.agents/skills` plus each
ancestor `<dir>/.agents/skills` from `cwd` to the git root. The latter are added by
the package manager, while `additionalSkillPaths` accepts explicit files/directories
(`src/core/package-manager.ts:441-460,2336-2352,2388-2402,2438-2451`).
Directory traversal treats a directory containing `SKILL.md` as a skill root and
does not recurse below it; otherwise it loads direct `.md` files and recurses into
subdirectories (`src/core/skills.ts:160-170`). `SKILL.md` uses frontmatter with a
required `description`, optional lowercase-hyphen `name` (otherwise the parent
directory name), and optional `disable-model-invocation: boolean`; the body is the
skill instructions. Missing description rejects the skill; invalid names only
produce diagnostics. Refs: `src/core/skills.ts:67-81,88-112,277-324`. Relative
references are resolved against the directory containing `SKILL.md`
(`src/core/skills.ts:342-355`). `.agents/skills` uses the `agents` discovery mode,
so root-level arbitrary `.md` files are not loaded there; use `SKILL.md`
directories (`src/core/package-manager.ts:347-424`).
Default extension directories are `<cwd>/.pi/extensions` then `<agentDir>/extensions`;
explicit paths are also accepted. In each directory, direct `*.ts`/`*.js` files
load; one-level subdirectories load `index.ts`/`index.js`; or a subdirectory's
`package.json` may declare `pi.extensions: string[]`. There is no recursion beyond
one level unless the package manifest declares entry points
(`src/core/extensions/loader.ts:626-668`). The manifest's recognized `pi` fields
are `extensions`, `themes`, `skills`, and `prompts` (`:561-579`); standard-location
discovery and explicit path resolution are at `:670-720`.

## 9. Package metadata

`packages/coding-agent/package.json` publishes:
```json
{
  "name": "@earendil-works/pi-coding-agent",
  "version": "0.82.0",
  "bin": { "pi": "dist/cli.js" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./rpc-entry": { "import": "./dist/rpc-entry.js" }
  }
}
```
Refs: `package.json:1-22`. Runtime dependencies are `@earendil-works/pi-agent-core`,
`@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `@silvia-odwyer/photon-node`,
`chalk`, `cross-spawn`, `diff`, `glob`, `highlight.js`, `hosted-git-info`,
`ignore`, `jiti`, `minimatch`, `proper-lockfile`, `semver`, `typebox`, `undici`,
and `yaml` (`package.json:41-59`). Optional runtime dependency:
`@mariozechner/clipboard` (`:68-70`).

## 10. Embedding gotchas

1. `InteractiveMode` is a terminal application, not a render-into-a-container
   component. It constructs `ProcessTerminal`, starts a `TUI`, uses raw stdin,
   writes stdout/stderr, installs signal and `uncaughtException` handlers, and can
   call `process.exit(...)` during shutdown (`src/modes/interactive/interactive-mode.ts:443-467,3528-3573,3585-3661`).
   Only use it when the wrapper owns a compatible terminal/process boundary.
2. `initTheme()` is mandatory before constructing interactive UI because the
   exported `theme` proxy reads a `globalThis` slot and throws if uninitialized
   (`src/modes/interactive/theme/theme.ts:799-815`). `setKeybindings(...)` is also
   global state (`src/modes/interactive/interactive-mode.ts:463-464`).
3. The interactive constructor calls `KeybindingsManager.create()` and the TUI
   receives `getAgentDir()` without the runtime's `agentDir`
   (`src/modes/interactive/interactive-mode.ts:454-464`). A custom `agentDir` in
   services does not automatically redirect interactive keybindings or every
   theme helper; initialize/register those resources deliberately.
4. Runtime replacement invalidates the old `AgentSession`. Rebind subscriptions
   and extension UI against `runtime.session` after `newSession`, `switchSession`,
   or `fork`; the SDK example makes this explicit (`examples/sdk/13-session-runtime.ts:4-9,38-49,56-67`).
5. `runPrintMode` and `runRpcMode` take over process stdout and stdin semantics;
   RPC reads JSONL from `process.stdin` and writes protocol output to stdout
   (`src/modes/rpc/rpc-mode.ts:1-5,49-60,787-795`). Keep protocol stdout free of
   wrapper logging, and prefer direct `AgentSession` operations for an in-process
   UI.
