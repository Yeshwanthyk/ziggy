# Extensions

A Profile chooses which packages load; a broken package never takes the Profile down with it.

## Behaviors

- EXT-1: `extensions add` of an unknown id is refused; `extensions.json` and `extensions/` are not created.
- EXT-2: `add` of a package that fails to load is refused as preflight; the selection and shelf keep their bytes.
- EXT-3: an added code package's tool is offered in the next run and answers the model.
- EXT-4: the `profile_extensions` tool adds a bundled package in-process with `PATH=""`.
- EXT-5: a selected package that throws at import is skipped with a stderr warning; the turn still
  answers and `doctor` reports `BROKEN Profile packages skipped: <id>`.
- EXT-6: a Profile package with a bundled id wins over the bundled text in the system prompt.
- EXT-7: required packages (`pi-packages`, `ziggy-operations`, `extension-authoring`) load from
  Ziggy's cache under `ZIGGY_HOME`, never the Profile, and the model can `read` their files.
- EXT-8: `extensions update <p> <id>` reports `current`, `updated` (receipt matches older bytes),
  refuses `modified` and `unmanaged` (`--adopt` then reports `adopted`), and refuses while a
  resident runs.
- EXT-9: a copy left only at `<id>.old` by an interrupted swap is restored on the next open.

## Entry points

`ziggy extensions add|remove|update|list|show`; the model calling `profile_extensions`; `ziggy doctor`.

## Drive

Write fixture packages under `<profile>/extensions/<id>/` (`package.json` with `description`,
`keywords: ["pi-package"]`, `pi.extensions` or `pi.skills`), then `add` and `run`.

## Proof

`extensions.json` bytes, `treeHash` of the shelf, `server.toolResults`, `server.raw` for the prompt,
exit codes and stderr.

## Gotchas

- Package manifests need a `description`; without one `add` fails before preflight.
- A refused mutation may create `.runtime/profile-extensions.sqlite` (the lock); that is Ziggy's
  runtime state, not a Profile change.
- The update receipt lives at `.runtime/extension-updates/<id>/receipt.json`; rewrite its
  `contentHash` with `hashTree` to simulate an older bundled build.
