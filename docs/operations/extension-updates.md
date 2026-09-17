# Updating bundled extensions

Bundled extension code ships inside the Ziggy executable. An installed Profile copy takes
precedence over that bundle, so updating the executable does not replace installed packages.

Update one installed bundled package from the executable you are running:

```sh
ziggy extensions update squarey computer-workflows
```

Close all sessions using the Profile and stop its resident before updating. This first version
does not drain active work, schedule an update, download another executable, or restart Squarey.
Runtimes with update fencing block package replacement while open. Older Ziggy processes do not
participate in that fence: close old TUI/run/ACP sessions before the initial upgrade as well.

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
- Restart the Profile after a successful update to load the new tool code and skill instructions
  together.

A successful update verifies package installation and loading. It does not prove that a saved
workflow completes on a live website.
