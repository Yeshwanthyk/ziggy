# Profiles

`ziggy init` creates a Profile without touching human-owned files; `ziggy profiles` only reads.

## Behaviors

- PROF-1: `init` on an existing Profile leaves `SOUL.md` byte-identical.
- PROF-2 (red): `profiles` changes nothing under the scratch `HOME`, even when `profiles.list` holds a
  stale entry. Today it prunes the registry.

## Entry points

`ziggy init <path>`, `ziggy profiles`.

## Drive

`treeHash(profile.home)` before and after the command.

## Proof

Equal tree hashes; `SOUL.md` content equal to what was written.

## Gotchas

- Without a stale entry nothing is pruned, so PROF-2 passes vacuously. The proof plants one.
