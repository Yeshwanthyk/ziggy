# Skills catalog

## What shipped

Ziggy uses the live sibling `../merlin` checkout as its catalog.

- Discover `extensions/*/skills/*/SKILL.md`, then `skills/*/SKILL.md`.
- Extension-owned skills win ID collisions.
- The current Merlin tree has 65 payloads and 61 unique skill IDs.
- `ziggy skills list <profile>` shows installed and available skills.
- `ziggy skills add <profile> <id|path> [--force]` copies the complete skill directory.
- Replacement is staged; an existing Profile skill is preserved unless `--force` is explicit.
- Pi still loads skills only from `<profile>/skills`.

The dump Profile at
`/Users/yesh/Documents/personal/dump/ziggy-vertical-slices/pal` has `humanizer` installed. The
installed tree matches Merlin byte-for-byte, and the real Pi TUI loaded it.

## Boundary we are keeping

The TUI has Pi's default tools and can execute command-driving skills. `run`, channel gateways,
and automation wake remain memory-only. Do not widen headless tool access as part of catalog work.

## Next

No catalog code slice is needed now.

Reopen this plan only when Ziggy must run without a sibling Merlin checkout. That slice should:

1. Package a pinned snapshot of the same 61 skill directories.
2. Preserve complete directories, collision precedence, and Profile-local installs.
3. Add update semantics only if installed skills need to track bundled changes.

Do not add a registry, marketplace, remote fetcher, or extension host before that requirement
exists.

## Proof

```sh
bun test src/application/profiles.test.ts
bun run check
bun src/main.ts skills list /Users/yesh/Documents/personal/dump/ziggy-vertical-slices/pal
```
