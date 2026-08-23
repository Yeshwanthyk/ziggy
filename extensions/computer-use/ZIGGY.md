# Ziggy packaging notes

This directory vendors the published npm artifact
`@injaneity/pi-computer-use@0.5.0` (integrity
`sha512-5uJ6TWnSkWBwRRGWGF1nMvyARlkJEDZsRkMmzTBOGQUNjulWMDztAv99OTdtWIGbSncRpYQQ15VGeFC/vq8hJQ==`,
shasum `c203ae99ee6beac8a681848ec31f92ddf97aeddb`) so Ziggy can copy a complete,
offline runtime package onto a Profile shelf.

Upstream: <https://github.com/injaneity/pi-computer-use>

Ziggy changes only the package integration surface:

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

This package exposes upstream's eleven public Pi tools unchanged and adds one Ziggy-owned
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
should be selected with `rootQuery`. In contrast, `launch_browser` starts a managed CDP browser
with a fresh temporary profile, so workflows must not assume it contains the user's normal login.

This is a pinned Ziggy integration contract over `@injaneity/pi-computer-use@0.5.0`, not an
upstream public API. An upstream-supported segment contract would reduce future upgrade work.
