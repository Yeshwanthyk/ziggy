# Updating bundled extensions

Bundled extension code ships inside the Ziggy executable. An installed Profile copy takes
precedence over that bundle, so updating the executable does not replace installed packages.

Update one installed bundled package from the executable you are running:

```sh
ziggy extensions update squarey computer-workflows
```

If a managed resident (`ziggy serve install`) is running, add `--restart`:

```sh
ziggy extensions update squarey computer-workflows --restart
```

With `--restart`, Ziggy stops the resident, applies the update under the Profile's extension
lock, and starts the resident again. Without `--restart` the update is refused while the resident
runs. The update stages the new package and checks it through Pi before swapping it in; if a step
fails, either the old or the new version stays applied. The updater does not drain active work,
schedule an update, or download another executable. Close web, run, ACP, wake, and specialist
sessions from older Ziggy builds before the first update.

## Adopt an existing installation

Installations without an update receipt are treated as untracked. To explicitly replace an
untracked package with the executable's bundled copy and begin tracking it:

```sh
ziggy extensions update squarey computer-workflows --adopt
```

Adoption is a takeover of that package directory, not proof that its previous contents came
from Ziggy. Inspect local changes first; the previous copy is not kept after a successful update.
Once a receipt exists, modified package contents block updates; `--adopt` does not override
that protection.

## Boundaries

- Only an explicitly named, already installed optional bundled extension is updated. Required
  packages are read from Ziggy's own cache and update with Ziggy itself.
- Package content hashes detect changes even when the package version is unchanged.
- The selected extension set, browser profiles, saved workflows, and human-owned Profile
  documents are not replaced.
- Updates that change extension-owned automation definitions are rejected in this version.
- The swap is two renames through `<id>.old`. If it stops between them, the next session open (for
  a selected package), `add`, or `update` restores `<id>.old` under the extension lock, so the
  Profile runs the previous version until you rerun the update. `doctor` only reports it.
- If the update publishes but cannot record its receipt, it warns; the next `update` sees the
  bytes already match this build and records the receipt.
- The new tool code and skill instructions load together when the resident restarts; `--restart`
  does this for you.

A successful update verifies package installation and loading. It does not prove that a saved
workflow completes on a live website.

## In-process lifecycle

The `profile_extensions` tool manages `list`, `add`, `remove`, and `validate` inside the resident
without Bash, a Ziggy subprocess, or `PATH` lookup. Extensions that invoke ordinary external
commands still use the managed service `PATH` documented in [Supervise `ziggy serve`](serve.md).
