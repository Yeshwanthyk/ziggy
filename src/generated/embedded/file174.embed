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

Ziggy stages and validates the new package first, then stops the resident, applies the update
under the update lock, and starts the resident again. Without `--restart` the update is refused
while the resident runs. If a step fails, either the old or the new version stays applied, and
the command reports whether the resident is running or recovery is needed. The updater does not
drain active work, schedule an update, or download another executable. Older Ziggy processes do
not participate in the update fence: close old web, run, ACP, wake, and specialist sessions and
stop older residents before the initial upgrade.

## Adopt an existing installation

Installations without an update receipt are treated as untracked. To explicitly replace an
untracked package with the executable's bundled copy and begin tracking it:

```sh
ziggy extensions update squarey computer-workflows --adopt
```

Adoption is a takeover of that package directory, not proof that its previous contents came
from Ziggy. Inspect local changes first. The updater retains the previous package as a backup.
Once a receipt exists, modified package contents block updates; `--adopt` does not override
that protection.

## Boundaries

- Only an explicitly named, already installed bundled extension is updated.
- Package content hashes detect changes even when the package version is unchanged.
- The selected extension set, browser profiles, saved workflows, and human-owned Profile
  documents are not replaced.
- Updates that change extension-owned automation definitions are rejected in this version.
- A recovery journal protects interrupted replacement. An unresolved update blocks runtime
  loading until recovery succeeds. Rerun the update command for that package to recover it;
  if recovery detects changed files, it preserves them and reports the conflict.
- The new tool code and skill instructions load together when the resident restarts; `--restart`
  does this for you.

A successful update verifies package installation and loading. It does not prove that a saved
workflow completes on a live website.

## In-process lifecycle

The `profile_extensions` tool manages `list`, `add`, `remove`, and `validate` inside the resident
without Bash, a Ziggy subprocess, or `PATH` lookup. Extensions that invoke ordinary external
commands still use the managed service `PATH` documented in [Supervise `ziggy serve`](serve.md).
