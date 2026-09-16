# Browser login and background workflows

## Selected first slice

The user selected adapting the existing MIT `pi-computer-use` integration on September 16,
after reviewing the alternatives. This supersedes the direct-Playwright implementation
recommendation below. Keep the existing browser/CDP observation and action engine. First add
named persistent profiles, visible/background launch, and orderly close; prove local login
persistence and authenticated reads through the existing tools before extending workflows.

The separate, unfinished Playwright prototype was moved out of Ziggy's source tree to
`/Users/yesh/code/personal/dump/browser-workflows-playwright-prototype`. It is not selected
in the test Profile. The comparison below remains historical research, not the implementation
decision.

The selected slice is now implemented in `extensions/computer-use` and installed in the isolated
`dump/browser-workflows` Profile. The focused suite passes 42 tests. A separate public-Pi-loader
proof against the installed copy passed headed semantic login, persistent cookie/local-storage
background access, competing-process rejection, profile isolation, and restoration in a fresh
runtime. Its script and eight-check result are in the Profile's `verification/` directory.
LinkedIn login, an authenticated Luna turn, and saved workflow execution are not proven by this
fixture. The Profile is set to Luna Max but still requires its own OpenAI OAuth login.

Research date: 2026-09-16. This is a design recommendation, not an implemented browser feature.
The existing extensions are replaceable; preserving their names, APIs, or driver is not a requirement.

Recommendation: replace the overlapping browser paths with one Playwright-backed browser
capability, explicit account login and attention controls, and direct workflow execution. Keep
native desktop control separate.

## Upstream snapshots

| Project  | Main inspected today                                                                                       | Latest release observed                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw | [`a58755e9`](https://github.com/openclaw/openclaw/commit/a58755e9ac9f8601684a692491e65b710485fe4c)         | [`v2026.9.4`](https://github.com/openclaw/openclaw/releases/tag/v2026.9.4), published September 11; commit `3a9d69db306cd7f081e06254cb89c4bcc14a7107`   |
| Hermes   | [`948e9706`](https://github.com/NousResearch/hermes-agent/commit/948e9706618220839a20c33c2fc5c19de074d835) | [`v2026.9.14`](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.14), version 0.21.3; commit `345cd2b057a452236de401d3534b8502a7465e8d` |

Three Luna scouts at high reasoning inspected OpenClaw, Hermes, and Ziggy independently. The
OpenClaw scout began at `9c2fe2698ba417ed565ff4c581a38dc4a8837284`; main advanced by three commits
during research. The GitHub comparison showed no changes to the cited browser/CUA files between
that revision and `a58755e9`. Main behavior is not automatically release behavior. The installed
Hermes CLI is older: 0.20.0 (2026.8.3), local commit `36cb5ae5530a75def7df3195e49b7a4aa2add482`.

## What to borrow from OpenClaw and Hermes

### OpenClaw: browser profiles and lifecycle ownership

OpenClaw distinguishes a dedicated managed browser (`openclaw`), an existing signed-in Chrome
session attached through Chrome MCP (`user`), and an extension relay (`chrome`). Manual login into
the managed profile is documented; the Chrome MCP route can require a human attach prompt. The
extension route operates existing live tabs, but sharing those tabs still requires coordinating
human and agent actions.
[Profile modes](https://github.com/openclaw/openclaw/blob/a58755e9ac9f8601684a692491e65b710485fe4c/docs/tools/browser/profiles.md#L10-L25),
[manual login](https://github.com/openclaw/openclaw/blob/a58755e9ac9f8601684a692491e65b710485fe4c/docs/tools/browser-login.md#L9-L51)

Managed profiles have persistent user-data directories and profile locks. Headless is a launch
choice, with a one-shot CLI override. It is not a seamless conversion of a running headed process.
The control UI distinguishes stopped historical tabs from a newly started browser.
[Launcher](https://github.com/openclaw/openclaw/blob/a58755e9ac9f8601684a692491e65b710485fe4c/extensions/browser/src/browser/chrome.ts#L754-L813),
[headless options](https://github.com/openclaw/openclaw/blob/a58755e9ac9f8601684a692491e65b710485fe4c/docs/tools/browser/configuration.md#L225-L265),
[stopped tabs](https://github.com/openclaw/openclaw/blob/a58755e9ac9f8601684a692491e65b710485fe4c/docs/tools/browser/profiles.md#L57-L65)

The strongest implementation idea is a per-profile lifecycle owner. Start/stop/reset transitions
invalidate and drain operation leases; cleanup checks browser and target identity instead of
trusting stale handles. Ziggy needs the invariant, not necessarily OpenClaw's actor and SQLite
implementation. A simpler exclusive run lease is sufficient for the initial slice.
[Lifecycle owner](https://github.com/openclaw/openclaw/blob/a58755e9ac9f8601684a692491e65b710485fe4c/extensions/browser/src/browser/server-context.lifecycle.ts#L274-L334),
[tab ownership](https://github.com/openclaw/openclaw/blob/a58755e9ac9f8601684a692491e65b710485fe4c/docs/tools/browser/configuration.md#L77-L116)

OpenClaw's CUA adapter is separate from its browser tool. Its `browser_prepare` supports an isolated
profile and explicitly does not attach to an existing profile/CDP session. It is not a drop-in
solution for sharing Ziggy's browser login with a desktop driver.
[CUA boundary](https://github.com/openclaw/openclaw/blob/a58755e9ac9f8601684a692491e65b710485fe4c/docs/nodes/computer-use.md#L112-L122)

### Hermes: browser-specific tools, account reuse, and native fallback

Hermes has multiple browser backends, including local Chromium through `agent-browser`, CDP
attachment, Browser Use, and cloud providers. Its optional real-profile path snapshots a Chromium
profile, launches the real browser binary against that copy, and attaches its browser engine.
It defaults to new headless mode and can launch headed. Reusing the original executable is part of
its handling of OS-encrypted browser data.
[Browser guide](https://github.com/NousResearch/hermes-agent/blob/948e9706618220839a20c33c2fc5c19de074d835/website/docs/user-guide/features/browser.md),
[profile implementation](https://github.com/NousResearch/hermes-agent/blob/948e9706618220839a20c33c2fc5c19de074d835/tools/browser_tool_real_profile.py#L136-L208)

Hermes also offers origin-bound vault filling outside the model-visible text path. This is useful
as a later credential capability; it is not required for the initial manual-login flow. Its current
main browser guide adds scheduled/unattended-run guidance absent from the release guide, while the
scout's inspected profile/lifecycle implementation files were unchanged between those snapshots.
[Vault tools](https://github.com/NousResearch/hermes-agent/blob/948e9706618220839a20c33c2fc5c19de074d835/tools/browser_vault_tool.py),
[release guide](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/website/docs/user-guide/features/browser.md)

Hermes keeps native `computer_use` on `cua-driver` separate from browser page automation. Its CLI
exposes install/status/doctor/permissions for that driver. Headed browser intervention and Camofox
VNC/noVNC are supported shapes, but the scout did not establish a first-class coordinated
human-takeover lease or resumable handoff API.
[Computer-use guide](https://github.com/NousResearch/hermes-agent/blob/948e9706618220839a20c33c2fc5c19de074d835/website/docs/user-guide/features/computer-use.md),
[Camofox provider](https://github.com/NousResearch/hermes-agent/blob/948e9706618220839a20c33c2fc5c19de074d835/plugins/browser/camofox/provider.py)

For Ziggy, borrow the separation of browser and native controls, named account identity, useful
health checks, and explicit lifecycle. Prefer a dedicated account browser that the user signs into
over automatically copying a personal browser profile. Neither upstream establishes that one
native desktop driver alone supplies persistent login, hidden browser execution, and coordinated
human takeover. Adopting a whole agent stack would add unrelated orchestration; Playwright supplies
the needed browser engine beneath Ziggy's existing runtime.

## Recommended direction

Build one browser capability around named, persistent browser profiles, with direct browser automation
and an explicit human handoff. Keep native desktop control separate. Workflow execution should call
the browser capability directly, using the same account, page ownership, and action implementation
as interactive agent work.

For the first slice, assume execution on this Mac without taking over its desktop. A remote host
remains a deployment option, but transparent copying of authenticated browser data between machines
is not part of the proposal.

The user-facing flow is:

1. Add a browser account, such as “Work”. Open its dedicated browser window and sign in normally.
2. Choose “Use in background”. Ziggy closes that managed instance cleanly, reopens the same
   persistent browser directory headless, and checks the expected signed-in page.
3. Run a task against “Work”. Interactive tasks and saved workflows use that same browser owner.
4. If login expires or the task needs human input, show “Needs attention” and an “Open browser”
   action. Pause agent mutations during human control; verify the page again before continuing.

“Same profile” means persistent browser data, not an identical live page after a restart. Relaunch
invalidates page handles and in-memory UI state. Resume from a verified checkpoint or report that
the task needs restarting. Never silently repeat a submission with an unknown outcome.

## Candidate shapes

| Shape                                           | Login and background work                                                               | Main tradeoff                                                       | Decision                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Connect the three existing extensions           | Reuse the CLI's persistent browser and add a bridge to the desktop/workflow driver      | Multiple lifetime and state owners; substantial glue still required | Do not make this the target architecture                                     |
| One managed browser capability using Playwright | Dedicated visible login, persistent headless execution, direct semantic browser actions | Requires a small browser owner and honest restart/handoff behavior  | Recommended first implementation                                             |
| Isolated desktop with a live viewer             | Human and agent operate the same running environment; supports native apps too          | More deployment, streaming, permissions, and resource management    | Consider when remote hosting or native desktop workflows become requirements |

An embedded live browser viewer is a possible later alternative to relaunching for attention. It
would retain the running page while routing user input directly to the browser. It is additional
product work, and login mechanisms that require native browser or operating-system UI still need
separate verification.

Use Playwright's supported persistent-context API rather than building a new CDP action engine.
Its `userDataDir` stores browser session data, and one directory cannot be opened by multiple browser
instances simultaneously. Use a dedicated automation directory rather than the user's ordinary
Chrome data directory. CDP attachment is useful for an externally owned browser, but need not be the
default connection for a browser Ziggy launches itself.
[Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)

## What is missing in Ziggy today

The current components do not form the requested account lifecycle:

- `dev-browser` has persistent named contexts, but its Ziggy tool only exposes a boolean local
  auto-connect option. The managed daemon does not return a CDP endpoint that `computer-use` can
  acquire by browser name. The two extensions therefore do not share a browser identity.
  [Adapter schema](../../extensions/dev-browser/index.ts#L18),
  [adapter invocation](../../extensions/dev-browser/index.ts#L232)
- `computer-use` launches Chromium with a new port-derived `/tmp/pi-…` user-data directory and no
  headless launch flag. Its `headless` configuration is desktop-input policy, not a switch that
  makes the launched Chromium headless. It also uses one process-global CDP port instead of a
  named browser-session contract.
  [Managed launch](../../extensions/computer-use/dist/src/bridge.mts#L2186),
  [CDP configuration](../../extensions/computer-use/dist/src/cdp.mts#L316)
- The semantic driver already supports CDP `browser_page` roots. This is useful implementation
  evidence, but does not supply persistence, login UI, or browser lifecycle ownership.
  [Browser roots](../../extensions/computer-use/dist/src/bridge.mts#L1311),
  [segment execution](../../extensions/computer-use/segment.ts#L250)
- `computer-workflows` does not record `dev_browser`, persist a browser account identity, or
  execute plans itself. Browser launch/navigation and every text-entry step remain manual in its
  compiler. That is too limited to be the foundation for unattended browser workflows without a
  redesign.
  [Recorder tool set](../../extensions/computer-workflows/src/recorder.ts#L14),
  [compiler](../../extensions/computer-workflows/src/execution-plan.ts#L121),
  [agent-mediated execution](../../extensions/computer-workflows/index.ts#L319)

These are source findings. No claim is made that a currently running Ziggy Profile has any of the
three optional extensions selected or correctly installed.

## Ownership and contracts

The browser owner should be scoped by Ziggy Profile and browser name. It owns the private durable
browser directory, process, mode, pages, and an exclusive operation lease. Credentials remain browser
data; workflow definitions refer to a browser name and ordinary input variables.

The resident Profile process is the natural owner for scheduled runs and web controls. CLI and UI
call that owner; they must not independently start competing Chromium processes on the same
directory. A directly launched runtime must either acquire the same cross-process ownership lock
or report that the resident owner already holds it.

Keep the public operations small: open for human use, run a browser task, inspect status, stop.
Workflow execution calls the same typed actions internally. A task scope owns its pages and cleans
up only those pages; stopping a task must not delete authentication or terminate unrelated browser
profiles. Start with one exclusive run per browser profile; different profiles may run concurrently.

Separate process state from authentication observations. A running browser is not proof of login.
Authentication checks are per origin/task, can expire, and must be repeated before consequential
actions. Useful visible states are stopped, opening, ready, running, needs attention, and failed.

Workflows should persist browser identity, page-selection intent, semantic locators, ordinary
inputs, checkpoints, and completion evidence. They should support normal form filling. Keep useful
existing safeguards—fresh target resolution, ambiguity rejection, checkpoint verification, redaction,
and explicit unknown outcomes—without inheriting the current restriction that every text field is
manual. Browser passwords and MFA are entered through the human browser surface, not captured as
workflow recordings.

Dependency direction stays consistent with Ziggy: faces call application capabilities; the browser
adapter owns Playwright and browser handles. Pi extensions expose agent tools over the capability.
Workflow code owns recipe and run semantics, not browser process lifetime. This adds no agent loop
or parallel scheduler; use Ziggy's existing resident owner and automation execution.
[Ziggy specification](minimal-ziggy-scout.md)

## First implementation and proof

Build a single end-to-end account flow before adding a general recorder or replacing every desktop
tool: create a named browser, log in visibly, close and relaunch headless, then perform one authenticated
read with the same account. Include status and reopen-for-attention in this slice.

The acceptance checks should establish:

- A cookie and application-local-storage login survive a real headed-to-headless relaunch.
- A second runtime cannot open or mutate the same browser profile while the first owns it.
- Another named browser starts unauthenticated and cannot see the first browser's state.
- Authentication expiry stops a task before a mutation and permits human reauthentication.
- Background execution does not move the desktop pointer or activate a native application.
- A cancelled or crashed run does not falsely report completion or replay an uncertain submission.
- Browser data survives a Ziggy restart; stale process/page handles do not.

Use an isolated local test website for deterministic checks, then one explicitly selected real
site to verify its actual login behavior. Persistent state is not a guarantee that every site's
authentication survives a restart or headless execution.

After that proof, add a browser workflow with ordinary form fields and checkpoints, then the UI
account list and attention flow. Retire the old extensions only after their needed capabilities have
replacement proof. Preserve existing workflow documents and browser data; do not automatically
reinterpret recipes or copy credential stores to the new implementation.

## Verification performed in this research

- Ran `hermes --help`, `hermes computer-use --help`, and `hermes --version`.
- Ran `bunx --yes opensrc@0.7.3 --help`, its `fetch`/`path` help, and source-path lookup for both repos.
  The bare `opensrc` command was absent from PATH. Cached branch paths are not proof of latest source.
- Ran installed `dev-browser --help` and inspected its installed package and browser launch code.
  Installed version is 0.2.7; Ziggy's adapter README targets 0.2.9.
- Ran `bun test ./extensions/dev-browser/test ./extensions/computer-use/test ./extensions/computer-workflows/test`:
  41 passed, zero failed. These establish the existing tested contracts, not real authenticated
  browser execution or the proposed design.
- No personal browser state was inspected, no account login was attempted, and no production
  implementation or installed tool was changed.

## Follow-up: Codex desktop and Pi reuse

The follow-up investigation on September 16 distinguishes reusable code from host-owned features.
Codex documents [Computer Use](https://learn.chatgpt.com/docs/computer-use), a separate
[Browser](https://learn.chatgpt.com/docs/browser), and macOS
[Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay). Record & Replay observes
a human demonstration and drafts a reusable skill. These product features do not establish a
public event-recorder API for another application. The installed OpenAI computer-use and browser
plugin manifests identify their license as Proprietary; their app-bundled CUA runtime is not a
portable dependency for Ziggy.

Ziggy already vendors the MIT-licensed `@injaneity/pi-computer-use@0.5.0`. Its semantic resolution
and verified checkpoints remain useful for native desktop work. Its temporary browser launcher
does not supply the persistent account lifecycle. The existing workflow recorder observes Pi
tool calls and results; it does not observe a human's mouse or keyboard activity.

The implementation direction is a separate optional `browser-workflows` Pi package: one named
persistent browser owner, direct browser actions, saved recipes, and direct execution. Recording
first means successful actions through that package's tools. The follow-up implementation also
targets an explicitly enabled human demonstration recorder inside the managed browser: observed
clicks and field changes become an untrusted draft, field contents become input placeholders,
and the user reviews the recipe before replay. This does not require MCP or a desktop-wide
recorder. Manual login stays outside recording. Unsupported interactions must remain visible
in the draft rather than silently producing an incomplete runnable recipe.

Both OpenClaw and Hermes permit adaptation under their MIT licenses, retaining the required
notices. OpenClaw is the closer source candidate: its
[browser package](https://github.com/openclaw/openclaw/tree/main/extensions/browser) separates
profile management, Chrome launch, and control-service lifetime. It also imports OpenClaw's
configuration, plugin SDK, gateway, and policy layers, so copying the package would import
considerable unrelated infrastructure. Hermes' Python
[browser provider contract](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/browser-provider-plugin.md)
offers useful create/close/cleanup and session-metadata concepts, but its runtime is not a
drop-in TypeScript dependency. The chosen slice implements those ownership concepts over
Playwright inside Ziggy's existing extension boundary. No upstream source has been copied by
this follow-up; any later extraction must pin its source and retain license notices.

For a job monitor, save page selection, a signed-in checkpoint, extraction selectors, and stable
job IDs. Read every selected page successfully before advancing the previously seen IDs. The
first successful run establishes a baseline; later runs report new IDs. Authentication failures,
partial pagination, cancellation, and busy profiles must preserve the prior baseline. Scheduling
continues to use Ziggy's existing automations and resident runtime.
