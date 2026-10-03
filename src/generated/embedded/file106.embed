# Ziggy packaging notes

This directory vendors the published npm artifact
`@injaneity/pi-computer-use@0.5.0` (integrity
`sha512-5uJ6TWnSkWBwRRGWGF1nMvyARlkJEDZsRkMmzTBOGQUNjulWMDztAv99OTdtWIGbSncRpYQQ15VGeFC/vq8hJQ==`,
shasum `c203ae99ee6beac8a681848ec31f92ddf97aeddb`) so Ziggy can copy a complete,
offline runtime package onto a Profile shelf.

Upstream: <https://github.com/injaneity/pi-computer-use>

Ziggy retains the upstream runtime and applies the integration changes below, plus the
managed-browser lifecycle patch described later in this document:

- the package name is `@ziggy/computer-use`;
- Pi's extension path names a small Ziggy-owned `./index.ts` adapter. The adapter dynamically
  loads the concrete `./dist/extensions/computer-use.mjs` runtime so Ziggy's root compiler does
  not substitute adjacent upstream `.mts` sources and apply repository-only compiler policy;
- peer versions are pinned to Ziggy's Pi and TypeBox versions;
- package-local checks replace upstream development scripts that are not part
  of the published npm artifact.

Upstream TypeScript is retained as `.mts` under `dist/` and emitted as adjacent
`.mjs` files. This keeps the Profile runtime dependency-free while isolating upstream's
compiler policy from Ziggy-owned TypeScript's stricter optional-property rules.
The three platform helpers and the setup script resolve the package root across
that added `dist/` boundary; their runtime behavior is otherwise unchanged.
The setup script also restores the macOS helper executable bit before signature
verification because Ziggy's embedded-file materializer does not retain source
file modes. Linux and Windows already restore the destination mode through
upstream's `copyIfChanged` path.

The upstream `LICENSE` is retained unchanged. Runtime source, compiled modules,
native source fallbacks, setup scripts, and published prebuilt helpers are retained because
helper setup resolves those resources relative to this package. In particular,
the signed universal macOS helper must not be rebuilt or modified during Ziggy
packaging.

## Workflow execution boundary

This package retains upstream's eleven public Pi tool names and adds one Ziggy-owned
`run_ui_segment` tool at the same driver boundary. The segment tool calls the pinned runtime's
exported bridge executors inside this package; it does not invoke another Pi extension.

`run_ui_segment` resolves fresh semantic state before every target, requires exactly one match,
and requires a verified postcondition for every action group. It stops on ambiguity, cancellation,
unknown or stale state, driver failure, and uncertain outcomes. Its allowlist is intentionally
limited to semantic click, keypress, and scroll actions. It accepts no coordinates, arbitrary
JavaScript, text-entry values, or secrets.

Durable workflows should use `rootQuery` with one or more safe semantic fields: `text`, `app`,
`bundleId`, or `kind`. The driver runs `find_roots` again before every step and proceeds only when
the query returns exactly one current `@r` window ref. The optional exact `root` remains available
for ad hoc, same-session calls; saved workflows must not persist its transient value.

Read-only `{ assert: Condition }` steps support acceptance preconditions and checks without a
target search or action. They freshly resolve and observe the root, then require `wait_for` to
prove the condition. This is useful for browser authentication checks before any mutation.

An already-running native browser window can preserve the user's existing logged-in profile and
should be selected with `rootQuery`. `launch_browser` without a profile retains upstream's
temporary-profile behavior. The named-profile extension below provides dedicated persistent
browser data; it never imports the user's ordinary browser profile.

This is a pinned Ziggy integration contract over `@injaneity/pi-computer-use@0.5.0`, not an
upstream public API. An upstream-supported segment contract would reduce future upgrade work.

## Named browser profiles

The first browser lifecycle slice extends the existing launcher and CDP engine rather than
introducing another driver. `launch_browser` accepts an optional safe `profile` name and
`mode: "headed" | "background"`. `background` launches Chromium with `--headless=new`; it is
separate from upstream's `headless` setting, which controls native input policy.

Named browser data belongs to the Pi context's Profile directory:
`.runtime/computer-use/browsers/<name>`. A named browser is owned exclusively across processes.
The runtime still owns only one active managed browser at a time. `close_browser` waits for its
process to exit before releasing ownership, preserving browser data for the next launch.
An unclean crash can leave an ownership lock. The fork refuses to steal that lock; recovery
requires confirming that the browser using that profile has stopped before removing the stale
lock. Browser lock files inside Chromium's data directory must not be removed by the launcher.

The intended flow is:

1. Launch `work` headed at the login page and let the user sign in.
2. Close the managed browser, then launch `work` in background mode at the desired page.
3. Verify authentication using the existing observation/check tools before proceeding.
4. If authentication expires, close and reopen headed for the user to sign in again.

A relaunch creates new page handles and observations; resolve fresh state afterward. Merely
launching a browser does not establish that it is authenticated. Cookies and local storage stay
in the browser directory and are not copied into workflow definitions.

The companion `computer-workflows` package owns saved recipes and job history. This package owns
the browser and grants an exclusive lease for each background workflow run. A run refuses to
replace an open managed browser, and interactive browser calls cannot interfere with its lease.
The packages communicate through Pi's shared event bus so both use the same driver instance.

This package preserves the signed native helper and upstream license. Modified vendored
TypeScript sources and their adjacent runtime JavaScript must be kept in sync.

Browser-only CDP launches, explicit browser-root discovery/observation, and operations on browser
states do not initialize the native desktop helper. Native-app operations still use upstream's
permission checks. A browser search with no matches stays on the CDP path rather than attempting
desktop OCR.
